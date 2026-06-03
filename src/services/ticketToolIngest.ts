import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets, ticketMessages } from '../db/schema'
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
  if (business.ticketMode !== 'tickettool') return false
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

  // Adopt TicketTool's private notes thread (if one exists already) as the
  // ticket's internal-notes thread.
  try {
    const active = await channel.threads.fetchActive()
    const priv = active.threads.find((th) => th.type === ChannelType.PrivateThread)
    if (priv) await linkInternalThread(priv)
  } catch (err) {
    log.warn('tickettool: notes-thread link on ingest failed', { ticketId, err: String(err) })
  }

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

// Scan a business's watched TicketTool categories and ingest every channel
// under them that we don't have a row for yet — i.e. back-grab already-open
// TicketTool tickets. Idempotent (ensureShadowTicket dedupes), so safe to call
// repeatedly. Used by the startup reconcile AND on-demand when an admin links a
// category (so existing open tickets appear without waiting for a restart or a
// new message). Returns the number of channels matched under watched categories.
export async function reconcileBusinessTicketTool(client: Client, business: Business): Promise<number> {
  if (business.ticketMode !== 'tickettool') return 0
  const catIds = new Set(parseTicketToolCategoryIds(business))
  if (catIds.size === 0) return 0

  const guild = await client.guilds.fetch(business.discordGuildId).catch(() => null)
  if (!guild) return 0
  const channels = await guild.channels.fetch().catch(() => null)
  if (!channels) return 0

  let matched = 0
  for (const channel of channels.values()) {
    if (!channel || channel.type !== ChannelType.GuildText) continue
    if (!channel.parentId || !catIds.has(channel.parentId)) continue
    try {
      const id = await ensureShadowTicket(channel as TextChannel, business)
      if (id != null) matched++
    } catch (err) {
      log.warn('tickettool: reconcile ingest failed', { channelId: channel.id, err: String(err) })
    }
  }
  return matched
}

// Detect a TicketTool close/reopen from a message's text (content + flattened
// embeds). TicketTool posts "Ticket Closed by @X" on close and a reopened
// message on reopen (both customizable, but these match the defaults). We check
// reopen first since "reopened" contains "opened". Returns null for anything
// else — notably TicketTool's "…close this ticket?" confirm prompt, which
// contains "close" but not "ticket closed".
export function ticketToolStatusSignal(text: string): 'close' | 'reopen' | null {
  if (/re-?opened/i.test(text) || /ticket\s+(re)?opened/i.test(text)) return 'reopen'
  if (/ticket\s+closed/i.test(text) || /closed\s+the\s+ticket/i.test(text)) return 'close'
  return null
}

// Apply a detected close/reopen to a shadow ticket. Idempotent: reads current
// status and only transitions (+ writes the audit row that renders as the
// red/green inline status event on the web) when it actually changes — so the
// live relay and the reprocess scan can both call it without double-logging.
export async function applyTicketToolStatus(opts: {
  ticketId: number
  businessId: string
  signal: 'close' | 'reopen'
  actorUserId?: string | null
}): Promise<boolean> {
  const [cur] = await db
    .select({ status: tickets.status })
    .from(tickets)
    .where(eq(tickets.id, opts.ticketId))
    .limit(1)
  if (!cur) return false
  if (opts.signal === 'close' && cur.status === 'closed') return false
  if (opts.signal === 'reopen' && cur.status !== 'closed') return false

  if (opts.signal === 'close') {
    await db
      .update(tickets)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedByUserId: opts.actorUserId ?? null,
        lastActivityAt: new Date(),
      })
      .where(eq(tickets.id, opts.ticketId))
  } else {
    await db
      .update(tickets)
      .set({ status: 'open', closedAt: null, closedByUserId: null, lastActivityAt: new Date() })
      .where(eq(tickets.id, opts.ticketId))
  }
  await writeAudit({
    businessId: opts.businessId,
    ticketId: opts.ticketId,
    actorUserId: opts.actorUserId ?? null,
    action: opts.signal === 'close' ? 'closed' : 'reopened',
    metadata: { via: 'tickettool' },
  })
  return true
}

