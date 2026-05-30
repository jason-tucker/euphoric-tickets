import type { Client, Message } from 'discord.js'
import { eq, or, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets, ticketMessages } from '../../db/schema'
import { getOrCreateUserByDiscordId } from '../../services/userResolver'
import { extractAttachments } from '../../services/messageBackfill'
import { getBusinessByGuildId } from '../../services/businessResolver'
import { dispatchNotify } from '../../services/notifyBridge'
import { log } from '../../services/logger'
import { env } from '../../config/env'

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

// P14: DM gateway — guide users who message the bot directly. Cooldown so a
// chatty user gets the explainer at most once every 10 minutes.
const dmCooldown = new Map<string, number>()
const DM_COOLDOWN_MS = 10 * 60 * 1000

async function handleDmGateway(msg: Message): Promise<void> {
  const last = dmCooldown.get(msg.author.id) ?? 0
  if (Date.now() - last < DM_COOLDOWN_MS) return
  dmCooldown.set(msg.author.id, Date.now())

  await msg
    .reply({
      content:
        "👋 I don't handle DMs — messages here don't reach any staff.\n\n" +
        '**For support**, open a ticket from the ticket panel in your server, ' +
        `or on the web: ${env.WEB_BASE_URL}\n\n` +
        '**For questions about the bot itself**, open a ticket in your server and pick the ' +
        'bot/help category if one exists.',
      allowedMentions: { parse: [] },
    })
    .catch(() => {})
}

async function handleMessage(msg: Message): Promise<void> {
  if (msg.system) return

  // DM (no guild): run the gateway instead of dropping silently.
  if (!msg.guildId) {
    if (msg.author.bot || msg.author.id === msg.client.user.id) return
    await handleDmGateway(msg)
    return
  }

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
      businessId: tickets.businessId,
      categoryId: tickets.categoryId,
      subject: tickets.subject,
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

  const attachments = extractAttachments(msg)

  await db.insert(ticketMessages).values({
    ticketId: row.id,
    authorUserId,
    body: msg.content.length > 0 ? msg.content : attachments.length > 0 ? '(attachment)' : '(no text)',
    source: isInternal ? 'internal' : 'discord',
    discordMessageId: msg.id,
    attachments,
  })

  await db
    .update(tickets)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(tickets.id, row.id))

  // P13: notify the ticket's opener/assignee of a Discord-origin reply.
  // Internal-thread messages never notify (they're staff-private).
  if (!isInternal) {
    const business = await getBusinessByGuildId(msg.guildId)
    if (business) {
      dispatchNotify({
        event: 'reply',
        businessId: row.businessId,
        categoryId: row.categoryId,
        ticketId: row.id,
        subject: row.subject,
        slug: business.slug,
        actorUserId: authorUserId,
      })
    }
  }
}
