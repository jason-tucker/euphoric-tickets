import type { Client } from 'discord.js'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets, businesses, botErrors } from '../db/schema'
import { log } from '../services/logger'

// Phase B2 — scheduled cleanup of closed tickets whose Discord channels
// are older than the per-business `delete_closed_after_days` setting.
//
// Runs hourly. For each match: tries to delete the Discord channel via
// the bot, then nulls the four discord_* columns on the row (DB row +
// ticket_messages stay so the transcript survives).

const RUN_INTERVAL_MS = 60 * 60 * 1000 // 1h

let timer: NodeJS.Timeout | null = null

export function startScheduledCleanup(client: Client): void {
  if (timer) return
  // Kick once on boot (with a short delay so login finishes), then hourly.
  setTimeout(() => { void sweep(client) }, 30_000)
  timer = setInterval(() => { void sweep(client) }, RUN_INTERVAL_MS)
  timer.unref()
}

export function stopScheduledCleanup(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function sweep(client: Client): Promise<void> {
  // P12: drop persisted errors older than 5 days. Independent of the channel
  // cleanup below so one failing doesn't skip the other.
  try {
    await db.delete(botErrors).where(sql`${botErrors.createdAt} < now() - interval '5 days'`)
  } catch (err) {
    log.warn('bot_errors retention sweep failed', { err: String(err) })
  }

  try {
    // Pull every closed ticket with a still-attached channel and a
    // configured horizon on its host business. The `delete_closed_after_days
    // IS NOT NULL` filter scopes to businesses opted in.
    const candidates = await db
      .select({
        ticketId: tickets.id,
        discordChannelId: tickets.discordChannelId,
        closedAt: tickets.closedAt,
        retentionDays: businesses.deleteClosedAfterDays,
      })
      .from(tickets)
      .innerJoin(businesses, eq(businesses.id, tickets.businessId))
      .where(
        and(
          eq(tickets.status, 'closed'),
          isNotNull(tickets.discordChannelId),
          isNotNull(businesses.deleteClosedAfterDays),
          isNotNull(tickets.closedAt),
          sql`${tickets.closedAt} < now() - make_interval(days => ${businesses.deleteClosedAfterDays})`,
        ),
      )
      .limit(50) // cap per sweep

    if (candidates.length === 0) return
    log.info(`Scheduled cleanup: ${candidates.length} channel(s) eligible for deletion`)

    for (const c of candidates) {
      if (!c.discordChannelId) continue
      try {
        const ch = await client.channels.fetch(c.discordChannelId).catch(() => null)
        if (ch && 'delete' in ch && typeof ch.delete === 'function') {
          await ch.delete(`Auto-delete: closed > ${c.retentionDays} days`)
        }
      } catch (err) {
        // 404 = already gone — that's fine; we still null the columns.
        log.warn('Cleanup channel delete failed', {
          ticketId: c.ticketId,
          channelId: c.discordChannelId,
          err: String(err),
        })
      }
      // Null all four Discord-link fields so the row no longer claims it.
      await db
        .update(tickets)
        .set({
          discordChannelId: null,
          discordWebhookId: null,
          discordWebhookUrl: null,
          discordInternalThreadId: null,
        })
        .where(eq(tickets.id, c.ticketId))
    }
  } catch (err) {
    log.error('Scheduled cleanup sweep failed', { err: String(err) })
  }
}
