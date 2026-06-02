import http from 'node:http'
import type { Client } from 'discord.js'
import { env } from '../config/env'
import { log } from '../services/logger'
import { runTicketToolCommand, type TicketToolAction } from '../services/ticketToolControl'

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

export function startInternalHttp(client: Client): void {
  const secret = internalSecret()

  const ROUTES = new Set(['/api/internal/dm', '/api/internal/tickettool/command'])

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url || !ROUTES.has(req.url)) {
      res.writeHead(404).end()
      return
    }
    if (req.headers['x-internal-token'] !== secret) {
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
