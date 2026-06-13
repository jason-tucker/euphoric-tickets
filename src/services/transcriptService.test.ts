import { describe, expect, it, vi } from 'vitest'
import { Collection, type Message, type TextChannel } from 'discord.js'
import { fetchAllMessages, renderTranscriptHtml } from './transcriptService'

// The renderer only touches createdTimestamp / author.tag / content /
// attachments — a plain object with a Map for attachments is enough.
function fakeMessage(opts: {
  id?: string
  ts?: number
  authorTag?: string
  content?: string
  attachments?: { url: string; name: string }[]
}): Message {
  return {
    id: opts.id ?? '1',
    createdTimestamp: opts.ts ?? 1_700_000_000_000,
    author: { tag: opts.authorTag ?? 'user#0' },
    content: opts.content ?? '',
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
  } as unknown as Message
}

describe('renderTranscriptHtml', () => {
  const baseOpts = {
    guildName: 'Guild',
    channelName: 'ticket-1-user',
    ticketId: 1,
    openerTag: 'opener#0',
    closedByTag: 'staff#0',
  }

  it('escapes HTML in message content, author tags, and header fields', () => {
    const html = renderTranscriptHtml({
      ...baseOpts,
      guildName: 'Guild <b>',
      openerTag: '<img src=x onerror=alert(1)>',
      messages: [
        fakeMessage({ authorTag: 'evil"<i>#0', content: '<script>alert(1)</script> & "quotes"' }),
      ],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;')
    expect(html).toContain('evil&quot;&lt;i&gt;#0')
    expect(html).toContain('Guild &lt;b&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('renders newlines as <br> and empty content as a placeholder', () => {
    const html = renderTranscriptHtml({
      ...baseOpts,
      messages: [fakeMessage({ content: 'line1\nline2' }), fakeMessage({ content: '' })],
    })
    expect(html).toContain('line1<br>line2')
    expect(html).toContain('<em>(no text)</em>')
  })

  it('renders escaped attachment links', () => {
    const html = renderTranscriptHtml({
      ...baseOpts,
      messages: [
        fakeMessage({
          attachments: [{ url: 'https://cdn.example/a.png?x="><script>', name: 'shot<1>.png' }],
        }),
      ],
    })
    expect(html).toContain('https://cdn.example/a.png?x=&quot;&gt;&lt;script&gt;')
    expect(html).toContain('📎 shot&lt;1&gt;.png')
  })

  it('includes the ticket header with the message count', () => {
    const html = renderTranscriptHtml({ ...baseOpts, messages: [fakeMessage({}), fakeMessage({})] })
    expect(html).toContain('Ticket #1 — #ticket-1-user')
    expect(html).toContain('2 messages')
  })
})

describe('fetchAllMessages', () => {
  // Discord returns batches newest-first; build a channel whose fetch pages
  // through `total` messages exactly like channel.messages.fetch does.
  function fakeChannel(total: number) {
    const fetch = vi.fn(async ({ limit, before }: { limit: number; before?: string }) => {
      const newestFirst = Array.from({ length: total }, (_, i) =>
        fakeMessage({ id: String(total - i), ts: (total - i) * 1000 }),
      )
      const start = before ? newestFirst.findIndex((m) => m.id === before) + 1 : 0
      const page = newestFirst.slice(start, start + limit)
      return new Collection(page.map((m) => [m.id, m]))
    })
    return { channel: { messages: { fetch } } as unknown as TextChannel, fetch }
  }

  it('pages through long histories and returns chronological order', async () => {
    const { channel, fetch } = fakeChannel(150)
    const all = await fetchAllMessages(channel)
    expect(all).toHaveLength(150)
    expect(all[0]?.id).toBe('1')
    expect(all[149]?.id).toBe('150')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith({ limit: 100, before: '51' })
  })

  it('stops after one fetch when the history is short', async () => {
    const { channel, fetch } = fakeChannel(30)
    const all = await fetchAllMessages(channel)
    expect(all).toHaveLength(30)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