// One-off maintenance: re-pull embed content for already-ingested TicketTool
// tickets. Tickets ingested before v0.5.28 either dropped embed-only messages
// (old backfill skipped them) or stored them as "(no text)" (old live relay).
// For each TicketTool ticket we delete the "(no text)" placeholder rows and
// re-run the current backfill, which now flattens embeds into the body and no
// longer skips embed-only messages. Idempotent + safe to re-run. Returns how
// many tickets were touched and how many message rows were re-inserted.
export async function reprocessTicketToolEmbeds(
  client: Client,
  opts: { businessId?: string } = {},
): Promise<{ tickets: number; reinserted: number }> {
  const rows = await db
    .select({
      id: tickets.id,
      businessId: tickets.businessId,
      channelId: tickets.discordChannelId,
      internalThreadId: tickets.discordInternalThreadId,
    })
    .from(tickets)
    .where(
      opts.businessId
        ? and(eq(tickets.externalSource, 'tickettool'), eq(tickets.businessId, opts.businessId))
        : eq(tickets.externalSource, 'tickettool'),
    )

  let processed = 0
  let reinserted = 0
  for (const row of rows) {
    if (!row.channelId) continue
    processed++

    // Drop placeholder rows so the new backfill re-inserts them with embed text;
    // genuinely-empty messages simply won't come back.
    await db
      .delete(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, row.id), eq(ticketMessages.body, '(no text)')))

    const channel = await client.channels.fetch(row.channelId).catch(() => null)
    if (channel && channel.type === ChannelType.GuildText) {
      reinserted += await backfillChannelMessages(channel as TextChannel, row.id, { limit: 100 }).catch(
        () => 0,
      )
    }
    if (row.internalThreadId) {
      const thread = await client.channels.fetch(row.internalThreadId).catch(() => null)
      if (
        thread &&
        (thread.type === ChannelType.PrivateThread || thread.type === ChannelType.PublicThread)
      ) {
        reinserted += await backfillChannelMessages(thread as ThreadChannel, row.id, {
          limit: 100,
          source: 'internal',
        }).catch(() => 0)
      }
    }

    // Reconcile open/closed status from the most recent TicketTool close/reopen
    // message now in the archive. applyTicketToolStatus is idempotent, so this
    // only transitions (and logs) when the current status is wrong.
    const recent = await db
      .select({ body: ticketMessages.body })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, row.id))
      .orderBy(desc(ticketMessages.createdAt))
      .limit(40)
    for (const m of recent) {
      const signal = ticketToolStatusSignal(m.body)
      if (!signal) continue
      const actorDiscordId = m.body.match(/<@!?(\d+)>/)?.[1]
      const actorUserId = actorDiscordId ? await getOrCreateUserByDiscordId(actorDiscordId) : null
      await applyTicketToolStatus({ ticketId: row.id, businessId: row.businessId, signal, actorUserId })
      break // first match is the latest status-changing message
    }
  }
  log.info('tickettool: reprocessed embeds', { tickets: processed, reinserted })
  return { tickets: processed, reinserted }
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

// TicketTool creates its own private thread for staff notes. Rather than have
// euphoric create a second thread, adopt TicketTool's: set it as the ticket's
// internal-notes thread so the relay ingests its messages as internal notes and
// the web posts staff notes into it. Best-effort — needs the bot to be able to
// see the private thread (Manage Threads). No-op for non-TicketTool channels or
// when a thread is already linked.
export async function linkInternalThread(thread: ThreadChannel): Promise<void> {
  if (thread.type !== ChannelType.PrivateThread) return
  const parentId = thread.parentId
  if (!parentId) return

  const [row] = await db
    .select({ id: tickets.id, internalThreadId: tickets.discordInternalThreadId })
    .from(tickets)
    .where(and(eq(tickets.discordChannelId, parentId), eq(tickets.externalSource, 'tickettool')))
    .limit(1)
  if (!row || row.internalThreadId) return

  await db
    .update(tickets)
    .set({ discordInternalThreadId: thread.id })
    .where(eq(tickets.id, row.id))
  await backfillChannelMessages(thread, row.id, { source: 'internal', limit: 100 }).catch((err) => {
    log.warn('tickettool: internal-thread backfill failed', { ticketId: row.id, err: String(err) })
    return 0
  })
  log.info('tickettool: linked TicketTool notes thread as internal', {
    ticketId: row.id,
    threadId: thread.id,
  })
}
