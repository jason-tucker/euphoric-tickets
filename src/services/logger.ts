function fmt(level: string, msg: string, extra?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''
  return `[${ts}] ${level} ${msg}${tail}`
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => console.log(fmt('INFO', msg, extra)),
  warn: (msg: string, extra?: Record<string, unknown>) => console.warn(fmt('WARN', msg, extra)),
  error: (msg: string, extra?: Record<string, unknown>) => console.error(fmt('ERROR', msg, extra)),
}

// P12 (lantern) — persist a structured error row to bot_errors (5-day
// retention, swept hourly). Always logs to stdout too. Best-effort: a DB
// failure here must never throw (it would mask the original error), so the
// insert is fire-and-forget with its own catch. Imports are lazy to avoid a
// startup import cycle (logger ↔ db ↔ schema).
export function persistError(
  level: 'error' | 'warn' | 'info',
  source: string,
  message: string,
  opts?: { stack?: string | null; context?: Record<string, unknown> },
): void {
  if (level === 'warn') log.warn(`[${source}] ${message}`, opts?.context)
  else if (level === 'info') log.info(`[${source}] ${message}`, opts?.context)
  else log.error(`[${source}] ${message}`, opts?.context)

  void (async () => {
    try {
      const { db } = await import('../db/client')
      const { botErrors } = await import('../db/schema/botErrors')
      await db.insert(botErrors).values({
        level,
        source,
        message: message.slice(0, 4000),
        stack: opts?.stack ? opts.stack.slice(0, 8000) : null,
        context: opts?.context ?? null,
      })
    } catch {
      // Swallow — never let error logging throw.
    }
  })()
}
