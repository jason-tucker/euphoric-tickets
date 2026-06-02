import { ChannelType, type Client, type TextChannel } from 'discord.js'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets } from '../db/schema/tickets'
import { ticketPanels } from '../db/schema/ticketPanels'
import { businesses } from '../db/schema/businesses'
import { backfillChannelMessages } from '../services/messageBackfill'
import {
  closeShadowTicket,
  ensureShadowTicket,
  parseTicketToolCategoryIds,
} from '../services/ticketToolIngest'
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
      externalSource: tickets.externalSource,
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

    // Pass 1 — orphan scan. TicketTool tickets are never orphaned: a missing
    // channel means TicketTool closed/deleted it while we were down, so close
    // the shadow row instead of flagging it for attention.
    if (!channel) {
      if (t.externalSource === 'tickettool') {
        await closeShadowTicket(channelId)
        return
      }
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

  // ---- Pass 4: TicketTool reconcile ---------------------------------------
  // For each business watching TicketTool categories, ingest any channel under
  // those categories that we don't have a row for yet (opened while the bot was
  // down). ensureShadowTicket is idempotent, so already-modeled channels are
  // no-ops. (Closing rows whose channel vanished is handled in Pass 1 above.)
  let ttIngested = 0
  const watchingBiz = (await db.select().from(businesses)).filter(
    (b) => parseTicketToolCategoryIds(b).length > 0,
  )
  for (const biz of watchingBiz) {
    const guild = await client.guilds.fetch(biz.discordGuildId).catch(() => null)
    if (!guild) continue
    const catIds = new Set(parseTicketToolCategoryIds(biz))
    const channels = await guild.channels.fetch().catch(() => null)
    if (!channels) continue
    for (const channel of channels.values()) {
      if (!channel || channel.type !== ChannelType.GuildText) continue
      if (!channel.parentId || !catIds.has(channel.parentId)) continue
      try {
        const id = await ensureShadowTicket(channel as TextChannel, biz)
        if (id != null) ttIngested++
      } catch (err) {
        log.warn('startup resync: tickettool ingest failed', { channelId: channel.id, err: String(err) })
      }
    }
  }

  log.info('startup resync: done', {
    ms: Date.now() - started,
    openTickets: openTickets.length,
    orphans,
    backfilledMessages: backfilled,
    missingPanels,
    ticketToolReconciled: ttIngested,
  })
}
