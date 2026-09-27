import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { auditLogs, integrationOpenClaims, integrations, tickets } from '../src/db/schema'
import { handleIntegrationOpen, handleWebhookEnsure } from '../src/services/integrationTickets'
import { ensureTicketWebhook } from '../src/services/ticketService'
import { safeLinkUrl } from '../src/services/ticketRenderer'
import { createInternalServer } from '../src/bot/internalHttp'
import { componentsJson, fakeClient, seedTeam, snow, type FakeTextChannel, type FakeWebhook } from './fakes'
import { ageClaim, getClaim, openBody, seedIntegration, stubFetch, ticketsForRef } from './helpers'

const STAFF_ROLE = '200000000000000001'

let fetchStub: ReturnType<typeof stubFetch>
beforeEach(() => {
  fetchStub = stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function setup(category: Parameters<typeof seedTeam>[0]['category'] = {}) {
  const team = await seedTeam({ category: { staffRoleIds: STAFF_ROLE, integrationOnly: true, ...category } })
  const opener = team.guild.addMember({ username: 'songwriter' })
  const integration = await seedIntegration(team.business.id, { allowedCategoryKeys: [team.category.key] })
  const client = fakeClient(team.guild)
  return { ...team, opener, integration, client }
}

describe('POST /api/internal/tickets/open — happy path', () => {
  it('opens an integration ticket with full bot parity', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })

    const res = await handleIntegrationOpen(s.client, body)
    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)

    const channels = s.guild.liveTextChannels()
    expect(channels).toHaveLength(1)
    const ch = channels[0]
    expect(res.body.channelId).toBe(ch.id)
    expect(ch.parentId).toBe(s.parentId)
    // Per-staff-role overwrites + opener + @everyone deny.
    expect(ch.overwrites.map((o) => o.id).sort()).toEqual([s.guild.id, s.opener.id, STAFF_ROLE].sort())
    expect(ch.name).toBe(`ticket-${res.body.ticketId}-songwriter`)

    const [t] = await db.select().from(tickets).where(eq(tickets.id, res.body.ticketId as number))
    expect(t.integrationId).toBe(s.integration.id)
    expect(t.externalRef).toBe(body.externalRef)
    expect(t.integrationCard).toEqual(body.card)
    expect(t.subject).toBe(body.subject)
    expect(t.externalSource).toBe('euphoric')
    // Mandatory webhook, persisted.
    expect(ch.webhooks).toHaveLength(1)
    expect(t.discordWebhookUrl).toBe(ch.webhooks[0].url)
    expect(t.discordWebhookId).toBe(ch.webhooks[0].id)

    // Ping (opener + staff role), then the welcome card.
    expect(ch.sent[0].content).toBe(`<@${s.opener.id}> <@&${STAFF_ROLE}>`)
    const card = componentsJson(ch.sent[1])
    expect(card).toContain('New song batch #12')
    expect(card).toContain('Song #2 — Artist B - Track Two')
    expect(card).toContain(`tk:claim:${t.id}`)
    expect(card).toContain(`tk:close:${t.id}`)
    expect(card).toContain(`tk:changecat:${t.id}`)
    expect(card).toContain('https://music.euphoric.fm/batches/12')
    expect(card).toContain('Open in portal')
    expect(card).toContain(`https://tickets.example.test/b/${s.business.slug}/tickets/${t.id}`)

    // Claim → open.
    const claim = await getClaim(s.integration.id, body.externalRef)
    expect(claim.state).toBe('open')
    expect(claim.ticketId).toBe(t.id)
    expect(claim.channelId).toBe(ch.id)

    // Audit via integration:<slug>.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.ticketId, t.id))
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('opened')
    expect(audits[0].metadata).toMatchObject({ via: `integration:${s.integration.slug}`, externalRef: body.externalRef })

    // new_ticket notify went to the private-network web URL.
    await vi.waitFor(() => expect(fetchStub.calls).toHaveLength(1))
    expect(fetchStub.calls[0].url).toBe('http://tickets-web:3000/api/internal/notify')
    expect(fetchStub.calls[0].body).toMatchObject({ event: 'new_ticket', ticketId: t.id, slug: s.business.slug })
  })

  it('lets the same opener hold 2 open integration tickets in one category', async () => {
    const s = await setup()
    const a = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    const b = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.body.ticketId).not.toBe(b.body.ticketId)
    expect(s.guild.liveTextChannels()).toHaveLength(2)
    const open = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.businessId, s.business.id), eq(tickets.status, 'open')))
    expect(open).toHaveLength(2)
  })

  it('still opens when webhook creation fails (web retries via /webhook/ensure)', async () => {
    const s = await setup()
    const origCreate = s.guild.channels.create
    s.guild.channels.create = async (o) => {
      const ch = await origCreate(o)
      ch.failCreateWebhook = true
      return ch
    }
    const res = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    expect(res.status).toBe(201)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, res.body.ticketId as number))
    expect(t.discordWebhookUrl).toBeNull()

    // Retry path.
    s.guild.liveTextChannels()[0].failCreateWebhook = false
    const ensured = await handleWebhookEnsure(s.client, { ticketId: t.id, businessId: s.business.id, integrationId: s.integration.id })
    expect(ensured.status).toBe(200)
    const [after] = await db.select().from(tickets).where(eq(tickets.id, t.id))
    expect(ensured.body.webhookUrl).toBe(after.discordWebhookUrl)
    expect(s.guild.liveTextChannels()[0].webhooks).toHaveLength(1)
  })
})

