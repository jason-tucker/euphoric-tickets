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
