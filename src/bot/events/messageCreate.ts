import type { Client, Message } from 'discord.js'
import { eq, or, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets, ticketMessages } from '../../db/schema'
import { getOrCreateUserByDiscordId } from '../../services/userResolver'
import { log } from '../../services/logger'

// Phase A3 + #N internal-note sync — bidirectional relay. For every
// MESSAGE_CREATE in a channel that maps to a ticket row (main channel OR
// the per-ticket private internal thread), insert a ticket_messages row so
// the web view shows it. Source is 'discord' for the main channel, or
// 'internal' for the private staff thread. Dedupes by discord_message_id.
export function registerMessageCreate(client: Client): void {
  client.on('messageCreate', (msg) => {
    void handleMessage(msg).catch((err) => {
      log.warn('messageCreate relay failed', { err: String(err) })
    })
  })
}

async function handleMessage(msg: Message): Promise<void> {
  if (msg.system || !msg.guildId) return

  // Skip our own outbound webhook posts (the web's user-spoofed replies).
  if (msg.webhookId) return

  // Skip the bot itself (covers the case where web posts internal notes to
  // the private thread via the bot token — we already wrote that row when
  // the web action ran, dedupe would catch it anyway).
  if (msg.author.id === msg.client.user.id) return

  // Match either the main per-ticket channel or its internal thread.
  const [row] = await db
    .select({
      id: tickets.id,
      mainChannelId: tickets.discordChannelId,
      internalThreadId: tickets.discordInternalThreadId,
    })
    .from(tickets)
    .where(
      or(
        eq(tickets.discordChannelId, msg.channelId),
        eq(tickets.discordInternalThreadId, msg.channelId),
      ),
    )
    .limit(1)
  if (!row) return

  const isInternal = row.internalThreadId === msg.channelId

  // Dedupe: if we already have this Discord message id, do nothing.
  const [dup] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(eq(ticketMessages.discordMessageId, msg.id))
    .limit(1)
  if (dup) return

  const authorUserId = await getOrCreateUserByDiscordId(msg.author.id, {
    name: msg.author.globalName ?? msg.author.username,
    image: msg.author.displayAvatarURL(),
  })

  await db.insert(ticketMessages).values({
    ticketId: row.id,
    authorUserId,
    body: msg.content.length > 0 ? msg.content : '(no text)',
    source: isInternal ? 'internal' : 'discord',
    discordMessageId: msg.id,
  })

  await db
    .update(tickets)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(tickets.id, row.id))
}