describe('open — claim rules', () => {
  it('adopts an existing ticket for the same ref (200, created:false) and ensures its webhook', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const first = await handleIntegrationOpen(s.client, body)
    expect(first.status).toBe(201)
    // Simulate a lost webhook; adopt should re-create it.
    await db.update(tickets).set({ discordWebhookId: null, discordWebhookUrl: null }).where(eq(tickets.id, first.body.ticketId as number))
    s.guild.liveTextChannels()[0].webhooks.length = 0

    const again = await handleIntegrationOpen(s.client, body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ticketId: first.body.ticketId, channelId: first.body.channelId, created: false })
    expect(s.guild.liveTextChannels()).toHaveLength(1)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, first.body.ticketId as number))
    expect(t.discordWebhookUrl).toBeTruthy()
    expect((await getClaim(s.integration.id, body.externalRef)).state).toBe('open')
  })

  it('adopting a ticket whose channel was nulled (cleanup/resync) → 409 ticket_channel_missing', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const first = await handleIntegrationOpen(s.client, body)
    await db.update(tickets).set({ discordChannelId: null }).where(eq(tickets.id, first.body.ticketId as number))
    expect(await handleIntegrationOpen(s.client, body)).toEqual({
      status: 409,
      body: { error: 'ticket_channel_missing', ticketId: first.body.ticketId },
    })
    expect(s.guild.liveTextChannels()).toHaveLength(1) // nothing new created
    expect(await ticketsForRef(s.integration.id, body.externalRef)).toHaveLength(1)
  })

  it('returns 409 opening_in_progress while a fresh claim is opening', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    await db.insert(integrationOpenClaims).values({ integrationId: s.integration.id, externalRef: body.externalRef, state: 'opening' })
    const res = await handleIntegrationOpen(s.client, body)
    expect(res).toEqual({ status: 409, body: { error: 'opening_in_progress' } })
    expect(s.guild.liveTextChannels()).toHaveLength(0)
  })

  it('takes over a stale opening claim and deletes its orphan channel', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const orphan = await s.guild.channels.create({ name: 'ticket-songwriter', parent: s.parentId })
    await db.insert(integrationOpenClaims).values({
      integrationId: s.integration.id,
      externalRef: body.externalRef,
      state: 'opening',
      channelId: orphan.id,
    })
    await ageClaim(s.integration.id, body.externalRef, 121)

    const res = await handleIntegrationOpen(s.client, body)
    expect(res.status).toBe(201)
    expect(orphan.deleted).toBe(true)
    const live = s.guild.liveTextChannels()
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(res.body.channelId)
    const claim = await getClaim(s.integration.id, body.externalRef)
    expect(claim).toMatchObject({ state: 'open', channelId: live[0].id, ticketId: res.body.ticketId })
  })

  it('orphan takeover: a non-10003 fetch/delete error keeps claim.channel_id and returns 503', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const orphan = await s.guild.channels.create({ name: 'ticket-songwriter', parent: s.parentId })
    await db.insert(integrationOpenClaims).values({ integrationId: s.integration.id, externalRef: body.externalRef, state: 'failed', channelId: orphan.id })

    // Transient fetch error.
    const realFetch = s.guild.channels.fetch
    s.guild.channels.fetch = async () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 })
    }
    expect(await handleIntegrationOpen(s.client, body)).toEqual({ status: 503, body: { error: 'guild_unavailable' } })
    s.guild.channels.fetch = realFetch
    expect(await getClaim(s.integration.id, body.externalRef)).toMatchObject({ state: 'failed', channelId: orphan.id })

    // Delete refused (Missing Permissions).
    const realDelete = orphan.delete.bind(orphan)
    orphan.delete = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 })
    }
    expect((await handleIntegrationOpen(s.client, body)).status).toBe(503)
    expect(await getClaim(s.integration.id, body.externalRef)).toMatchObject({ state: 'failed', channelId: orphan.id })
    expect(s.guild.liveTextChannels()).toEqual([orphan])

    // Healthy retry deletes the orphan and opens exactly one channel.
    orphan.delete = realDelete
    const ok = await handleIntegrationOpen(s.client, body)
    expect(ok.status).toBe(201)
    expect(orphan.deleted).toBe(true)
    expect(s.guild.liveTextChannels().map((c) => c.id)).toEqual([ok.body.channelId])
  })

  it('orphan takeover: 10003 Unknown Channel counts as gone', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    await db.insert(integrationOpenClaims).values({ integrationId: s.integration.id, externalRef: body.externalRef, state: 'failed', channelId: snow() })
    const res = await handleIntegrationOpen(s.client, body)
    expect(res.status).toBe(201)
    expect((await getClaim(s.integration.id, body.externalRef)).channelId).toBe(res.body.channelId)
  })

  it('takes over a failed claim immediately', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    await db.insert(integrationOpenClaims).values({ integrationId: s.integration.id, externalRef: body.externalRef, state: 'failed' })
    const res = await handleIntegrationOpen(s.client, body)
    expect(res.status).toBe(201)
  })

  it('crash between channel create and ticket insert, then retry → exactly 1 channel', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })

    // "Kill" the process at the ticket insert: it never returns.
    const realInsert = db.insert.bind(db)
    const insertSpy = vi.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      if (table === tickets) return { values: () => ({ returning: () => new Promise(() => {}) }) }
      return realInsert(table as never)
    }) as never)
    void handleIntegrationOpen(s.client, body)
    await vi.waitFor(async () => {
      const c = await getClaim(s.integration.id, body.externalRef)
      expect(c?.channelId).toBeTruthy()
    })
    insertSpy.mockRestore()

    const orphanId = (await getClaim(s.integration.id, body.externalRef)).channelId!
    expect(s.guild.liveTextChannels().map((c) => c.id)).toEqual([orphanId])
    expect(await ticketsForRef(s.integration.id, body.externalRef)).toHaveLength(0)

    // Retry while the dead attempt's claim is still fresh → 409, nothing created.
    const early = await handleIntegrationOpen(s.client, body)
    expect(early.status).toBe(409)
    expect(s.guild.liveTextChannels()).toHaveLength(1)

    // "Restart" + retry after the 2-minute lease.
    await ageClaim(s.integration.id, body.externalRef, 150)
    const retry = await handleIntegrationOpen(s.client, body)
    expect(retry.status).toBe(201)

    const live = s.guild.liveTextChannels()
    expect(live).toHaveLength(1)
    expect(live[0].id).not.toBe(orphanId)
    expect(live[0].id).toBe(retry.body.channelId)
    expect(await ticketsForRef(s.integration.id, body.externalRef)).toHaveLength(1)
  })

  it('insert failure deletes the channel and marks the claim failed; the next attempt succeeds', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const realInsert = db.insert.bind(db)
    const insertSpy = vi.spyOn(db, 'insert').mockImplementation(((table: unknown) => {
      if (table === tickets) return { values: () => ({ returning: () => Promise.reject(new Error('boom')) }) }
      return realInsert(table as never)
    }) as never)
    const res = await handleIntegrationOpen(s.client, body)
    insertSpy.mockRestore()
    expect(res.status).toBe(500)
    expect(s.guild.liveTextChannels()).toHaveLength(0)
    expect((await getClaim(s.integration.id, body.externalRef)).state).toBe('failed')

    const retry = await handleIntegrationOpen(s.client, body)
    expect(retry.status).toBe(201)
    expect(s.guild.liveTextChannels()).toHaveLength(1)
  })

  it('10 parallel opens with the same ref produce exactly 1 channel and 1 ticket', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const results = await Promise.all(Array.from({ length: 10 }, () => handleIntegrationOpen(s.client, body)))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((x) => x === 201)).toHaveLength(1)
    expect(statuses.every((x) => x === 201 || x === 200 || x === 409)).toBe(true)
    expect(s.guild.liveTextChannels()).toHaveLength(1)
    expect(await ticketsForRef(s.integration.id, body.externalRef)).toHaveLength(1)
  })
})

