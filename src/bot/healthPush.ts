import { env } from '../config/env'
import { log } from '../services/logger'

let timer: NodeJS.Timeout | null = null

const INTERVAL_MS = 60_000

export function startHealthPush(): void {
  if (!env.UPTIME_KUMA_PUSH_URL) return
  if (timer) return
  const push = async (): Promise<void> => {
    try {
      await fetch(env.UPTIME_KUMA_PUSH_URL!, { method: 'GET' })
    } catch (err) {
      log.warn('Kuma push failed', { err: String(err) })
    }
  }
  void push()
  timer = setInterval(() => { void push() }, INTERVAL_MS)
  timer.unref()
}

export function stopHealthPush(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
