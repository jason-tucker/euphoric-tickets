import { afterEach, describe, expect, it, vi } from 'vitest'
import { Collection } from 'discord.js'
import { addToAlbum, COPIUM_HTML_MAX_BYTES, createPaste, uploadHtml } from '../src/services/copiumService'
import { inlineProfiles, renderDiscordTranscriptHtml, renderTranscriptText } from '../src/services/transcriptService'
import { sampleConversation } from './fixtures/sampleConversation'
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
    expect(env.COPIUM_UPLOAD_BASE).toBe('https://v.copium.pics')
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

describe('copiumService.uploadHtml', () => {
  const HTML = '<!DOCTYPE html><html><body><discord-messages>PRIVATE-HTML</discord-messages></body></html>'
  const ok = (body: Record<string, unknown>) => vi.fn(async () => jsonResponse(201, body))

  it('POSTs multipart file + title to <uploadBase>/api/upload?wait=1 and returns the link', async () => {
    const fetch = ok({
      key: 'TDTwf8Cu.html',
      kind: 'html',
      id: 'TDTwf8Cu',
      url: 'https://transcripts.copium.tools/TDTwf8Cu.url.html',
      messages: 2,
      pageUrl: 'https://tucker.copium.pics/i/TDTwf8Cu',
      link: 'https://transcripts.copium.tools/TDTwf8Cu.html',
    })
    const res = await uploadHtml(
      { filename: 'ticket-7-sample.html', html: HTML, title: 'Ticket #7 — sample (Server)' },
      // COPIUM_LINK_HOST must NOT be applied to HTML transcript links.
      { fetch, token: TOKEN, uploadBase: 'https://v.copium.pics/', linkHost: 'i.tucker.host' },
    )
    expect(res).toEqual({ id: 'TDTwf8Cu', url: 'https://transcripts.copium.tools/TDTwf8Cu.html' })
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://v.copium.pics/api/upload?wait=1')
    expect(init.method).toBe('POST')
    // No manual Content-Type: fetch sets multipart/form-data with the boundary.
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'X-Requested-With': 'fetch' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.name).toBe('ticket-7-sample.html')
    expect(file.type).toBe('text/html')
    expect(await file.text()).toBe(HTML)
    expect(form.get('title')).toBe('Ticket #7 — sample (Server)')
    // The serialised multipart body carries the same filename + content type.
    const raw = await new Response(form).text()
    expect(raw).toContain('name="file"; filename="ticket-7-sample.html"')
    expect(raw).toContain('Content-Type: text/html')
  })

  it('falls back to `url` when `link` is missing or invalid; appends .html to the filename', async () => {
    const fetch = ok({ kind: 'html', id: 'a', url: 'https://transcripts.copium.tools/a.html', link: 'javascript:alert(1)' })
    expect(await uploadHtml({ filename: 'ticket-1', html: HTML, title: 't' }, { fetch, token: TOKEN })).toEqual({
      id: 'a',
      url: 'https://transcripts.copium.tools/a.html',
    })
    const form = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData
    expect((form.get('file') as File).name).toBe('ticket-1.html')
  })

  it('accepts a non-html kind with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = ok({ kind: 'file', id: 'b', link: 'https://transcripts.copium.tools/b.html' })
    expect(await uploadHtml({ filename: 'x.html', html: HTML, title: 't' }, { fetch, token: TOKEN })).toEqual({
      id: 'b',
      url: 'https://transcripts.copium.tools/b.html',
    })
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('unexpected kind')
  })

  it('no token → no request; oversize HTML → no request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn()
    expect(await uploadHtml({ filename: 'x.html', html: HTML, title: 't' }, { fetch, token: undefined })).toBeNull()
    const huge = 'a'.repeat(COPIUM_HTML_MAX_BYTES + 1)
    expect(await uploadHtml({ filename: 'x.html', html: huge, title: 't' }, { fetch, token: TOKEN })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('401 / 500 / timeout / thrown / bad JSON / no link → null; never logs the token or the HTML', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases: (typeof globalThis.fetch)[] = [
      vi.fn(async () => jsonResponse(401, { error: 'Upload token is invalid or was revoked' })),
      vi.fn(async () => jsonResponse(500, { error: 'boom' })),
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          }),
      ) as unknown as typeof globalThis.fetch,
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      vi.fn(async () => new Response('<html>oops</html>', { status: 201 })),
      vi.fn(async () => jsonResponse(201, { kind: 'html', id: 'c' })),
    ]
    for (const fetch of cases) {
      expect(await uploadHtml({ filename: 'x.html', html: HTML, title: 't' }, { fetch, token: TOKEN, timeoutMs: 20 })).toBeNull()
    }
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('401')
    expect(logged).toContain('500')
    expect(logged).toContain('timeout')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('PRIVATE-HTML')
  })
})