describe('integration binding (defense in depth)', () => {
  it('open: 403 integration_forbidden for a disabled integration or one of another business', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    const other = await seedTeam()
    const foreign = await seedIntegration(other.business.id)
    expect(await handleIntegrationOpen(s.client, { ...body, integrationId: foreign.id })).toEqual({
      status: 403,
      body: { error: 'integration_forbidden' },
    })
    await db.update(integrations).set({ enabled: false }).where(eq(integrations.id, s.integration.id))
    expect(await handleIntegrationOpen(s.client, body)).toEqual({ status: 403, body: { error: 'integration_forbidden' } })
    expect(await handleWebhookEnsure(s.client, { ticketId: 1, businessId: s.business.id, integrationId: s.integration.id })).toEqual({
      status: 403,
      body: { error: 'integration_forbidden' },
    })
    expect(s.guild.liveTextChannels()).toHaveLength(0)
    expect(await getClaim(s.integration.id, body.externalRef)).toBeUndefined()
  })

  it('open: 403 category_forbidden when the category key is not in allowed_category_keys', async () => {
    const s = await setup()
    await db.update(integrations).set({ allowedCategoryKeys: ['other'] }).where(eq(integrations.id, s.integration.id))
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect(await handleIntegrationOpen(s.client, body)).toEqual({ status: 403, body: { error: 'category_forbidden' } })
    expect(s.guild.liveTextChannels()).toHaveLength(0)
  })
})

