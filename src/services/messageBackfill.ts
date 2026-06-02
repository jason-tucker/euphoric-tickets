import { type Message, type TextChannel, type ThreadChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { ticketMessages, type MessageAttachment } from '../db/schema/ticketMessages'
import { getOrCreateUserByDiscordId } from './userResolver'

// Maps a discord.js message's attachments to our stored shape. URLs here are
// Discord's signed CDN URLs (they expire ~24h) — the web refreshes them on
// demand, so we keep them only as a fallback.
export function extractAttachments(msg: Message): MessageAttachment[] {
  return [...msg.attachments.values()].map((a) => ({
    id: a.id,
    name: a.name ?? 'file',
    url: a.url,
    contentType: a.contentType ?? null,
    size: a.size,
  }))
}

// Flatten a message's embeds into readable markdown text. TicketTool posts most
// of its content — welcome cards, logging events, close prompts — as embeds with
// no plain `content`, so without this those messages ingest as "(no text)". We
// serialize author/title/description/fields/footer into the body so the web
// archive shows + searches the real content. (Image-only embeds yield nothing.)
// Requires the Message Content intent, which the bot already has.
export function extractEmbedText(msg: Message): string {
  if (!msg.embeds || msg.embeds.length === 0) return ''
  const blocks: string[] = []
  for (const e of msg.embeds) {
    const seg: string[] = []
    if (e.author?.name) seg.push(`**${e.author.name}**`)
    if (e.title) seg.push(`**${e.title}**`)
    if (e.description) seg.push(e.description)
    for (const f of e.fields ?? []) {
      seg.push(`**${f.name}**\n${f.value}`)
    }
    if (e.footer?.text) seg.push(`-# ${e.footer.text}`)
    if (seg.length > 0) blocks.push(seg.join('\n'))
  }
  return blocks.join('\n\n').slice(0, 4000)
}

// The text we store for a message: plain content first, else flattened embeds,
// else a placeholder noting attachments. Shared by the live relay + backfill so
// embed-only TicketTool messages render the same both ways.
export function messageBodyText(msg: Message, attachmentCount: number): string {
  const content = msg.content ?? ''
  if (content.length > 0) return content
  const embedText = extractEmbedText(msg)
  if (embedText.length > 0) return embedText
  return attachmentCount > 0 ? '(attachment)' : '(no text)'
}

// Backfill recent channel history into ticket_messages. Used by /tickets
// convert (and the P11 startup resync later). Skips bot/webhook/system
// messages, dedupes by discord_message_id, preserves original timestamps,
// and captures attachments. Returns the count inserted.
export async function backfillChannelMessages(
  channel: TextChannel | ThreadChannel,
  ticketId: number,
  opts?: { limit?: number; source?: 'discord' | 'internal' },
): Promise<number> {
  const limit = Math.min(opts?.limit ?? 100, 100)
  const source = opts?.source ?? 'discord'

  const fetched = await channel.messages.fetch({ limit })
  // Oldest → newest so insertion order matches the conversation.
  const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)

  // Perf: one dedup query for the whole batch instead of a SELECT per message
  // (was N+1 — felt on /tickets convert and the startup resync).
  const existing = await db
    .select({ d: ticketMessages.discordMessageId })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, ticketId))
  const seen = new Set(existing.map((e) => e.d).filter(Boolean) as string[])

  // Collect rows then bulk-insert once. Author resolution is per-process
  // cached, so repeated authors don't re-hit the DB.
  const rows: (typeof ticketMessages.$inferInsert)[] = []
  for (const msg of ordered) {
    if (msg.system) continue
    if (msg.webhookId) continue
    if (msg.author.id === channel.client.user?.id) continue
    if (seen.has(msg.id)) continue

    const attachments = extractAttachments(msg)
    const body = messageBodyText(msg, attachments.length)
    // Skip only when there's genuinely nothing to store (no text, no embed
    // content, no attachments). Embed-only messages (TicketTool cards) now have
    // a real body and are kept.
    if (body === '(no text)' && attachments.length === 0) continue
    seen.add(msg.id)

    const authorUserId = await getOrCreateUserByDiscordId(msg.author.id, {
      name: msg.author.globalName ?? msg.author.username,
      image: msg.author.displayAvatarURL(),
    })

    rows.push({
      ticketId,
      authorUserId,
      body,
      source,
      discordMessageId: msg.id,
      attachments,
      createdAt: msg.createdAt,
    })
  }

  if (rows.length > 0) await db.insert(ticketMessages).values(rows)
  return rows.length
}
