import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js'
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { env } from '../config/env'
import { db } from '../db/client'
import { tickets, type IntegrationCard, type Ticket } from '../db/schema/tickets'
import { integrationOpenClaims } from '../db/schema/integrationOpenClaims'
import { ticketCategories, type TicketCategory } from '../db/schema/ticketCategories'
import { getBusinessByGuildId } from './businessResolver'
import { getOrCreateUserByDiscordId, getDiscordIdForUserId } from './userResolver'
import { buildTicketWelcome, renderFirstMessage } from './ticketRenderer'
import { fetchAllMessages, renderTranscriptHtml } from './transcriptService'
import { logTicketEvent } from './ticketLogger'
import { log } from './logger'
import { canOpenCategory, staffRoleIdsForCategory } from './permissions'
import { postTicketStatus } from './ticketStatus'
import { dispatchNotify } from './notifyBridge'
import { writeAudit } from './audit'

type ResolvedBusiness = NonNullable<Awaited<ReturnType<typeof getBusinessByGuildId>>>

// Why an open was refused, for callers that map refusals onto status codes
// (the integration route). Panel/slash callers just show `reason`.
export type OpenFailureCode =
  | 'not_configured'
  | 'category_forbidden'
  | 'no_parent_category'
  | 'duplicate'
  | 'insert_failed'

export type OpenResult =
  | { ok: true; channel: TextChannel; ticket: Ticket }
  | { ok: false; reason: string; code: OpenFailureCode }

// The integration a ticket is opened on behalf of (Integration API). The web
// authenticates the API key; the bot trusts it only via x-internal-token.
export type IntegrationIdentity = { id: string; slug: string; name: string }

