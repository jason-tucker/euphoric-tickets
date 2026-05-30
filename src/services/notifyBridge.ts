import { env } from '../config/env'
import { log } from '../services/logger'

// P13 (lantern) — bot → web notify bridge. After a Discord-origin ticket open
// or reply, the bot POSTs to the web's /api/internal/notify so the web
// dispatcher fans out ntfy / DM notifications. Best-effort, fire-and-forget.
export function dispatchNotify(payload: {
  event: 'new_ticket' | 'reply'
  businessId: string
  categoryId: string | null
  ticketId: number
  subject: string
  slug: string
  actorUserId?: string | null
}): void {
  const secret = env.INTERNAL_TOKEN ?? env.DISCORD_BOT_TOKEN
  void (async () => {
    try {
      await fetch(`${env.WEB_BASE_URL}/api/internal/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': secret },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      log.warn('dispatchNotify failed', { err: String(err) })
    }
  })()
}
