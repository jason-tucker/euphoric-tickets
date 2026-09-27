import { env } from '../config/env'
import { log } from '../services/logger'

// P13 (lantern) — bot → web notify bridge. After a Discord-origin ticket open
// or reply, the bot POSTs to the web's /api/internal/notify (on
// WEB_INTERNAL_URL when set) so the web dispatcher fans out ntfy / DM
// notifications. Best-effort, fire-and-forget.
export function dispatchNotify(payload: {
  event: 'new_ticket' | 'reply'
  businessId: string
  categoryId: string | null
  ticketId: number
  subject: string
  slug: string
  actorUserId?: string | null
}): void {
  // P1c: the dedicated INTERNAL_TOKEN only — never the bot token.
  const secret = env.INTERNAL_TOKEN
  // Server-to-server: prefer the private-network URL so the notify POST stays
  // on the Docker network. WEB_BASE_URL (public) remains the fallback.
  const base = (env.WEB_INTERNAL_URL ?? env.WEB_BASE_URL).replace(/\/+$/, '')
  void (async () => {
    try {
      await fetch(`${base}/api/internal/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': secret },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      log.warn('dispatchNotify failed', { err: String(err) })
    }
  })()
}