const NOT_CONFIGURED =
  'This server is not configured as a team — ask an admin to create one at https://tickets.euphoric.fm/admin.'

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export async function openTicket(opts: {
  guild: Guild
  opener: GuildMember
  categoryKey: string
  // The team to open under. Passed by the panel button (panels are per-team) so
  // a multi-team guild opens under the panel's team; falls back to the guild's
  // default team when omitted. The integration route ALWAYS passes it (by id —
  // never resolved from the guild, which several teams can share).
  business?: ResolvedBusiness
  // ── Integration API options. All default to today's panel behaviour. ──
  // 'integration' is the only source allowed into integration_only categories.
  source?: 'bot' | 'integration'
  integration?: IntegrationIdentity
  // Replaces the default `${categoryKey} from ${username}` subject.
  subject?: string
  card?: IntegrationCard | null
  externalRef?: string
  // Integration tickets may stack (one per external ref) — skip the
  // one-open-ticket-per-(opener, category) dedupe.
  skipOpenerDedupe?: boolean
  // Skip the category's allow_role_ids gate (integration_only categories:
  // the integration, not the opener's roles, decides who may open).
  bypassAllowRoles?: boolean
}): Promise<OpenResult> {
  const { guild, opener, categoryKey } = opts
  const isIntegration = opts.source === 'integration'
  if (isIntegration && (!opts.integration || !opts.externalRef)) {
    throw new Error('openTicket: integration source requires integration + externalRef')
  }

  const business = opts.business ?? (await getBusinessByGuildId(guild.id))
  if (!business) return { ok: false, reason: NOT_CONFIGURED, code: 'not_configured' }
  // TicketTool-mode teams don't open tickets through euphoric — they're opened
  // in TicketTool (which euphoric then ingests + controls).
  if (business.ticketMode === 'tickettool') {
    return {
      ok: false,
      reason: 'This server uses TicketTool — open your ticket from its panel.',
      code: 'category_forbidden',
    }
  }

  const catRows = await db
    .select()
    .from(ticketCategories)
    .where(and(eq(ticketCategories.businessId, business.id), eq(ticketCategories.key, categoryKey)))
    .limit(1)
  const cat = catRows[0]
  if (!cat) {
    return { ok: false, reason: 'Unknown ticket category. The panel may be out of date.', code: 'category_forbidden' }
  }

  // Staff-only destinations never open fresh tickets — they exist only as
  // move-into targets. If a stale panel still has this button, refuse.
  if (cat.staffOnly) {
    return {
      ok: false,
      reason: `**${cat.label}** is a staff-only destination — tickets can only be moved into it, not opened directly. The panel may be out of date.`,
      code: 'category_forbidden',
    }
  }

  // Integration-only categories are opened exclusively through the Integration
  // API. Panel buttons (including stale panels posted before the flag was set)
  // and every slash path are refused.
  if (cat.integrationOnly && !isIntegration) {
    return {
      ok: false,
      reason: `**${cat.label}** tickets can't be opened from Discord — they're created by an integration. The panel may be out of date.`,
      code: 'category_forbidden',
    }
  }

  // P2: per-category open-gate. Empty allow_role_ids = anyone may open.
  if (!opts.bypassAllowRoles && !canOpenCategory(opener, business, cat)) {
    return {
      ok: false,
      reason: `You don't have access to open a **${cat.label}** ticket. Ask an admin if you think you should.`,
      code: 'category_forbidden',
    }
  }

  const parentCategoryId = cat.discordParentCategoryId ?? business.discordFallbackCategoryId
  if (!parentCategoryId) {
    return {
      ok: false,
      reason:
        'No Discord category configured for ticket channels. Ask an admin to set one in the web settings or per-category override.',
      code: 'no_parent_category',
    }
  }

  const parentCat = await guild.channels.fetch(parentCategoryId).catch(() => null)
  if (!parentCat || parentCat.type !== ChannelType.GuildCategory) {
    return {
      ok: false,
      reason: 'Configured Discord category no longer exists. Ask an admin to fix it on the web.',
      code: 'no_parent_category',
    }
  }

  // P2: per-category override wins; falls back to businesses.admin_role_ids
  // when the category has none. Drives the channel ACLs below + the
  // welcome card's staff @ ping.
  const staffRoleIds = staffRoleIdsForCategory(business, cat)

  const openerUserId = await getOrCreateUserByDiscordId(opener.id, {
    name: opener.user.globalName ?? opener.user.username,
    image: opener.user.displayAvatarURL(),
  })

  // Dedupe by (business, opener, category, status='open').
  if (!opts.skipOpenerDedupe) {
    const existing = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.businessId, business.id), eq(tickets.openerUserId, openerUserId)))
    const stillOpen = existing.find(
      (t) => t.status !== 'closed' && t.categoryId === cat.id,
    )
    if (stillOpen && stillOpen.discordChannelId) {
      const ch = await guild.channels.fetch(stillOpen.discordChannelId).catch(() => null)
      if (ch) {
        return {
          ok: false,
          reason: `You already have an open ticket in this category: <#${stillOpen.discordChannelId}>`,
          code: 'duplicate',
        }
      }
      // Channel was deleted out from under us — auto-close the row.
      await db
        .update(tickets)
        .set({ status: 'closed', closedAt: new Date(), lastActivityAt: new Date() })
        .where(eq(tickets.id, stillOpen.id))
    }
  }

  const safeName = opener.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user'
  const baseName = `ticket-${safeName}`

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: opener.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...staffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    })),
  ]

  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildText,
    parent: parentCat.id,
    permissionOverwrites,
    topic: `Ticket for ${opener.user.tag} · category: ${cat.label}`,
  })

  // Integration opens: record the channel on the open-claim IMMEDIATELY, before
  // the ticket insert. If the process dies between here and the insert, the
  // next open of this ref finds the orphan channel via the claim and deletes it.
  if (isIntegration) {
    await db
      .update(integrationOpenClaims)
      .set({ channelId: channel.id, updatedAt: sql`now()` })
      .where(
        and(
          eq(integrationOpenClaims.integrationId, opts.integration!.id),
          eq(integrationOpenClaims.externalRef, opts.externalRef!),
        ),
      )
  }

  const subject = truncate(opts.subject?.trim() || `${categoryKey} from ${opener.user.username}`, 120)
  const card = opts.card ?? null
  let row: Ticket
  try {
    ;[row] = await db
      .insert(tickets)
      .values({
        businessId: business.id,
        openerUserId,
        categoryId: cat.id,
        subject,
        status: 'open',
        // Pick up the category's configured kind ('normal' | 'project').
        // Categories default to 'normal' so existing categories keep their
        // current behaviour after the schema migration.
        kind: cat.kind,
        discordChannelId: channel.id,
        lastActivityAt: new Date(),
        ...(isIntegration
          ? { integrationId: opts.integration!.id, externalRef: opts.externalRef!, integrationCard: card }
          : {}),
      })
      .returning()
  } catch (err) {
    if (!isIntegration) throw err
    // Integration opens clean up after themselves: no ticket row → no channel.
    // (The caller marks the claim failed so the next attempt can take over.)
    log.error('integration open: ticket insert failed — deleting channel', {
      channelId: channel.id,
      integration: opts.integration!.slug,
      externalRef: opts.externalRef,
      err: String(err),
    })
    await channel.delete('Ticket insert failed').catch(() => {})
    return { ok: false, reason: 'Ticket insert failed.', code: 'insert_failed' }
  }

  await channel.setName(`ticket-${row.id}-${safeName}`).catch(() => {})

  // Integration tickets ALWAYS get a channel webhook (the web posts integration
  // messages through it). Mandatory but non-fatal: on failure it stays null and
  // the web retries through /api/internal/tickets/webhook/ensure.
  if (isIntegration) {
    const url = await ensureTicketWebhook(channel, row.id).catch((err) => {
      log.warn('integration open: webhook create failed (web will retry via /webhook/ensure)', {
        ticketId: row.id,
        err: String(err),
      })
      return null
    })
    if (url) row = { ...row, discordWebhookUrl: url }
  }

  // P4: per-category custom first message (placeholders substituted), else
  // the default body inside buildTicketWelcome.
  const firstMessage = cat.firstMessageTemplate
    ? renderFirstMessage(cat.firstMessageTemplate, {
        userId: opener.id,
        ticketId: row.id,
        subject,
        category: cat.label,
      })
    : null

  const welcome = buildTicketWelcome({
    ticketId: row.id,
    openerId: opener.id,
    categoryLabel: cat.label,
    categoryEmoji: cat.emoji,
    subject,
    openedAt: row.openedAt,
    staffRoleIds,
    claimerId: null,
    firstMessage,
    webUrl: `${env.WEB_BASE_URL}/b/${business.slug}/tickets/${row.id}`,
    card,
  })

  const pingContent = staffRoleIds.length
    ? `<@${opener.id}> ${staffRoleIds.map((id) => `<@&${id}>`).join(' ')}`
    : `<@${opener.id}>`
  await channel.send({
    content: pingContent,
    allowedMentions: { users: [opener.id], roles: staffRoleIds },
  })
  // parse:[] so the card body's {{user}} mention renders without re-pinging.
  await channel.send({ ...(welcome as any), allowedMentions: { parse: [] } })

  void logTicketEvent({
    guild,
    kind: 'open',
    ticketId: row.id,
    fields: {
      Opener: `<@${opener.id}>`,
      Category: cat.label,
      Channel: `<#${channel.id}>`,
    },
  })

  // P13: notify staff who opted into new tickets in this team/category.
  const openerUserIdForNotify = await getOrCreateUserByDiscordId(opener.id, {
    name: opener.user.globalName ?? opener.user.username,
    image: opener.user.displayAvatarURL(),
  })
  dispatchNotify({
    event: 'new_ticket',
    businessId: business.id,
    categoryId: cat.id,
    ticketId: row.id,
    subject,
    slug: business.slug,
    actorUserId: openerUserIdForNotify,
  })

  // Lifecycle audit — pairs with the web's writeAudit calls so the merged
  // conversation/log view sees panel-button opens too.
  await writeAudit({
    businessId: business.id,
    ticketId: row.id,
    actorUserId: openerUserId,
    action: 'opened',
    metadata: isIntegration
      ? {
          via: `integration:${opts.integration!.slug}`,
          integrationId: opts.integration!.id,
          externalRef: opts.externalRef,
          categoryId: cat.id,
          categoryLabel: cat.label,
        }
      : { via: 'bot', categoryId: cat.id, categoryLabel: cat.label },
  })

  return { ok: true, channel, ticket: row }
}

