// Integration API (v0.8.0) — the bot half. The web (euphoric-tickets-web)
// authenticates integration API keys, scopes them to one business, validates
// the payload, and then calls these through the internal HTTP bridge
// (src/bot/internalHttp.ts, x-internal-token). The bot never re-checks API
// keys, and it ALWAYS takes the business by id — never from the guild, because
// several teams can share one guild. As defense in depth it re-checks the
// integration binding against the mirrored `integrations` row on every route
// (exists, enabled, same business; open: category key allowlisted;
// close/ensure: the ticket belongs to that integration).
//
// Markdown: subject, card.title, card.lines and the close reason arrive
// ALREADY escaped by the web (escapeDiscordMarkdown at its /api/v1 boundary).
// The bot renders them as received and must never escape them a second time.
//
// Contract: the "Tickets Integration API" §4.4 of the EFM Music Portal plan.

import { ChannelType, type Client, type Guild, type GuildBasedChannel, type GuildMember, type TextChannel } from 'discord.js'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses, type Business } from '../db/schema/businesses'
import { ticketCategories } from '../db/schema/ticketCategories'
import { tickets, type IntegrationCard, type Ticket } from '../db/schema/tickets'
import { integrationOpenClaims } from '../db/schema/integrationOpenClaims'
import { integrations } from '../db/schema/integrations'
import { closeTicket, ensureTicketWebhook, openTicket, type IntegrationIdentity } from './ticketService'
import { isIntegrationActorStaff } from './permissions'
import { LINK_URL_MAX } from './ticketRenderer'
import { getOrCreateUserByDiscordId } from './userResolver'
import { writeAudit } from './audit'
import { log } from './logger'

export type RouteResult = { status: number; body: Record<string, unknown> }

// An `opening` claim younger than this blocks other opens of the same ref
// (409 opening_in_progress); older ones are presumed dead and taken over.
export const CLAIM_STALE_MS = 2 * 60 * 1000

const SNOWFLAKE_RE = /^\d{17,20}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const err = (status: number, error: string): RouteResult => ({ status, body: { error } })

// ───────────────────────────── validation ─────────────────────────────

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

function parseCard(v: unknown): IntegrationCard | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  if (!str(c.title, 100)) return undefined
  const lines = c.lines ?? []
  if (!Array.isArray(lines) || lines.length > 25 || !lines.every((l) => typeof l === 'string' && l.length <= 200)) {
    return undefined
  }
  let link: IntegrationCard['link'] = null
  if (c.link !== undefined && c.link !== null) {
    const l = c.link as Record<string, unknown>
    // Discord rejects link-button URLs over 512 chars (50035) — refuse up front.
    if (typeof l !== 'object' || !str(l.label, 40) || !str(l.url, LINK_URL_MAX)) return undefined
    link = { label: l.label, url: l.url }
  }
  return { title: c.title, lines: lines as string[], link }
}

export type OpenRequest = {
  integrationId: string
  integrationSlug: string
  integrationName: string
  businessId: string
  categoryKey: string
  openerDiscordId: string
  subject: string
  card: IntegrationCard | null
  externalRef: string
}

export function parseOpenRequest(raw: unknown): OpenRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.integrationId !== 'string' || !UUID_RE.test(b.integrationId)) return null
  if (!str(b.integrationSlug, 100) || !str(b.integrationName, 200)) return null
  if (typeof b.businessId !== 'string' || !UUID_RE.test(b.businessId)) return null
  if (!str(b.categoryKey, 100)) return null
  if (typeof b.openerDiscordId !== 'string' || !SNOWFLAKE_RE.test(b.openerDiscordId)) return null
  // Stored exactly as the web sent it, trimmed; blank after trimming → 400
  // (never the silent `<key> from <user>` fallback).
  if (!str(b.subject, 100) || b.subject.trim().length === 0) return null
  if (!str(b.externalRef, 100)) return null
  const card = parseCard(b.card)
  if (card === undefined) return null
  return {
    integrationId: b.integrationId,
    integrationSlug: b.integrationSlug,
    integrationName: b.integrationName,
    businessId: b.businessId,
    categoryKey: b.categoryKey,
    openerDiscordId: b.openerDiscordId,
    subject: b.subject.trim(),
    card,
    externalRef: b.externalRef,
  }
}

// ───────────────────────────── helpers ─────────────────────────────

