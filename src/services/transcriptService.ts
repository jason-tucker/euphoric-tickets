import type { TextChannel } from 'discord.js'
import { Collection, type Message } from 'discord.js'
import { ExportReturnType, generateFromMessages } from 'discord-html-transcripts'

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
    all.push(...batch.values())
    before = batch.last()?.id
    if (batch.size < 100) break
  }
  // Batches arrive newest-first; one global sort puts the transcript in
  // chronological order (cheaper than re-sorting + prepending per batch).
  return all.sort((a, b) => Number(a.createdTimestamp) - Number(b.createdTimestamp))
}

// Discord-style HTML transcript (v0.10.0) via discord-html-transcripts: the
// same <discord-messages> markup copium.pics renders like the real channel
// (transcripts.copium.tools). This is the DM attachment and the copium upload.
// Images are NOT inlined (saveImages: false) — they stay Discord CDN URLs and
// copium rehosts them. The header shows guild + channel; the footer names the
// ticket. Without hydration the page loads @derockdev/discord-components-core
// from cdn.jsdelivr.net to render the custom elements in a browser.
export async function renderDiscordTranscriptHtml(opts: {
  channel: TextChannel
  messages: Message[]
  ticketId: number
  filename: string
}): Promise<string> {
  const { channel, messages, ticketId, filename } = opts
  return generateFromMessages(messages, channel, {
    returnType: ExportReturnType.String,
    saveImages: false,
    poweredBy: false,
    filename,
    footerText: `Ticket #${ticketId} · ${channel.guild.name} · #${channel.name} · {number} message{s}`,
  })
}

// Legacy hand-rolled HTML. Only used as the DM attachment when the
// Discord-style renderer throws, so the opener still gets a transcript.
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

// Plain-text transcript for the copium.pics paste (v0.9.0). Same inputs as
// renderTranscriptHtml. Capped at TEXT_TRANSCRIPT_MAX_BYTES (UTF-8): messages
// are kept oldest-first and the newest ones are dropped once the cap is hit,
// with a note saying how many were omitted (the HTML attachment stays
// complete). The paste host's size limit is unknown; 900 KB keeps us well
// under a typical 1 MB request cap.
export const TEXT_TRANSCRIPT_MAX_BYTES = 900_000

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export function renderTranscriptText(opts: {
  guildName: string
  channelName: string
  ticketId: number
  openerTag: string
  closedByTag: string
  messages: Message[]
  closedAt?: Date
  maxBytes?: number
}): string {
  const { guildName, channelName, ticketId, openerTag, closedByTag, messages } = opts
  const maxBytes = opts.maxBytes ?? TEXT_TRANSCRIPT_MAX_BYTES
  const header =
    [
      `Ticket #${ticketId}`,
      `Server:    ${guildName}`,
      `Channel:   #${channelName}`,
      `Opened by: ${openerTag}`,
      `Closed by: ${closedByTag}`,
      `Closed at: ${(opts.closedAt ?? new Date()).toISOString()}`,
      `Messages:  ${messages.length}`,
      '',
      '----------------------------------------',
      '',
    ].join('\n') + '\n'

  const blocks = messages.map((m) => {
    const lines = (m.content || '(no text)').split('\n')
    const out = [`[${utcStamp(Number(m.createdTimestamp))}] ${m.author.tag}: ${lines[0]}`]
    for (const l of lines.slice(1)) out.push(`    ${l}`)
    for (const a of m.attachments.values()) out.push(`    [attachment] ${a.name ?? 'attachment'}: ${a.url}`)
    return out.join('\n') + '\n'
  })

  const truncationNote = (n: number) =>
    `\n[transcript truncated — ${n} later message${n === 1 ? '' : 's'} omitted; see attached HTML]\n`
  // Reserve room for the note (its count has at most as many digits as the total).
  const reserve = Buffer.byteLength(truncationNote(messages.length), 'utf8')

  let size = Buffer.byteLength(header, 'utf8')
  const kept: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = Buffer.byteLength(blocks[i], 'utf8')
    const remainingAfter = blocks.length - i - 1
    // The last block needs no note reserve if everything fits.
    const limit = remainingAfter === 0 ? maxBytes : maxBytes - reserve
    if (size + b > limit) {
      return header + kept.join('') + truncationNote(blocks.length - i)
    }
    kept.push(blocks[i])
    size += b
  }
  return header + kept.join('')
}