// Advisory-lock namespace for ensureTicketWebhook: the two-int4 key
// (WEBHOOK_LOCK_NS, ticketId). 0x45545748 = 'ETWH'. Distinct from the web
// dispatcher's (1163152177, 1) and the bot leader's single-bigint key.
const WEBHOOK_LOCK_NS = 0x45545748

// Integration API: make sure the ticket's channel has a webhook and it's
// persisted on the ticket. Idempotent and race-safe: callers for the same
// ticket are SERIALIZED with pg_advisory_xact_lock(WEBHOOK_LOCK_NS, ticketId)
// around read → fetch/create → persist, so only one of them ever creates a
// webhook and the rest read the persisted URL once the lock is released (the
// lock is DB-wide, so it also serializes across processes). A bot-owned
// `ticket-<id>` webhook left by a crashed attempt is reused. Returns the
// persisted webhook URL.
export async function ensureTicketWebhook(channel: TextChannel, ticketId: number): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${WEBHOOK_LOCK_NS}::int4, ${ticketId}::int4)`)

    const [current] = await tx
      .select({ url: tickets.discordWebhookUrl })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1)
    if (current?.url) return current.url

    const name = `ticket-${ticketId}`
    const botId = channel.client?.user?.id
    const existing = await channel
      .fetchWebhooks()
      .then((hooks) => hooks.find((w) => w.name === name && Boolean(w.token) && (!botId || w.owner?.id === botId)))
      .catch(() => undefined)
    const created = !existing
    const wh = existing ?? (await channel.createWebhook({ name }))

    const [won] = await tx
      .update(tickets)
      .set({ discordWebhookId: wh.id, discordWebhookUrl: wh.url })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.discordWebhookUrl)))
      .returning({ url: tickets.discordWebhookUrl })
    if (won?.url) return won.url

    // Lost the persist anyway — only possible if something outside this lock
    // wrote the URL meanwhile. Re-read FIRST and delete our webhook only when we
    // created it AND the persisted one is a different webhook: the persisted
    // one may be the very webhook we created (reused by that writer), and
    // deleting it would leave the ticket pointing at a dead hook.
    const [after] = await tx
      .select({ id: tickets.discordWebhookId, url: tickets.discordWebhookUrl })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1)
    if (created && after?.id !== wh.id) await wh.delete('Duplicate ticket webhook').catch(() => {})
    if (!after?.url) throw new Error('ticket webhook vanished after concurrent ensure')
    return after.url
  })
}

export async function claimTicket(opts: {
  ticket: Ticket
  claimer: GuildMember
}): Promise<{ ok: true; updated: Ticket } | { ok: false; reason: string }> {
  const { ticket, claimer } = opts
  if (ticket.status === 'closed') return { ok: false, reason: 'This ticket is already closed.' }
  if (ticket.assigneeUserId) {
    const assigneeDiscordId = await getDiscordIdForUserId(ticket.assigneeUserId)
    return {
      ok: false,
      reason: assigneeDiscordId
        ? `Already claimed by <@${assigneeDiscordId}>.`
        : 'Already claimed.',
    }
  }

  const claimerUserId = await getOrCreateUserByDiscordId(claimer.id, {
    name: claimer.user.globalName ?? claimer.user.username,
    image: claimer.user.displayAvatarURL(),
  })

  const [updated] = await db
    .update(tickets)
    .set({ status: 'in_progress', assigneeUserId: claimerUserId, lastActivityAt: new Date() })
    .where(eq(tickets.id, ticket.id))
    .returning()

  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)

  // Silent subtext footer in the ticket channel.
  if (ticket.discordChannelId) {
    const ch = await claimer.guild.channels.fetch(ticket.discordChannelId).catch(() => null)
    if (ch?.isTextBased()) await postTicketStatus(ch as TextChannel, `Ticket claimed by <@${claimer.id}>`)
  }

  void logTicketEvent({
    guild: claimer.guild,
    kind: 'claim',
    ticketId: ticket.id,
    fields: {
      Claimer: `<@${claimer.id}>`,
      Opener: openerDiscordId ? `<@${openerDiscordId}>` : '_(unknown)_',
      Channel: ticket.discordChannelId ? `<#${ticket.discordChannelId}>` : '_(no channel)_',
    },
  })

  await writeAudit({
    businessId: ticket.businessId,
    ticketId: ticket.id,
    actorUserId: claimerUserId,
    action: 'claimed',
  })

  return { ok: true, updated }
}