// Defense in depth on the integration binding. The web already authenticated
// and scoped the key; the bot re-checks the (mirrored, web-owned)
// integrations row so a leaked INTERNAL_TOKEN alone can't act across teams or
// integrations: the integration must exist, be enabled, and belong to the
// business the request names.
// The row is also the ONLY source of the integration's identity (slug, name):
// the open request's integrationSlug / integrationName are ignored.
type BoundIntegration = { id: string; slug: string; name: string; allowedCategoryKeys: string[] }

async function loadBoundIntegration(integrationId: string, businessId: string): Promise<BoundIntegration | null> {
  const [row] = await db
    .select({
      id: integrations.id,
      slug: integrations.slug,
      name: integrations.name,
      businessId: integrations.businessId,
      enabled: integrations.enabled,
      allowedCategoryKeys: integrations.allowedCategoryKeys,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1)
  if (!row || !row.enabled || row.businessId !== businessId) return null
  return { id: row.id, slug: row.slug, name: row.name, allowedCategoryKeys: row.allowedCategoryKeys }
}

// Shared body validation for /close and /webhook/ensure: both carry
// {ticketId, businessId, integrationId}.
function parseTicketRef(b: Record<string, unknown>): { ticketId: number; businessId: string; integrationId: string } | null {
  if (typeof b.ticketId !== 'number' || !Number.isInteger(b.ticketId)) return null
  if (typeof b.businessId !== 'string' || !UUID_RE.test(b.businessId)) return null
  if (typeof b.integrationId !== 'string' || !UUID_RE.test(b.integrationId)) return null
  return { ticketId: b.ticketId, businessId: b.businessId, integrationId: b.integrationId }
}

// The ticket, scoped to (id, business) AND owned by the integration; else null.
async function loadIntegrationTicket(ref: { ticketId: number; businessId: string; integrationId: string }): Promise<Ticket | null> {
  const t = await loadTicket(ref.ticketId, ref.businessId)
  return t && t.integrationId === ref.integrationId ? t : null
}

async function loadBusiness(businessId: string): Promise<Business | null> {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  return b ?? null
}

async function loadTicket(ticketId: number, businessId: string): Promise<Ticket | null> {
  const [t] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.businessId, businessId)))
    .limit(1)
  return t ?? null
}

function availableGuild(client: Client, guildId: string): Guild | null {
  const guild = client.guilds.cache.get(guildId)
  return guild && guild.available !== false ? guild : null
}

// Discord 10003 Unknown Channel — the ONLY error that proves a channel is gone.
function isUnknownChannel(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 10003
}

// Strict channel lookup. `gone` only when Discord says so (10003) or the id
// resolves to something that isn't a text channel (or no id is recorded).
// Everything else — 50001 Missing Access, 5xx, rate limits, network errors —
// is `error`: the channel may well still exist, so callers must not act as if
// it were deleted (they return 503 and leave state untouched for a retry).
export type ChannelLookup = { kind: 'ok'; channel: TextChannel } | { kind: 'gone' } | { kind: 'error'; error: unknown }

export async function lookupTextChannel(guild: Guild, channelId: string | null): Promise<ChannelLookup> {
  if (!channelId) return { kind: 'gone' }
  let ch: GuildBasedChannel | null
  try {
    ch = await guild.channels.fetch(channelId)
  } catch (e) {
    return isUnknownChannel(e) ? { kind: 'gone' } : { kind: 'error', error: e }
  }
  if (!ch) return { kind: 'error', error: new Error('channel fetch returned nothing') }
  return ch.type === ChannelType.GuildText ? { kind: 'ok', channel: ch as TextChannel } : { kind: 'gone' }
}

// Discord: 10007 Unknown Member, 10013 Unknown User.
function isUnknownMember(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 10007 || code === 10013
}

async function setClaim(
  integrationId: string,
  externalRef: string,
  patch: Partial<{ state: 'opening' | 'open' | 'failed'; channelId: string | null; ticketId: number | null }>,
): Promise<void> {
  await db
    .update(integrationOpenClaims)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(integrationOpenClaims.integrationId, integrationId), eq(integrationOpenClaims.externalRef, externalRef)))
}

// Best-effort: the web can always retry through /webhook/ensure.
async function ensureWebhookQuietly(client: Client, business: Business, ticket: Ticket): Promise<void> {
  if (ticket.discordWebhookUrl || ticket.status === 'closed') return
  const guild = availableGuild(client, business.discordGuildId)
  const found = guild ? await lookupTextChannel(guild, ticket.discordChannelId) : null
  if (found?.kind !== 'ok') return
  await ensureTicketWebhook(found.channel, ticket.id).catch((e) =>
    log.warn('integration adopt: webhook ensure failed', { ticketId: ticket.id, err: String(e) }),
  )
}