describe('open — opener and category errors', () => {
  it('404 opener_not_member (claim marked failed so a retry is not blocked)', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: snow() })
    expect(await handleIntegrationOpen(s.client, body)).toEqual({ status: 404, body: { error: 'opener_not_member' } })
    expect((await getClaim(s.integration.id, body.externalRef)).state).toBe('failed')
    expect(s.guild.liveTextChannels()).toHaveLength(0)
  })

  it('403 opener_pending', async () => {
    const s = await setup()
    const pending = s.guild.addMember({ pending: true })
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: pending.id })
    expect(await handleIntegrationOpen(s.client, body)).toEqual({ status: 403, body: { error: 'opener_pending' } })
  })

  it('403 category_forbidden for an unknown or staff-only category', async () => {
    const s = await setup()
    const body = { ...openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }), categoryKey: 'nope' }
    expect((await handleIntegrationOpen(s.client, body)).body).toEqual({ error: 'category_forbidden' })
    const so = await setup({ key: 'triage', staffOnly: true, integrationOnly: false })
    const body2 = openBody({ integration: so.integration, business: so.business, category: so.category, openerDiscordId: so.opener.id })
    expect((await handleIntegrationOpen(so.client, body2)).body).toEqual({ error: 'category_forbidden' })
  })

  it('non-integration_only categories still enforce allow_role_ids for the opener', async () => {
    const s = await setup({ key: 'support', integrationOnly: false, allowRoleIds: '200000000000000077' })
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect((await handleIntegrationOpen(s.client, body)).body).toEqual({ error: 'category_forbidden' })
  })

  it('integration_only bypasses allow_role_ids', async () => {
    const s = await setup({ allowRoleIds: '200000000000000077' })
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect((await handleIntegrationOpen(s.client, body)).status).toBe(201)
  })

  it('503 guild_unavailable when the bot is not in the guild', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect(await handleIntegrationOpen(fakeClient(), body)).toEqual({ status: 503, body: { error: 'guild_unavailable' } })
  })

  it('400 on a malformed body', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect((await handleIntegrationOpen(s.client, { ...body, subject: 'x'.repeat(101) })).status).toBe(400)
    expect(await handleIntegrationOpen(s.client, { ...body, subject: '   ' })).toEqual({ status: 400, body: { error: 'validation' } })
    expect(await handleIntegrationOpen(s.client, { ...body, subject: '\n\t ' })).toEqual({ status: 400, body: { error: 'validation' } })
    expect(s.guild.liveTextChannels()).toHaveLength(0)
    expect((await handleIntegrationOpen(s.client, { ...body, card: { title: 't', lines: Array(26).fill('a') } })).status).toBe(400)
  })

  it('stores the subject as sent, trimmed', async () => {
    const s = await setup()
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id, subject: '  Batch 12  ' })
    const res = await handleIntegrationOpen(s.client, body)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, res.body.ticketId as number))
    expect(t.subject).toBe('Batch 12')
  })

  it('uses the business passed by id, never the guild default team', async () => {
    // Two teams share one guild (like euphoric + euphoricfm); the category key
    // exists only on the SECOND team.
    const first = await seedTeam({ category: { key: 'support' } })
    const second = await seedTeam({ guild: first.guild, category: { key: 'newsong', integrationOnly: true } })
    const opener = first.guild.addMember()
    const integration = await seedIntegration(second.business.id)
    const res = await handleIntegrationOpen(
      fakeClient(first.guild),
      openBody({ integration, business: second.business, category: second.category, openerDiscordId: opener.id }),
    )
    expect(res.status).toBe(201)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, res.body.ticketId as number))
    expect(t.businessId).toBe(second.business.id)
    expect(componentsJson(first.guild.liveTextChannels()[0].sent[1])).toContain(`/b/${second.business.slug}/tickets/${t.id}`)
  })
})