// P5: move a ticket to a different category. Updates the DB, best-effort
// moves the Discord channel under the new parent category, and grants the new
// category's staff roles channel access (additive — existing members keep
// theirs). Posts a silent status footer. Admin-gated by the caller.
export async function changeTicketCategory(opts: {
  guild: Guild
  channel: TextChannel
  ticket: Ticket
  newCategory: TicketCategory
  business: ResolvedBusiness
  actorId: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { guild, channel, ticket, newCategory, business, actorId } = opts

  if (ticket.externalSource === 'tickettool') {
    return { ok: false, reason: "euphoric doesn't move TicketTool channels." }
  }
  if (ticket.categoryId === newCategory.id) {
    return { ok: false, reason: `This ticket is already in **${newCategory.label}**.` }
  }

  await db
    .update(tickets)
    .set({ categoryId: newCategory.id, lastActivityAt: new Date() })
    .where(eq(tickets.id, ticket.id))

  // Move the channel under the new parent (per-category → team fallback).
  const parentId = newCategory.discordParentCategoryId ?? business.discordFallbackCategoryId ?? null
  if (parentId) {
    const parent = await guild.channels.fetch(parentId).catch(() => null)
    if (parent && parent.type === ChannelType.GuildCategory) {
      await channel.setParent(parent.id, { lockPermissions: false }).catch((err) => {
        log.warn('changeCategory: setParent failed', { ticketId: ticket.id, err: String(err) })
      })
    }
  }

  // Grant the new category's staff roles (falls back to team admins).
  const staffRoleIds = staffRoleIdsForCategory(business, newCategory)
  for (const roleId of staffRoleIds) {
    await channel.permissionOverwrites
      .edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
        ManageMessages: true,
      })
      .catch((err) => log.warn('changeCategory: overwrite failed', { roleId, err: String(err) }))
  }

  const emoji = newCategory.emoji ? `${newCategory.emoji} ` : ''
  await postTicketStatus(channel, `Ticket category changed to ${emoji}${newCategory.label} by <@${actorId}>`)

  return { ok: true }
}

