import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Client } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses } from '../db/schema'
import { env } from '../config/env'
import { log } from '../services/logger'
import { runTicketToolCommand, type TicketToolAction } from '../services/ticketToolControl'
import { reconcileBusinessTicketTool, reprocessTicketToolEmbeds } from '../services/ticketToolIngest'

// P13 (lantern) — tiny internal HTTP server. Exposes POST /api/internal/dm so
// the web's notification dispatcher can send a Discord DM through the bot
// (the bot holds the gateway connection). Authed by the shared INTERNAL_TOKEN.
// Bound on INTERNAL_PORT — keep it on the private docker network, never
// publish it to the host.
// The internal endpoints authenticate with INTERNAL_TOKEN if set, otherwise
// they fall back to the bot token (which both services already share) — so
// notifications/DM work with no extra config out of the box.
function internalSecret(): string {
  return env.INTERNAL_TOKEN ?? env.DISCORD_BOT_TOKEN
}

// Constant-time comparison of the presented token against the shared secret.
// A plain `!==` leaks how many leading bytes matched via response timing — a
// timing oracle on a secret that may be the Discord bot token (see the
// INTERNAL_TOKEN fallback above). Reject non-string / length-mismatched
// headers before the compare so timingSafeEqual never throws.
function tokenMatches(presented: string | string[] | undefined, secret: string): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function startInternalHttp(client: Client): void {
  const secret = internalSecret()

  // F1 (security review): when INTERNAL_TOKEN is unset the Discord bot token —
  // the single most sensitive credential — doubles as the internal HTTP shared
  // secret and is sent on the wire to WEB_BASE_URL by notifyBridge. That works
  // out of the box but reuses the bot token as an auth secret. Warn loudly so
  // operators set a dedicated INTERNAL_TOKEN (the same value on the web side).
  if (!env.INTERNAL_TOKEN) {
    log.warn(
      'INTERNAL_TOKEN is not set — internal endpoints and the notify bridge are ' +
        'authenticating with the Discord bot token as a fallback. Set a dedicated ' +
        'INTERNAL_TOKEN (matching the web app) to avoid reusing the bot token as an HTTP secret.',
    )
  }

  const ROUTES = new Set([
    '/api/internal/dm',
    '/api/internal/tickettool/command',
    '/api/internal/tickettool/reconcile',
    '/api/internal/tickettool/reprocess-embeds',
    '/api/internal/guild/leave',
    '/api/internal/bot/username',
  ])

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url || !ROUTES.has(req.url)) {
      res.writeHead(404).end()
      return
    }
    if (!tokenMatches(req.headers['x-internal-token'], secret)) {
      res.writeHead(401).end()
      return
    }
    const url = req.url
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 16_000) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
          if (url === '/api/internal/dm') {
            const { discordUserId, content } = JSON.parse(raw) as { discordUserId?: string; content?: string }
            if (!discordUserId || !content) {
              res.writeHead(400).end()
              return
            }
            const user = await client.users.fetch(discordUserId).catch(() => null)
            if (user) {
              await user.send({ content: content.slice(0, 2000) }).catch(() => {})
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
            return
          }

          // POST /api/internal/tickettool/reconcile — the web asks the bot to
          // back-grab already-open TicketTool tickets right after an admin links
          // / changes a team's watched categories (instead of waiting for the
          // next restart). Body: { businessId }.
          if (url === '/api/internal/tickettool/reconcile') {
            const { businessId } = JSON.parse(raw) as { businessId?: string }
            if (!businessId) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"businessId required"}')
              return
            }
            // Read the business fresh (not the 60s cache) so just-saved
            // categories are visible.
            const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
            if (!biz) {
              res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"business not found"}')
              return
            }
            const count = await reconcileBusinessTicketTool(client, biz)
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, count }))
            return
          }

          // POST /api/internal/tickettool/reprocess-embeds — one-off maintenance:
          // re-pull embed content for already-ingested TicketTool tickets (the
          // welcome cards / log embeds that landed as "(no text)" before v0.5.28).
          // Body: { businessId? }.
          if (url === '/api/internal/tickettool/reprocess-embeds') {
            const { businessId } = JSON.parse(raw || '{}') as { businessId?: string }
            const out = await reprocessTicketToolEmbeds(client, { businessId })
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...out }))
            return
          }

          // POST /api/internal/guild/leave — a bot owner (sudo) on the web asks
          // the bot to leave a guild. Body: { guildId }. The team's DB rows are
          // left intact; this only severs the bot's Discord membership.
          if (url === '/api/internal/guild/leave') {
            const { guildId } = JSON.parse(raw) as { guildId?: string }
            if (!guildId) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"guildId required"}')
              return
            }
            const guild = client.guilds.cache.get(guildId)
            if (!guild) {
              res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"bot is not in that guild"}')
              return
            }
            await guild.leave()
            log.info('left guild on sudo request', { guildId, name: guild.name })
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
            return
          }

          // POST /api/internal/bot/username — a bot owner (sudo) sets the bot's
          // global Discord username. Body: { name }. Discord rate-limits username
          // changes hard (≈2/hour); surface its rejection rather than swallowing.
          if (url === '/api/internal/bot/username') {
            const { name } = JSON.parse(raw) as { name?: string }
            const trimmed = (name ?? '').trim()
            if (trimmed.length < 2 || trimmed.length > 32) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"name must be 2-32 characters"}')
              return
            }
            if (!client.user) {
              res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"bot not ready"}')
              return
            }
            try {
              await client.user.setUsername(trimmed)
              log.info('bot username changed on sudo request', { name: trimmed })
              res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
            } catch (err) {
              res
                .writeHead(422, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ ok: false, error: String(err).slice(0, 300) }))
            }
            return
          }

          // POST /api/internal/tickettool/command — the web asks the bot to emit
          // a TicketTool $-command (rename/add/remove/closeRequest) into the
          // ticket's channel, as the bot user.
          const body = JSON.parse(raw) as {
            ticketId?: number
            action?: TicketToolAction
            name?: string
            discordUserId?: string
          }
          if (typeof body.ticketId !== 'number' || !body.action) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"ticketId+action required"}')
            return
          }
          const result = await runTicketToolCommand(client, {
            ticketId: body.ticketId,
            action: body.action,
            name: body.name,
            discordUserId: body.discordUserId,
          })
          if (result.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
          } else {
            res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
          }
        } catch {
          res.writeHead(400).end()
        }
      })()
    })
  })

  server.listen(env.INTERNAL_PORT, () => {
    log.info(`internal HTTP listening on :${env.INTERNAL_PORT}`)
  })
  server.on('error', (err) => log.error('internal HTTP error', { err: String(err) }))
}