describe('webhook/ensure', () => {
  it('concurrent ensures persist exactly one webhook', async () => {
    const s = await setup()
    const res = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    const id = res.body.ticketId as number
    await db.update(tickets).set({ discordWebhookId: null, discordWebhookUrl: null }).where(eq(tickets.id, id))
    const ch = s.guild.liveTextChannels()[0]
    ch.webhooks.length = 0
    const out = await Promise.all(Array.from({ length: 5 }, () => handleWebhookEnsure(s.client, { ticketId: id, businessId: s.business.id, integrationId: s.integration.id })))
    const urls = new Set(out.map((o) => o.body.webhookUrl))
    expect(urls.size).toBe(1)
    expect(ch.webhooks).toHaveLength(1)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, id))
    expect(t.discordWebhookUrl).toBe([...urls][0])
  })

  // Holds the first createWebhook call open (after the webhook exists on the
  // channel) until release() — lets a test interleave other writers.
  function holdFirstCreate(ch: FakeTextChannel) {
    const orig = ch.createWebhook.bind(ch)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const made: FakeWebhook[] = []
    ch.createWebhook = async (o) => {
      const wh = await orig(o)
      made.push(wh)
      if (made.length === 1) await gate
      return wh
    }
    return { release, made }
  }

  async function openWithoutWebhook() {
    const s = await setup()
    const res = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    const id = res.body.ticketId as number
    await db.update(tickets).set({ discordWebhookId: null, discordWebhookUrl: null }).where(eq(tickets.id, id))
    const ch = s.guild.liveTextChannels()[0]
    ch.webhooks.length = 0
    return { s, id, ch }
  }

  it('serializes ensures per ticket: a second caller waits for the first and reuses its webhook', async () => {
    const { id, ch } = await openWithoutWebhook()
    const hold = holdFirstCreate(ch)
    let fetches = 0
    const origFetch = ch.fetchWebhooks.bind(ch)
    ch.fetchWebhooks = async () => {
      fetches++
      return origFetch()
    }

    const a = ensureTicketWebhook(ch as any, id)
    await vi.waitFor(() => expect(hold.made).toHaveLength(1))
    let bDone = false
    const b = ensureTicketWebhook(ch as any, id).then((u) => ((bDone = true), u))
    await new Promise((r) => setTimeout(r, 200))
    // B is parked on the advisory lock — it has not even listed webhooks, so it
    // cannot pick up A's not-yet-persisted hook.
    expect(fetches).toBe(1)
    expect(bDone).toBe(false)

    hold.release()
    const [ua, ub] = await Promise.all([a, b])
    const wh1 = hold.made[0]
    expect(ua).toBe(wh1.url)
    expect(ub).toBe(wh1.url)
    expect(hold.made).toHaveLength(1)
    expect(wh1.deleted).toBe(false)
    expect(ch.webhooks).toEqual([wh1])
    const [t] = await db.select().from(tickets).where(eq(tickets.id, id))
    expect(t.discordWebhookId).toBe(wh1.id)
    expect(t.discordWebhookUrl).toBe(wh1.url)
  })

  it('reuse-then-lose: a caller that loses the persist never deletes the webhook that was persisted', async () => {
    const { id, ch } = await openWithoutWebhook()
    const hold = holdFirstCreate(ch)
    const a = ensureTicketWebhook(ch as any, id)
    await vi.waitFor(() => expect(hold.made).toHaveLength(1))
    const wh1 = hold.made[0]
    // Another writer (outside the lock) reuses A's in-flight webhook and
    // persists it first.
    await db.update(tickets).set({ discordWebhookId: wh1.id, discordWebhookUrl: wh1.url }).where(eq(tickets.id, id))
    hold.release()
    expect(await a).toBe(wh1.url)
    expect(wh1.deleted).toBe(false)
    expect(ch.webhooks).toEqual([wh1])
  })

  it('a caller that loses the persist to a DIFFERENT webhook deletes its own', async () => {
    const { id, ch } = await openWithoutWebhook()
    const other = await ch.createWebhook({ name: 'someone-else' })
    const hold = holdFirstCreate(ch)
    const a = ensureTicketWebhook(ch as any, id)
    await vi.waitFor(() => expect(hold.made).toHaveLength(1))
    await db.update(tickets).set({ discordWebhookId: other.id, discordWebhookUrl: other.url }).where(eq(tickets.id, id))
    hold.release()
    expect(await a).toBe(other.url)
    expect(hold.made[0].deleted).toBe(true)
    expect(ch.webhooks).toEqual([other])
  })

  it('503 on a transient channel lookup error, 404 channel_not_found when the channel is gone', async () => {
    const { s, id, ch } = await openWithoutWebhook()
    const realFetch = s.guild.channels.fetch
    s.guild.channels.fetch = async () => {
      throw Object.assign(new Error('Missing Access'), { code: 50001 })
    }
    expect(await handleWebhookEnsure(s.client, { ticketId: id, businessId: s.business.id, integrationId: s.integration.id })).toEqual({
      status: 503,
      body: { error: 'guild_unavailable' },
    })
    s.guild.channels.fetch = realFetch
    await ch.delete()
    expect(await handleWebhookEnsure(s.client, { ticketId: id, businessId: s.business.id, integrationId: s.integration.id })).toEqual({
      status: 404,
      body: { error: 'channel_not_found' },
    })
  })

  it('refuses another business (403), another integration (404) and a missing integrationId (400)', async () => {
    const s = await setup()
    const other = await seedTeam()
    const res = await handleIntegrationOpen(s.client, openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id }))
    const ticketId = res.body.ticketId
    // The integration belongs to s.business, not `other`.
    expect(await handleWebhookEnsure(s.client, { ticketId, businessId: other.business.id, integrationId: s.integration.id })).toEqual({
      status: 403,
      body: { error: 'integration_forbidden' },
    })
    // A second integration of the SAME business does not own the ticket.
    const sibling = await seedIntegration(s.business.id)
    expect(await handleWebhookEnsure(s.client, { ticketId, businessId: s.business.id, integrationId: sibling.id })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
    expect((await handleWebhookEnsure(s.client, { ticketId, businessId: s.business.id })).status).toBe(400)
  })
})

