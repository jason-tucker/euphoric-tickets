import { type Message, type TextChannel } from 'discord.js'
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

// Backfill recent channel history into ticket_messages. Used by /tickets
// convert (and the P11 startup resync later). Skips bot/webhook/system
// messages, dedupes by discord_message_id, preserves original timestamps,
// and captures attachments. Returns the count inserted.
export async function backfillChannelMessages(
  channel: TextChannel,
  ticketId: number,
  opts?: { limit?: number; source?: 'discord' | 'internal' },
): Promise<number> {
  const limit = Math.min(opts?.limit ?? 100, 100)
  const source = opts?.source ?? 'discord'

  const fetched = await channel.messages.fetch({ limit })
  // Oldest → newest so insertion order matches the conversation.
  const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)

  let inserted = 0
  for (const msg of ordered) {
    if (msg.system) continue
    if (msg.webhookId) continue
    if (msg.author.id === channel.client.user?.id) continue

    const content = msg.content ?? ''
    const attachments = extractAttachments(msg)
    if (content.length === 0 && attachments.length === 0) continue

    const [dup] = await db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(eq(ticketMessages.discordMessageId, msg.id))
      .limit(1)
    if (dup) continue

    const authorUserId = await getOrCreateUserByDiscordId(msg.author.id, {
      name: msg.author.globalName ?? msg.author.username,
      image: msg.author.displayAvatarURL(),
    })

    await db.insert(ticketMessages).values({
      ticketId,
      authorUserId,
      body: content.length > 0 ? content : '(attachment)',
      source,
      discordMessageId: msg.id,
      attachments,
      createdAt: msg.createdAt,
    })
    inserted++
  }
  return inserted
}
