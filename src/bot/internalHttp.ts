import http from 'node:http'
import type { Client } from 'discord.js'
import { env } from '../config/env'
import { log } from '../services/logger'

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

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/internal/dm') {
      res.writeHead(404).end()
      return
    }
    if (req.headers['x-internal-token'] !== secret) {
      res.writeHead(401).end()
      return
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 16_000) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
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