describe('renderDiscordTranscriptHtml', () => {
  it('renders <discord-messages> with one <discord-message> per message, header + footer naming guild/channel/ticket', async () => {
    const { client, channel, messages } = sampleConversation()
    try {
      const html = await renderDiscordTranscriptHtml({ channel, messages, ticketId: 7, filename: 'ticket-7-sample-user.html' })
      expect(html).toContain('<discord-messages')
      expect(html.match(/<discord-message[\s>]/g)).toHaveLength(messages.length)
      expect(html).toContain('<discord-header guild="Sample Server" channel="ticket-7-sample-user"')
      expect(html).toContain('Ticket #7 · Sample Server · #ticket-7-sample-user · 4 messages')
      expect(html).toContain('<discord-reply')
      expect(html).toContain('<discord-embed')
      expect(html).toContain('<discord-mention type="user">Helper</discord-mention>')
      expect(html).toContain('url="https://cdn.discordapp.com/attachments/') // saveImages: false
      expect(html).not.toContain('data:image')
      expect(html).not.toMatch(/Powered by/i)

      // copium strips inline scripts: author/avatar must be explicit attributes.
      expect(html).not.toContain('profile=')
      expect(html).not.toContain('$discordMessage')
      expect(html).not.toContain('</style>;')
      expect(html).not.toContain('role-color="#000000"')
      const tags = html.match(/<discord-message [^>]*>/g) ?? []
      expect(tags).toHaveLength(4)
      for (const tag of tags) {
        expect(tag).toMatch(/ author="[^"]+"/)
        expect(tag).toMatch(/ avatar="https:\/\/[^"]+"/)
      }
      expect(tags[0]).toContain('author="EuphoricTickets"')
      expect(tags[0]).toMatch(/ bot(="")?[ >]/)
      expect(tags[1]).toContain('author="Sample User"')
      expect(tags[1]).not.toMatch(/ bot[= >]/)
      expect(tags[2]).toContain('author="Helper"')
      // The components script still loads (copium swaps it for its vendored copy).
      expect(html).toContain('<script type="module" src="https://cdn.jsdelivr.net/npm/@derockdev/discord-components-core@')
    } finally {
      await client.destroy()
    }
  })
})

describe('inlineProfiles', () => {
  it('escapes attribute values, adds verified/role-color only when meaningful, drops unknown profiles', () => {
    const profiles = new Map([
      ['1', { author: 'A "quoted" <b>&', avatar: 'https://cdn.example/a.png?x=1&y=2', bot: true, verified: true, roleColor: '#ff0000' }],
      ['2', { author: 'plain', avatar: 'https://cdn.example/b.png', bot: false, verified: false, roleColor: '#000000' }],
    ])
    const out = inlineProfiles(
      '<style>x</style>;<discord-message id="m-1" profile="1">a</discord-message><discord-message id="m-2" profile="2">b</discord-message>' +
        '<discord-message id="m-3" profile="3">c</discord-message><discord-reply slot="reply" author="r" role-color="#000000"></discord-reply>',
      profiles,
    )
    expect(out).toBe(
      '<style>x</style>' +
        '<discord-message id="m-1" author="A &quot;quoted&quot; &lt;b&gt;&amp;" avatar="https://cdn.example/a.png?x=1&amp;y=2" bot="" verified="" role-color="#ff0000">a</discord-message>' +
        '<discord-message id="m-2" author="plain" avatar="https://cdn.example/b.png">b</discord-message>' +
        '<discord-message id="m-3">c</discord-message><discord-reply slot="reply" author="r"></discord-reply>',
    )
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