describe('internal HTTP bridge', () => {
  it('routes the integration endpoints behind x-internal-token with the body cap', async () => {
    const s = await setup()
    const server = createInternalServer(s.client)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const token = process.env.INTERNAL_TOKEN!
    try {
      const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
      const post = (path: string, payload: unknown, tok = token) =>
        fetch(base + path, { method: 'POST', headers: { 'x-internal-token': tok, 'content-type': 'application/json' }, body: JSON.stringify(payload) })

      expect((await post('/api/internal/tickets/open', body, 'wrong-token-wrong-token-wrong-tok')).status).toBe(401)
      expect((await fetch(base + '/api/internal/tickets/open')).status).toBe(404)

      const r = await post('/api/internal/tickets/open', body)
      expect(r.status).toBe(201)
      const json = (await r.json()) as { ticketId: number; channelId: string; created: boolean }
      expect(json.created).toBe(true)

      const again = await post('/api/internal/tickets/open', body)
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ ...json, created: false })

      const ens = await post('/api/internal/tickets/webhook/ensure', { ticketId: json.ticketId, businessId: s.business.id, integrationId: s.integration.id })
      expect(ens.status).toBe(200)
      expect(((await ens.json()) as { webhookUrl: string }).webhookUrl).toMatch(/^https:\/\/discord\.com\/api\/webhooks\//)

      // > 16 KB body is cut off (connection destroyed), never processed.
      const big = await post('/api/internal/tickets/open', { ...body, pad: 'x'.repeat(20_000) }).then(
        (x) => x.status,
        () => 'reset',
      )
      expect(big === 'reset' || big === 400).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('card link URL — Discord 512-char link-button limit', () => {
  const urlOfLength = (n: number) => {
    const base = 'https://music.euphoric.fm/b/'
    return base + 'x'.repeat(n - base.length)
  }
  const cardWith = (url: string) => ({ title: 'Batch', lines: ['a'], link: { label: 'Open in portal', url } })

  it('route validation caps card.link.url at 512 (the fake channel enforces Discord limits)', async () => {
    const s = await setup()
    const base = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
    expect(await handleIntegrationOpen(s.client, { ...base, card: cardWith(urlOfLength(513)) })).toEqual({
      status: 400,
      body: { error: 'validation' },
    })
    const ok = await handleIntegrationOpen(s.client, { ...base, card: cardWith(urlOfLength(512)) })
    expect(ok.status).toBe(201)
    const ch = s.guild.liveTextChannels()[0]
    expect(componentsJson(ch.sent[1])).toContain(urlOfLength(512))
  })

  it('safeLinkUrl drops a URL whose NORMALISED form exceeds 512', () => {
    const raw = 'https://music.euphoric.fm/b/' + 'é'.repeat(100) // 128 chars raw, 628 once %C3%A9-encoded
    expect(raw.length).toBeLessThanOrEqual(512)
    expect(new URL(raw).toString().length).toBeGreaterThan(512)
    expect(safeLinkUrl(raw)).toBeNull()
    expect(safeLinkUrl(urlOfLength(512))).toBe(urlOfLength(512))
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull()
  })

  it('a rejected welcome card is retried once without the card link; audit, log and notify still run', async () => {
    const s = await setup()
    const url = 'https://music.euphoric.fm/batches/rejected'
    // Discord rejects the card link for a reason the bot cannot predict.
    const origCreate = s.guild.channels.create
    s.guild.channels.create = async (o) => {
      const ch = await origCreate(o)
      const send = ch.send.bind(ch)
      ch.send = async (p) => {
        if (typeof p !== 'string' && componentsJson(p).includes(url)) {
          throw Object.assign(new Error('Invalid Form Body'), { code: 50035 })
        }
        return send(p)
      }
      return ch
    }
    const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id, card: cardWith(url) })
    const res = await handleIntegrationOpen(s.client, body)
    expect(res.status).toBe(201)
    const ch = s.guild.liveTextChannels()[0]
    expect(ch.sent).toHaveLength(2) // ping + the retried card
    const card = componentsJson(ch.sent[1])
    expect(card).toContain('Batch')
    expect(card).toContain(`tk:claim:${res.body.ticketId}`)
    expect(card).toContain(`/tickets/${res.body.ticketId}`) // Open in web survives
    expect(card).not.toContain(url)
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.ticketId, res.body.ticketId as number))
    expect(audits.map((a) => a.action)).toEqual(['opened'])
    await vi.waitFor(() => expect(fetchStub.calls.some((c) => (c.body as any)?.event === 'new_ticket')).toBe(true))
    expect((await getClaim(s.integration.id, body.externalRef)).state).toBe('open')
  })
})

