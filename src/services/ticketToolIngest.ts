import { OverwriteType, PermissionFlagsBits, type TextChannel } from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets } from '../db/schema'
import { type Business } from '../db/schema/businesses'
import { getOrCreateUserByDiscordId } from './userResolver'
import { backfillChannelMessages } from './messageBackfill'
import { getBusinessByGuildId } from './businessResolver'
import { writeAudit } from './audit'
import { log } from './logger'

// TicketTool coexistence (read/ingest side). The third-party TicketTool bot
// opens private ticket channels under specific Discord categories. When a
// channel appears under one of a business's watched categories we create a
// "shadow" tickets row keyed by the channel id (external_source='tickettool').
// The existing messageCreate relay then ingests all of that channel's messages
// for free (it maps message → ticket by discord_channel_id), and a webhook on
// the channel lets the web post two-way replies. euphoric never owns or deletes
// the channel — TicketTool stays in charge of it.

export function parseTicketToolCategoryIds(business: Business): string[] {
  return business.ticketToolCategoryIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isWatchedTicketToolChannel(
  business: Business,
  channel: { parentId: string | null },
): boolean {
  if (!channel.parentId) return false
  return parseTicketToolCategoryIds(business).includes(channel.parentId)
}

// Resolve the ticket opener for a TicketTool channel → users.id (uuid), or null
// to DEFER row creation (we retry on the next message via the relay's lazy
// hook). Order: (1) the single human member permission-overwrite TicketTool
// grants the opener; (2) the @mention in TicketTool's welcome message; (3) the
// first human author.
async function resolveExternalOpener(channel: TextChannel): Promise<string | null> {
  const botId = channel.client.user?.id

  // 1. Member permission overwrites that grant ViewChannel, minus the bot(s).
  const memberOverwrites = [...channel.permissionOverwrites.cache.values()].filter(
    (o) => o.type === OverwriteType.Member && o.allow.has(PermissionFlagsBits.ViewChannel),
  )
  for (const o of memberOverwrites) {
    if (o.id === botId) continue
    const member = await channel.guild.members.fetch(o.id).catch(() => null)
    if (!member || member.user.bot) continue
    return getOrCreateUserByDiscordId(member.id, {
      name: member.user.globalName ?? member.user.username,
      image: member.user.displayAvatarURL(),
    })
  }

  // 2/3. Scan the earliest messages: a bot-authored welcome that @mentions a
  // human, else the first human author.
  try {
    const fetched = await channel.messages.fetch({ limit: 10 })
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    for (const msg of ordered) {
      if (!msg.author.bot) continue
      const mentioned = msg.mentions.users.find((u) => !u.bot)
      if (mentioned) {
        return getOrCreateUserByDiscordId(mentioned.id, {
          name: mentioned.globalName ?? mentioned.username,
          image: mentioned.displayAvatarURL(),
        })
      }
    }
    for (const msg of ordered) {
      if (msg.author.bot) continue
      return getOrCreateUserByDiscordId(msg.author.id, {
        name: msg.author.globalName ?? msg.author.username,
        image: msg.author.displayAvatarURL(),
      })
    }
  } catch (err) {
    log.warn('tickettool: opener resolution fetch failed', { channelId: channel.id, err: String(err) })
  }
  return null
}

// Idempotent: create the shadow ticket for a TicketTool channel if it doesn't
// exist yet. Returns the ticket id, or null when the channel isn't watched / no
// business / opener not yet resolvable (caller retries later).
export async function ensureShadowTicket(
  channel: TextChannel,
  business?: Business | null,
): Promise<number | null> {
  const biz = business ?? (await getBusinessByGuildId(channel.guildId))
  if (!biz) return null
  if (!isWatchedTicketToolChannel(biz, channel)) return null

  const [existing] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.discordChannelId, channel.id))
    .limit(1)
  if (existing) return existing.id

  const openerUserId = await resolveExternalOpener(channel)
  if (!openerUserId) return null // defer — retried on the next message

  const subject = `#${channel.name}`.slice(0, 120)
  let ticketId: number
  try {
    const [row] = await db
      .insert(tickets)
      .values({
        businessId: biz.id,
        openerUserId,
        subject,
        status: 'open',
        externalSource: 'tickettool',
        discordChannelId: channel.id,
        lastActivityAt: new Date(),
      })
      .returning({ id: tickets.id })
    ticketId = row.id
  } catch (err) {
    // Lost a create race with the lazy messageCreate path — re-select.
    const [r] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.discordChannelId, channel.id))
      .limit(1)
    if (r) return r.id
    log.warn('tickettool: shadow insert failed', { channelId: channel.id, err: String(err) })
    return null
  }

  // Best-effort webhook so the web can post user-spoofed replies into the
  // TicketTool channel. Needs Manage Webhooks; falls back to bot-sent replies.
  try {
    const wh = await channel.createWebhook({ name: `ticket-${ticketId}` })
    await db
      .update(tickets)
      .set({ discordWebhookId: wh.id, discordWebhookUrl: wh.url })
      .where(eq(tickets.id, ticketId))
  } catch (err) {
    log.warn('tickettool: webhook create failed (web replies fall back)', {
      ticketId,
      err: String(err),
    })
  }

  await backfillChannelMessages(channel, ticketId, { limit: 100 }).catch((err) => {
    log.warn('tickettool: backfill failed', { ticketId, err: String(err) })
    return 0
  })

  await writeAudit({
    businessId: biz.id,
    ticketId,
    actorUserId: openerUserId,
    action: 'opened',
    metadata: { via: 'tickettool' },
  })
  log.info('tickettool: ingested ticket', { ticketId, channelId: channel.id })
  return ticketId
}

// Mark a TicketTool shadow ticket closed because its channel was deleted
// (TicketTool closed/deleted it). DB-only — never touches Discord. The webhook
// died with the channel, so we clear it.
export async function closeShadowTicket(channelId: string): Promise<void> {
  const [row] = await db
    .select({ id: tickets.id, businessId: tickets.businessId, status: tickets.status })
    .from(tickets)
    .where(and(eq(tickets.discordChannelId, channelId), eq(tickets.externalSource, 'tickettool')))
    .limit(1)
  if (!row || row.status === 'closed') return

  await db
    .update(tickets)
    .set({
      status: 'closed',
      closedAt: new Date(),
      discordWebhookId: null,
      discordWebhookUrl: null,
      lastActivityAt: new Date(),
    })
    .where(eq(tickets.id, row.id))

  await writeAudit({
    businessId: row.businessId,
    ticketId: row.id,
    actorUserId: null,
    action: 'closed',
    metadata: { via: 'tickettool' },
  })
  log.info('tickettool: closed ingested ticket (channel gone)', { ticketId: row.id, channelId })
}