// ───────────────────────────── open ─────────────────────────────

type ClaimOutcome =
  | { kind: 'owned'; orphanChannelId: string | null }
  | { kind: 'adopt'; ticket: Ticket }
  | { kind: 'busy' }

// Step 1 of the open algorithm: claim (integration_id, external_ref).
async function claimRef(integrationId: string, externalRef: string): Promise<ClaimOutcome> {
  const inserted = await db
    .insert(integrationOpenClaims)
    .values({ integrationId, externalRef, state: 'opening' })
    .onConflictDoNothing()
    .returning({ integrationId: integrationOpenClaims.integrationId })
  if (inserted.length > 0) return { kind: 'owned', orphanChannelId: null }

  // Conflict. (a) A ticket already exists for the ref → adopt it.
  const [existing] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.integrationId, integrationId), eq(tickets.externalRef, externalRef)))
    .limit(1)
  if (existing) return { kind: 'adopt', ticket: existing }

  // (b) Someone is opening it right now (fresh `opening`) → 409.
  // (c) Anything else (`opening` ≥ 2 min = presumed dead, `failed`, or `open`
  //     without a ticket) → take over with a conditional UPDATE. Staleness is
  //     judged by the DB clock so bot/DB clock skew can't matter.
  const staleBefore = sql.raw(`now() - interval '${CLAIM_STALE_MS / 1000} seconds'`)
  const [prev] = await db
    .select({
      channelId: integrationOpenClaims.channelId,
      fresh: sql<boolean>`${integrationOpenClaims.state} = 'opening' and ${integrationOpenClaims.updatedAt} > ${staleBefore}`,
    })
    .from(integrationOpenClaims)
    .where(and(eq(integrationOpenClaims.integrationId, integrationId), eq(integrationOpenClaims.externalRef, externalRef)))
    .limit(1)
  if (!prev) {
    // The claim vanished between the insert and the read (deleted by an
    // operator). Treat as busy; the caller's retry will re-insert.
    return { kind: 'busy' }
  }
  if (prev.fresh) return { kind: 'busy' }

  const [took] = await db
    .update(integrationOpenClaims)
    // channel_id is KEPT until the orphan is actually deleted (below), so a
    // takeover that dies early still leaves the orphan findable.
    .set({ state: 'opening', ticketId: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(integrationOpenClaims.integrationId, integrationId),
        eq(integrationOpenClaims.externalRef, externalRef),
        // Same predicate as above, negated: only a still-stale claim is taken.
        sql`not (${integrationOpenClaims.state} = 'opening' and ${integrationOpenClaims.updatedAt} > ${staleBefore})`,
      ),
    )
    .returning({ integrationId: integrationOpenClaims.integrationId })
  if (!took) return { kind: 'busy' } // another request won the takeover
  return { kind: 'owned', orphanChannelId: prev.channelId }
}

