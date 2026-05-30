import { ChannelType, type Client, type TextChannel } from 'discord.js'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets } from '../db/schema/tickets'
import { ticketPanels } from '../db/schema/ticketPanels'
import { backfillChannelMessages } from '../services/messageBackfill'
import { log, persistError } from '../services/logger'

// P11 (lantern) — reconcile DB ↔ Discord on connect and backfill anything the
// bot missed while it was down. Three idempotent passes, all best-effort so a
// failure in one ticket never aborts the boot.
export async function runStartupResync(client: Client): Promise<void> {
  const started = Date.now()
  log.info('startup resync: begin')

  let orphans = 0
  let backfilled = 0
  let missingPanels = 0

  // ---- Pass 1 + 3: open tickets with a channel -----------------------------
  const openTickets = await db
    .select({
      id: tickets.id,
      discordChannelId: tickets.discordChannelId,
      discordInternalThreadId: tickets.discordInternalThreadId,
    })
    .from(tickets)
    .where(and(ne(tickets.status, 'closed'), isNotNull(tickets.discordChannelId)))

  // Perf: process tickets in bounded-concurrency batches instead of strictly
  // serial — keeps a big backlog from making boot crawl, while the batch size
  // stays well under Discord's rate limits.
  const CONCURRENCY = 5
  const processTicket = async (t: (typeof openTickets)[number]): Promise<void> => {
    const channelId = t.discordChannelId!
    const channel = await client.channels.fetch(channelId).catch(() => null)

    // Pass 1 — orphan scan.
    if (!channel) {
      await db
        .update(tickets)
        .set({ needsAttention: true, discordChannelId: null, discordWebhookId: null, discordWebhookUrl: null })
        .where(eq(tickets.id, t.id))
      orphans++
      persistError('warn', 'startup-resync', 'orphaned ticket channel', {
        context: { ticketId: t.id, channelId },
      })
      return
    }
    if (channel.type !== ChannelType.GuildText) return

    // Pass 3 — backfill messages posted while the bot was offline. The
    // backfill helper dedupes by discord_message_id, so re-running is safe.
    try {
      const n = await backfillChannelMessages(channel as TextChannel, t.id, { limit: 100 })
      backfilled += n
    } catch (err) {
      log.warn('startup resync: backfill failed', { ticketId: t.id, err: String(err) })
    }
  }

  for (let i = 0; i < openTickets.length; i += CONCURRENCY) {
    await Promise.all(openTickets.slice(i, i + CONCURRENCY).map(processTicket))
  }

  // ---- Pass 2: panel reconcile --------------------------------------------
  const panels = await db
    .select({ id: ticketPanels.id, channelId: ticketPanels.channelId, messageId: ticketPanels.messageId })
    .from(ticketPanels)
  for (const p of panels) {
    const channel = await client.channels.fetch(p.channelId).catch(() => null)
    if (!channel || channel.type !== ChannelType.GuildText) {
      missingPanels++
      continue
    }
    const msg = await (channel as TextChannel).messages.fetch(p.messageId).catch(() => null)
    if (!msg) {
      missingPanels++
      persistError('warn', 'startup-resync', 'panel message missing (re-run /panel post)', {
        context: { channelId: p.channelId, messageId: p.messageId },
      })
    }
  }

  log.info('startup resync: done', {
    ms: Date.now() - started,
    openTickets: openTickets.length,
    orphans,
    backfilledMessages: backfilled,
    missingPanels,
  })
}
