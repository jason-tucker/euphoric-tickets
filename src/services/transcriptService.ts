import type { TextChannel } from 'discord.js'
import { Collection, type Message } from 'discord.js'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function fetchAllMessages(channel: TextChannel, hardCap = 2000): Promise<Message[]> {
  const all: Message[] = []
  let before: string | undefined
  while (all.length < hardCap) {
    const batch: Collection<string, Message> = await channel.messages.fetch({ limit: 100, before })
    if (batch.size === 0) break
    const sorted = [...batch.values()].sort((a, b) => Number(a.createdTimestamp) - Number(b.createdTimestamp))
    all.unshift(...sorted)
    before = batch.last()?.id
    if (batch.size < 100) break
  }
  return all
}

export function renderTranscriptHtml(opts: {
  guildName: string
  channelName: string
  ticketId: number
  openerTag: string
  closedByTag: string
  messages: Message[]
}): string {
  const { guildName, channelName, ticketId, openerTag, closedByTag, messages } = opts
  const rows: string[] = []
  for (const m of messages) {
    const ts = new Date(Number(m.createdTimestamp)).toISOString()
    const author = escapeHtml(`${m.author.tag}`)
    const content = m.content ? escapeHtml(m.content).replace(/\n/g, '<br>') : '<em>(no text)</em>'
    const attachments = m.attachments.size
      ? '<div class="atts">' +
        [...m.attachments.values()]
          .map((a) => `<a href="${escapeHtml(a.url)}" target="_blank">📎 ${escapeHtml(a.name ?? 'attachment')}</a>`)
          .join('<br>') +
        '</div>'
      : ''
    rows.push(
      `<div class="msg"><div class="meta"><span class="author">${author}</span> <span class="ts">${ts}</span></div><div class="body">${content}${attachments}</div></div>`,
    )
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ticket #${ticketId} — ${escapeHtml(channelName)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; background: #1e1f22; color: #dbdee1; margin: 0; padding: 24px; }
  header { border-bottom: 1px solid #383a40; padding-bottom: 12px; margin-bottom: 16px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  .sub { color: #949ba4; font-size: 12px; }
  .msg { padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; background: #2b2d31; }
  .meta { font-size: 12px; color: #949ba4; margin-bottom: 4px; }
  .author { color: #a855f7; font-weight: 600; }
  .ts { margin-left: 8px; }
  .body { white-space: pre-wrap; word-wrap: break-word; }
  .atts { margin-top: 4px; font-size: 12px; }
  .atts a { color: #00a8fc; }
</style>
</head>
<body>
<header>
  <h1>Ticket #${ticketId} — #${escapeHtml(channelName)}</h1>
  <div class="sub">${escapeHtml(guildName)} · Opened by ${escapeHtml(openerTag)} · Closed by ${escapeHtml(closedByTag)} · ${messages.length} messages</div>
</header>
${rows.join('\n')}
</body>
</html>`
}