export async function handleIntegrationOpen(client: Client, raw: unknown): Promise<RouteResult> {
  const req = parseOpenRequest(raw)
  if (!req) return err(400, 'validation')

  const bound = await loadBoundIntegration(req.integrationId, req.businessId)
  if (!bound) return err(403, 'integration_forbidden')
  if (!bound.allowedCategoryKeys.includes(req.categoryKey)) return err(403, 'category_forbidden')

  const business = await loadBusiness(req.businessId)
  if (!business) return err(404, 'business_not_found')
  const [category] = await db
    .select()
    .from(ticketCategories)
    .where(and(eq(ticketCategories.businessId, business.id), eq(ticketCategories.key, req.categoryKey)))
    .limit(1)
  if (!category) return err(403, 'category_forbidden')

  // 1. Claim the ref.
  const claim = await claimRef(req.integrationId, req.externalRef)
  if (claim.kind === 'busy') return err(409, 'opening_in_progress')
  if (claim.kind === 'adopt') {
    await setClaim(req.integrationId, req.externalRef, { state: 'open', ticketId: claim.ticket.id })
    // scheduledCleanup / startupResync null discord_channel_id once a channel
    // is gone. There is no channel to report (the web requires a snowflake),
    // so say so explicitly instead of 200 {channelId:null}.
    if (!claim.ticket.discordChannelId) {
      return { status: 409, body: { error: 'ticket_channel_missing', ticketId: claim.ticket.id } }
    }
    await ensureWebhookQuietly(client, business, claim.ticket)
    return { status: 200, body: { ticketId: claim.ticket.id, channelId: claim.ticket.discordChannelId, created: false } }
  }

  // From here we own the claim: every exit must leave it `open` or `failed`.
  const fail = async (result: RouteResult): Promise<RouteResult> => {
    await setClaim(req.integrationId, req.externalRef, { state: 'failed' }).catch(() => {})
    return result
  }

  try {
    // 2. Guild + opener.
    const guild = availableGuild(client, business.discordGuildId)
    if (!guild) return await fail(err(503, 'guild_unavailable'))

    // A takeover inherits the dead attempt's channel (created, never
    // ticketed) — delete it so the retry ends with exactly one channel.
    // claim.channel_id is cleared ONLY once the orphan is provably gone (10003,
    // or our delete succeeded). Any other failure keeps it recorded and fails
    // this attempt with 503: carrying on would overwrite claim.channel_id with
    // the new channel and leak the orphan for good.
    if (claim.orphanChannelId) {
      const orphanId = claim.orphanChannelId
      let gone: boolean
      try {
        const orphan = await guild.channels.fetch(orphanId)
        if (orphan) await orphan.delete('Orphaned integration open (takeover)')
        gone = Boolean(orphan)
      } catch (e) {
        gone = isUnknownChannel(e)
        if (!gone) log.warn('integration open: orphan channel fetch/delete failed', { channelId: orphanId, err: String(e) })
      }
      if (!gone) return await fail(err(503, 'guild_unavailable'))
      await setClaim(req.integrationId, req.externalRef, { channelId: null })
    }

    let member: GuildMember
    try {
      member = await guild.members.fetch({ user: req.openerDiscordId, force: true })
    } catch (e) {
      if (isUnknownMember(e)) return await fail(err(404, 'opener_not_member'))
      log.warn('integration open: member fetch failed', { err: String(e) })
      return await fail(err(503, 'guild_unavailable'))
    }
    if (member.pending) return await fail(err(403, 'opener_pending'))

    // 3. Open (channel → claim.channel_id → ticket row → webhook → card → …).
    // Identity comes from the bound row, never from the request body.
    const integration: IntegrationIdentity = { id: bound.id, slug: bound.slug, name: bound.name }
    const result = await openTicket({
      guild,
      opener: member,
      categoryKey: category.key,
      business,
      source: 'integration',
      integration,
      subject: req.subject,
      card: req.card,
      externalRef: req.externalRef,
      skipOpenerDedupe: true,
      bypassAllowRoles: category.integrationOnly,
    })
    if (!result.ok) {
      // 4a. Insert failed (channel already deleted by openTicket) or refused.
      if (result.code === 'insert_failed') return await fail(err(500, 'insert_failed'))
      if (result.code === 'category_forbidden') return await fail(err(403, 'category_forbidden'))
      return await fail({ status: 422, body: { error: result.code, reason: result.reason } })
    }

    // 4b. Success.
    await setClaim(req.integrationId, req.externalRef, { state: 'open', ticketId: result.ticket.id })
    return { status: 201, body: { ticketId: result.ticket.id, channelId: result.channel.id, created: true } }
  } catch (e) {
    log.error('integration open failed', { integration: bound.slug, externalRef: req.externalRef, err: String(e) })
    return await fail(err(500, 'internal_error'))
  }
}

// ───────────────────────────── close ─────────────────────────────