describe('internal HTTP bridge — body decoding', () => {
  // Writes the body as two separate TCP writes, split at byte `at`.
  function postSplit(base: string, path: string, body: Buffer, at: number): Promise<{ status: number; json: any }> {
    const u = new URL(base + path)
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: {
            'x-internal-token': process.env.INTERNAL_TOKEN!,
            'content-type': 'application/json',
            'content-length': body.length,
          },
        },
        (res) => {
          const parts: Buffer[] = []
          res.on('data', (c) => parts.push(c))
          res.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8')
            resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null })
          })
        },
      )
      req.on('error', reject)
      req.write(body.subarray(0, at))
      setTimeout(() => req.end(body.subarray(at)), 100)
    })
  }

  it('a multi-byte character split across chunks survives intact', async () => {
    const s = await setup()
    const server = createInternalServer(s.client)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const subject = 'Ä'.repeat(50)
      const payload = Buffer.from(JSON.stringify(openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id, subject })), 'utf8')
      // Split INSIDE the first 'Ä' (0xC3 0x84).
      const at = payload.indexOf(Buffer.from('Ä', 'utf8')) + 1
      expect(payload[at - 1]).toBe(0xc3)
      const r = await postSplit(base, '/api/internal/tickets/open', payload, at)
      expect(r.status).toBe(201)
      const [t] = await db.select().from(tickets).where(eq(tickets.id, r.json.ticketId))
      expect(t.subject).toBe(subject)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('the 16 KB cap counts bytes, not characters', async () => {
    const s = await setup()
    const server = createInternalServer(s.client)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const body = openBody({ integration: s.integration, business: s.business, category: s.category, openerDiscordId: s.opener.id })
      // ~9 000 characters but ~18 000 bytes.
      const payload = Buffer.from(JSON.stringify({ ...body, pad: 'Ä'.repeat(9000) }), 'utf8')
      expect(JSON.stringify({ ...body, pad: 'Ä'.repeat(9000) }).length).toBeLessThan(16_000)
      expect(payload.length).toBeGreaterThan(16_000)
      const out = await postSplit(base, '/api/internal/tickets/open', payload, 8000).then(
        (x) => x.status,
        () => 'reset',
      )
      expect(out).toBe('reset')
      expect(s.guild.liveTextChannels()).toHaveLength(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

