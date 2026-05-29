import type { Client, Message } from 'discord.js'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets, ticketMessages } from '../../db/schema'
import { getOrCreateUserByDiscordId } from '../../services/userResolver'
import { log } from '../../services/logger'

// Phase A3 — bidirectional sync. For every MESSAGE_CREATE in a channel
// that maps to a ticket row, insert a ticket_messages row with
// source='discord' so the web view shows it. Dedupes by discord_message_id.
export function registerMessageCreate(client: Client): void {
  client.on('messageCreate', (msg) => {
    void handleMessage(msg).catch((err) => {
      log.warn('messageCreate relay failed', { err: String(err) })
    })
  })
}

async function handleMessage(msg: Message): Promise<void> {
  // Skip system messages and any message lacking a guild (DMs).
  if (msg.system || !msg.guildId) return

  // Skip our own outbound webhook posts (the ones the web sent into the
  // channel as a user-spoof). They came from our DB; relaying them would
  // double-count. The web-posted webhooks were persisted with their
  // returned discord_message_id, so we'd dedupe anyway — but webhook_id is
  // a cheap early exit.
  if (msg.webhookId) return

  // Skip the bot itself.
  if (msg.author.id === msg.client.user.id) return

  // Look up the ticket by channel id. Most channels won't match — fast NOOP.
  const [t] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.discordChannelId, msg.channelId))
    .limit(1)
  if (!t) return

  // Dedupe: if we already have this Discord message id, do nothing.
  const [dup] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(eq(ticketMessages.discordMessageId, msg.id))
    .limit(1)
  if (dup) return

  // Resolve / upsert the author as a users row.
  const authorUserId = await getOrCreateUserByDiscordId(msg.author.id, {
    name: msg.author.globalName ?? msg.author.username,
    image: msg.author.displayAvatarURL(),
  })

  // Insert the relayed message.
  await db.insert(ticketMessages).values({
    ticketId: t.id,
    authorUserId,
    body: msg.content.length > 0 ? msg.content : '(no text)',
    source: 'discord',
    discordMessageId: msg.id,
  })

  // Bump the ticket's last activity timestamp so the web queue sorts right.
  await db
    .update(tickets)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(tickets.id, t.id))
}
