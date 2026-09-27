import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchNotify } from '../src/services/notifyBridge'
import { env } from '../src/config/env'
import { stubFetch } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notifyBridge', () => {
  it('POSTs to WEB_INTERNAL_URL (private network), not the public WEB_BASE_URL', async () => {
    const { calls, spy } = stubFetch()
    dispatchNotify({ event: 'reply', businessId: 'b', categoryId: null, ticketId: 7, subject: 's', slug: 'x' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].url).toBe('http://tickets-web:3000/api/internal/notify')
    expect(calls[0].url.startsWith(env.WEB_BASE_URL)).toBe(false)
    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe(process.env.INTERNAL_TOKEN)
  })

  it('WEB_INTERNAL_URL is optional and empty-string coerced', async () => {
    expect(env.WEB_INTERNAL_URL).toBe('http://tickets-web:3000')
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/config/env.ts', 'utf8'))
    const coerceList = src.slice(src.indexOf('for (const key of ['), src.indexOf(']) {'))
    expect(coerceList).toContain("'WEB_INTERNAL_URL'")
  })
})