export async function closeTicket(opts: {
  guild: Guild
  channel: TextChannel
  ticket: Ticket
  closer: GuildMember
  // The ticket's own team — used for the opener's DM web link. Guilds can host
  // several teams, so callers that know it (the integration close route, the
  // close-confirm button) pass it; otherwise it falls back to the guild default.
  business?: ResolvedBusiness | null
  // Optional close reason, included in the opener DM.
  reason?: string
  // Audit attribution; defaults to the bot.
  via?: string
}): Promise<{ ok: true } | { ok: false; reason: string; code?: 'already_closed' | 'tickettool' }> {
  const { guild, channel, ticket, closer } = opts

  if (ticket.status === 'closed') return { ok: false, reason: 'This ticket is already closed.', code: 'already_closed' }
  // Never run euphoric's close flow (which deletes the channel) on a TicketTool
  // ticket — those are closed via TicketTool ($closeRequest). Defensive: covers
  // the close-button path too.
  if (ticket.externalSource === 'tickettool') {
    return { ok: false, reason: 'This is a TicketTool ticket — use Request close instead.', code: 'tickettool' }
  }

  const closerUserId = await getOrCreateUserByDiscordId(closer.id, {
    name: closer.user.globalName ?? closer.user.username,
    image: closer.user.displayAvatarURL(),
  })

  // Conditional on not-yet-closed so two concurrent closes (button + web /
  // integration) can't both run the transcript/DM/delete flow.
  const closedRows = await db
    .update(tickets)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedByUserId: closerUserId,
      lastActivityAt: new Date(),
    })
    .where(and(eq(tickets.id, ticket.id), ne(tickets.status, 'closed')))
    .returning({ id: tickets.id })
  if (closedRows.length === 0) {
    return { ok: false, reason: 'This ticket is already closed.', code: 'already_closed' }
  }

  // Transcript HTML — used for the opener DM. (The transcript channel
  // setting no longer exists on the web schema; we drop posting to a
  // dedicated channel for now. The DM-to-opener path is preserved.)
  try {
    // The transcript fetch (paginated REST) dominates close latency — run the
    // independent lookups alongside it instead of serially after it.
    const [messages, openerDiscordId, categoryLabel, business] = await Promise.all([
      fetchAllMessages(channel),
      getDiscordIdForUserId(ticket.openerUserId),
      loadCategoryLabel(ticket.categoryId),
      opts.business ?? getBusinessByGuildId(guild.id),
    ])
    const opener = openerDiscordId
      ? await guild.members.fetch(openerDiscordId).catch(() => null)
      : null
    const html = renderTranscriptHtml({
      guildName: guild.name,
      channelName: channel.name,
      ticketId: ticket.id,
      openerTag: opener?.user.tag ?? openerDiscordId ?? 'unknown',
      closedByTag: closer.user.tag,
      messages,
    })
    const buf = Buffer.from(html, 'utf8')

    if (opener) {
      const dmFile = new AttachmentBuilder(buf, {
        name: `ticket-${ticket.id}-${channel.name}.html`,
      })
      // Best-effort web link: if the guild isn't tied to a business row, omit it.
      const webLink = business
        ? `${env.WEB_BASE_URL}/b/${business.slug}/tickets/${ticket.id}`
        : null
      const content =
        `Your ticket **#${ticket.id}** in **${guild.name}** was closed by ${closer.user.tag}.` +
        (opts.reason ? `\n\nReason: ${opts.reason.slice(0, 500)}` : '') +
        (webLink ? `\n\nView the conversation on the web: ${webLink}` : '') +
        '\n\nA full transcript is attached.'
      await opener
        .send({ content, files: [dmFile] })
        .catch((err) => {
          log.info('Opener DM failed (likely DMs closed)', {
            ticketId: ticket.id,
            err: String(err),
          })
        })
    }

    void logTicketEvent({
      guild,
      kind: 'close',
      ticketId: ticket.id,
      fields: {
        Closer: `<@${closer.id}>`,
        Opener: openerDiscordId ? `<@${openerDiscordId}>` : '_(unknown)_',
        Category: categoryLabel ?? '_(none)_',
        Duration: `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R> opened`,
      },
    })
  } catch (err) {
    log.error('Transcript generation failed', { ticketId: ticket.id, err: String(err) })
  }

  await channel.delete(`Ticket #${ticket.id} closed by ${closer.user.tag}`).catch((err) => {
    log.warn('Channel delete failed', { ticketId: ticket.id, err: String(err) })
  })

  await writeAudit({
    businessId: ticket.businessId,
    ticketId: ticket.id,
    actorUserId: closerUserId,
    action: 'closed',
    ...(opts.via ? { metadata: { via: opts.via, ...(opts.reason ? { reason: opts.reason.slice(0, 500) } : {}) } } : {}),
  })

  return { ok: true }
}

async function loadCategoryLabel(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null
  const rows = await db
    .select({ label: ticketCategories.label })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1)
  return rows[0]?.label ?? null
}

// Helper for /tickets list and similar lookups that previously sorted by
// openedAt — pulled out so the command files don't need to repeat the
// ordering ceremony.
export async function listOpenTicketsForBusiness(businessId: string) {
  return db
    .select()
    .from(tickets)
    .where(and(eq(tickets.businessId, businessId)))
    .orderBy(desc(tickets.openedAt))
}
