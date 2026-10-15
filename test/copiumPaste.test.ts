import { afterEach, describe, expect, it, vi } from 'vitest'
import { Collection } from 'discord.js'
import { addToAlbum, createPaste } from '../src/services/copiumService'
import { renderTranscriptText } from '../src/services/transcriptService'
import { env } from '../src/config/env'

afterEach(() => {
  vi.restoreAllMocks()
})

const TOKEN = 'copium-test-token-SECRET'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('copiumService.createPaste', () => {
  it('POSTs the paste and returns pageUrl with the host swapped to COPIUM_LINK_HOST', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(201, { id: 'qVx79Apa', url: 'https://tucker.copium.pics/qVx79Apa.txt', pageUrl: 'https://tucker.copium.pics/i/qVx79Apa' }),
    )
    const url = await createPaste(
      { title: 'Ticket #1', content: 'hello' },
      { fetch, token: TOKEN, apiBase: 'https://copium.pics/', linkHost: 'i.tucker.host' },
    )
    expect(url).toEqual({ id: 'qVx79Apa', url: 'https://i.tucker.host/i/qVx79Apa' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://copium.pics/api/paste')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
    })
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Ticket #1', content: 'hello', language: 'plaintext' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns pageUrl unchanged when no link host is configured', async () => {
    const fetch = vi.fn(async () => jsonResponse(201, { pageUrl: 'https://tucker.copium.pics/i/abc' }))
    expect(await createPaste({ title: 't', content: 'c' }, { fetch, token: TOKEN, linkHost: undefined })).toEqual({
      id: null,
      url: 'https://tucker.copium.pics/i/abc',
    })
  })

  it('no token → no network call, null', async () => {
    const fetch = vi.fn()
    expect(await createPaste({ title: 't', content: 'c' }, { fetch, token: undefined })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    // The test env leaves COPIUM_TOKEN unset, so the default is disabled too.
    expect(env.COPIUM_TOKEN).toBeUndefined()
    expect(env.COPIUM_API_BASE).toBe('https://copium.pics')
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await createPaste({ title: 't', content: 'c' })).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('401 → null, warns with the status and never logs the token or content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => jsonResponse(401, { error: 'Upload token is invalid or was revoked' }))
    expect(await createPaste({ title: 't', content: 'PRIVATE-CONTENT' }, { fetch, token: TOKEN })).toBeNull()
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('401')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('PRIVATE-CONTENT')
  })

  it('timeout → null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    ) as unknown as typeof globalThis.fetch
    expect(await createPaste({ title: 't', content: 'c' }, { fetch, token: TOKEN, timeoutMs: 20 })).toBeNull()
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('timeout')
  })

  it('a thrown fetch, bad JSON, or a missing/invalid pageUrl → null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: (typeof globalThis.fetch)[] = [
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      vi.fn(async () => new Response('<html>oops</html>', { status: 201 })),
      vi.fn(async () => jsonResponse(201, { id: 'x' })),
      vi.fn(async () => jsonResponse(201, { pageUrl: 'not a url' })),
      vi.fn(async () => jsonResponse(500, { error: 'boom' })),
    ]
    for (const fetch of cases) {
      expect(await createPaste({ title: 't', content: 'c' }, { fetch, token: TOKEN })).toBeNull()
    }
  })
})

describe('copiumService.addToAlbum', () => {
  it('POSTs the ids to /api/albums/<id>/images and returns true when added >= 1', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { added: 1, album: { id: 'alb1' } }))
    expect(await addToAlbum('alb1', ['qVx79Apa'], { fetch, token: TOKEN, apiBase: 'https://copium.pics/' })).toBe(true)
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://copium.pics/api/albums/alb1/images')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
    })
    expect(JSON.parse(String(init.body))).toEqual({ imageIds: ['qVx79Apa'] })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('no token → no request, false', async () => {
    const fetch = vi.fn()
    expect(await addToAlbum('alb1', ['x'], { fetch, token: undefined })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('non-2xx, added: 0, bad JSON, throw or timeout → false; the token is never logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: (typeof globalThis.fetch)[] = [
      vi.fn(async () => jsonResponse(404, { error: 'Album not found' })),
      vi.fn(async () => jsonResponse(200, { added: 0 })),
      vi.fn(async () => new Response('nope', { status: 200 })),
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          }),
      ) as unknown as typeof globalThis.fetch,
    ]
    for (const fetch of cases) {
      expect(await addToAlbum('alb1', ['x'], { fetch, token: TOKEN, timeoutMs: 20 })).toBe(false)
    }
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('404')
    expect(logged).toContain('timeout')
    expect(logged).not.toContain(TOKEN)
  })
})

function msg(ts: string, tag: string, content: string, attachments: { url: string; name: string }[] = []) {
  return {
    createdTimestamp: Date.parse(ts),
    author: { tag },
    content,
    attachments: new Collection(attachments.map((a, i) => [String(i), a])),
  } as any
}

const base = {
  guildName: 'Euphoric',
  channelName: 'ticket-42-alice',
  ticketId: 42,
  openerTag: 'alice',
  closedByTag: 'bob',
  closedAt: new Date('2026-10-15T12:00:00.000Z'),
}

describe('renderTranscriptText', () => {
  it('renders the header and one block per message with indented attachments', () => {
    const text = renderTranscriptText({
      ...base,
      messages: [
        msg('2026-10-15T10:00:01.123Z', 'alice', 'hi\nsecond line'),
        msg('2026-10-15T10:05:00.000Z', 'bob', '', [{ url: 'https://cdn.example/a.png', name: 'a.png' }]),
      ],
    })
    expect(text).toBe(
      [
        'Ticket #42',
        'Server:    Euphoric',
        'Channel:   #ticket-42-alice',
        'Opened by: alice',
        'Closed by: bob',
        'Closed at: 2026-10-15T12:00:00.000Z',
        'Messages:  2',
        '',
        '----------------------------------------',
        '',
        '[2026-10-15 10:00:01 UTC] alice: hi',
        '    second line',
        '[2026-10-15 10:05:00 UTC] bob: (no text)',
        '    [attachment] a.png: https://cdn.example/a.png',
        '',
      ].join('\n'),
    )
  })

  it('keeps oldest messages and drops the tail with a note when over the byte cap', () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      msg(new Date(Date.UTC(2026, 9, 15, 10, 0, i)).toISOString(), 'alice', `message ${i} ` + 'é'.repeat(200)),
    )
    const maxBytes = 5_000
    const text = renderTranscriptText({ ...base, messages, maxBytes })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(text).toContain('alice: message 0 ')
    expect(text).not.toContain('message 99 ')
    const kept = (text.match(/alice: message \d+/g) ?? []).length
    expect(kept).toBeGreaterThan(0)
    expect(text.trimEnd().endsWith(`[transcript truncated — ${100 - kept} later messages omitted; see attached HTML]`)).toBe(true)
  })

  it('does not truncate when everything fits under the default cap', () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg('2026-10-15T10:00:00Z', 'a', `m${i}`))
    expect(renderTranscriptText({ ...base, messages })).not.toContain('truncated')
  })
})