// Close-reason markdown: `reason` arrives ALREADY markdown-escaped by the web
// (euphoric-tickets-web src/server/integrations/api.ts escapes it at the
// /api/v1 boundary) and is passed through to the opener DM and the audit
// as-is. Do not escape it again here.
export async function handleIntegrationClose(client: Client, raw: unknown): Promise<RouteResult> {
  const b = (raw ?? {}) as Record<string, unknown>
  const ref = parseTicketRef(b)
  if (!ref) return err(400, 'validation')
  if (b.actorDiscordId !== undefined && b.actorDiscordId !== null && (typeof b.actorDiscordId !== 'string' || !SNOWFLAKE_RE.test(b.actorDiscordId))) {
    return err(400, 'validation')
  }
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') return err(400, 'validation')
  const actorDiscordId = (b.actorDiscordId as string | null | undefined) ?? null
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : undefined

  const bound = await loadBoundIntegration(ref.integrationId, ref.businessId)
  if (!bound) return err(403, 'integration_forbidden')
  const business = await loadBusiness(ref.businessId)
  if (!business) return err(404, 'not_found')
  const ticket = await loadIntegrationTicket(ref)
  if (!ticket) return err(404, 'not_found')
  if (ticket.status === 'closed') return err(409, 'already_closed')

  const via = `integration:${bound.slug}`

  const guild = availableGuild(client, business.discordGuildId)
  if (!guild) return err(503, 'guild_unavailable')

  // Closer: the actor when given AND integration-actor staff (category staff ∪
  // team staff ∪ team admin roles — the web's checkActor set, no ManageGuild /
  // sudo); otherwise the bot. `closedBy` in the response makes the fallback
  // visible to the web.
  const [category] = ticket.categoryId
    ? await db.select().from(ticketCategories).where(eq(ticketCategories.id, ticket.categoryId)).limit(1)
    : [null]
  let closer: GuildMember | null = null
  if (actorDiscordId) {
    const actor = await guild.members.fetch({ user: actorDiscordId, force: true }).catch(() => null)
    if (actor && !actor.pending && isIntegrationActorStaff(actor, business, category ?? null)) closer = actor
  }
  const closedBy: 'actor' | 'bot' = closer ? 'actor' : 'bot'
  if (!closer) closer = guild.members.me ?? (await guild.members.fetchMe().catch(() => null))
  if (!closer) return err(503, 'guild_unavailable')

  const found = await lookupTextChannel(guild, ticket.discordChannelId)
  if (found.kind === 'error') {
    // Transient / permission error: the channel may still exist. Leave the
    // row open so the web's retry can run the full close.
    log.warn('integration close: channel lookup failed', { ticketId: ticket.id, err: String(found.error) })
    return err(503, 'guild_unavailable')
  }
  if (found.kind === 'gone') {
    // The channel is already gone — nothing to transcribe or delete; just
    // close the row (conditionally, so a concurrent close wins cleanly).
    const closerUserId = await getOrCreateUserByDiscordId(closer.id, {
      name: closer.user.globalName ?? closer.user.username,
      image: closer.user.displayAvatarURL(),
    })
    const rows = await db
      .update(tickets)
      .set({ status: 'closed', closedAt: new Date(), closedByUserId: closerUserId, lastActivityAt: new Date() })
      .where(and(eq(tickets.id, ticket.id), sql`${tickets.status} <> 'closed'`))
      .returning({ id: tickets.id })
    if (rows.length === 0) return err(409, 'already_closed')
    await writeAudit({
      businessId: business.id,
      ticketId: ticket.id,
      actorUserId: closerUserId,
      action: 'closed',
      metadata: { via, ...(reason ? { reason } : {}) },
    })
    return { status: 200, body: { closed: true, closedBy } }
  }

  const result = await closeTicket({ guild, channel: found.channel, ticket, closer, business, reason, via })
  if (!result.ok) {
    if (result.code === 'already_closed') return err(409, 'already_closed')
    return { status: 422, body: { error: result.code ?? 'close_refused', reason: result.reason } }
  }
  return { status: 200, body: { closed: true, closedBy } }
}

// ───────────────────────────── webhook/ensure ─────────────────────────────

export async function handleWebhookEnsure(client: Client, raw: unknown): Promise<RouteResult> {
  const ref = parseTicketRef((raw ?? {}) as Record<string, unknown>)
  if (!ref) return err(400, 'validation')

  const bound = await loadBoundIntegration(ref.integrationId, ref.businessId)
  if (!bound) return err(403, 'integration_forbidden')
  const business = await loadBusiness(ref.businessId)
  if (!business) return err(404, 'not_found')
  const ticket = await loadIntegrationTicket(ref)
  if (!ticket) return err(404, 'not_found')
  if (ticket.discordWebhookUrl) return { status: 200, body: { webhookUrl: ticket.discordWebhookUrl } }

  const guild = availableGuild(client, business.discordGuildId)
  if (!guild) return err(503, 'guild_unavailable')
  const found = await lookupTextChannel(guild, ticket.discordChannelId)
  if (found.kind === 'error') {
    log.warn('webhook ensure: channel lookup failed', { ticketId: ticket.id, err: String(found.error) })
    return err(503, 'guild_unavailable')
  }
  if (found.kind === 'gone') return err(404, 'channel_not_found')

  const webhookUrl = await ensureTicketWebhook(found.channel, ticket.id)
  return { status: 200, body: { webhookUrl } }
}
