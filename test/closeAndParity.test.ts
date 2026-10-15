import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { db } from '../src/db/client'
import { env } from '../src/config/env'
import { auditLogs, integrations, tickets, users } from '../src/db/schema'
import { handleIntegrationClose, handleIntegrationOpen } from '../src/services/integrationTickets'
import { handleTicketClaim } from '../src/interactions/buttons/ticketClaim'
import { handleTicketClose } from '../src/interactions/buttons/ticketClose'
import { execute as executeTickets, executeCloseConfirm } from '../src/commands/tickets'
import { componentsJson, fakeClient, seedTeam, type FakeGuild, type FakeMember, type FakeTextChannel } from './fakes'
import { openBody, seedIntegration, stubFetch } from './helpers'

const ADMIN_ROLE = '200000000000000010' // team admin_role_ids ("Ticket Master")
const MANAGER_ROLE = '200000000000000011' // category staff only (EFM Managers)
const TEAM_STAFF_ROLE = '200000000000000012' // businesses.staff_role_ids ("Team Member")

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// Two teams share one guild (euphoric + euphoricfm); the integration ticket
// lives on the SECOND team, so any guild-default lookup would pick the wrong one.
async function openIntegrationTicket() {
  const first = await seedTeam({ adminRoleIds: [ADMIN_ROLE], category: { key: 'support' } })
  const second = await seedTeam({
    guild: first.guild,
    adminRoleIds: [ADMIN_ROLE],
    staffRoleIds: [TEAM_STAFF_ROLE],
    category: { key: 'newsong', staffRoleIds: MANAGER_ROLE, integrationOnly: true },
  })
  const guild = first.guild
  const opener = guild.addMember({ username: 'songwriter' })
  const manager = guild.addMember({ username: 'manager', roles: [MANAGER_ROLE] })
  const outsider = guild.addMember({ username: 'outsider' })
  const integration = await seedIntegration(second.business.id)
  const client = fakeClient(guild)
  const body = openBody({ integration, business: second.business, category: second.category, openerDiscordId: opener.id })
  const res = await handleIntegrationOpen(client, body)
  expect(res.status).toBe(201)
  const ticketId = res.body.ticketId as number
  const channel = guild.liveTextChannels()[0]
  return { first, second, guild, opener, manager, outsider, integration, client, body, ticketId, channel }
}

async function userIdFor(discordId: string): Promise<string> {
  const [u] = await db.select().from(users).where(eq(users.discordId, discordId))
  return u.id
}

function buttonInteraction(guild: FakeGuild, channel: FakeTextChannel, member: FakeMember, customId: string) {
  return {
    inGuild: () => true,
    guild,
    customId,
    channelId: channel.id,
    channel,
    user: { id: member.id },
    message: { edit: vi.fn(async () => ({})) },
    deferUpdate: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  }
}

describe('Claim parity (welcome-card button)', () => {
  it('a category-staff manager who is NOT in admin_role_ids can claim; card + links survive', async () => {
    const s = await openIntegrationTicket()
    const i = buttonInteraction(s.guild, s.channel, s.manager, `tk:claim:${s.ticketId}`)
    await handleTicketClaim(i as any)

    expect(i.followUp).not.toHaveBeenCalled()
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('in_progress')
    expect(t.assigneeUserId).toBe(await userIdFor(s.manager.id))

    expect(i.message.edit).toHaveBeenCalledTimes(1)
    const card = componentsJson((i.message.edit.mock.calls[0] as any)[0])
    expect(card).toContain('New song batch #12')
    expect(card).toContain('Song #1 — Artist A - Track One')
    expect(card).toContain('https://music.euphoric.fm/batches/12')
    expect(card).toContain(`claimed by <@${s.manager.id}>`)
    // Web link uses the ticket's OWN team slug, not the guild default team.
    expect(card).toContain(`https://tickets.example.test/b/${s.second.business.slug}/tickets/${s.ticketId}`)
    expect(card).not.toContain(`/b/${s.first.business.slug}/`)
    expect(card).toContain(`tk:claim:${s.ticketId}`)
    expect(card).toContain(`tk:close:${s.ticketId}`)
  })

  it('refuses a non-staff member', async () => {
    const s = await openIntegrationTicket()
    const i = buttonInteraction(s.guild, s.channel, s.outsider, `tk:claim:${s.ticketId}`)
    await handleTicketClaim(i as any)
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'Only staff can claim tickets.' }))
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.assigneeUserId).toBeNull()
    expect(i.message.edit).not.toHaveBeenCalled()
  })

  it('the Close button lets the category-staff manager through and refuses outsiders', async () => {
    const s = await openIntegrationTicket()
    const ok = buttonInteraction(s.guild, s.channel, s.manager, `tk:close:${s.ticketId}`)
    await handleTicketClose(ok as any)
    expect(componentsJson((ok.editReply.mock.calls[0] as any)[0])).toContain(`tk:close_confirm:${s.ticketId}`)

    const no = buttonInteraction(s.guild, s.channel, s.outsider, `tk:close:${s.ticketId}`)
    await handleTicketClose(no as any)
    expect(no.editReply).toHaveBeenCalledWith({ content: 'Only the opener or staff can close this ticket.' })

    const opener = buttonInteraction(s.guild, s.channel, s.opener, `tk:close:${s.ticketId}`)
    await handleTicketClose(opener as any)
    expect(componentsJson((opener.editReply.mock.calls[0] as any)[0])).toContain('tk:close_confirm:')
  })
})

// 2026-07-21 review finding #2 (F2) regression: the "Close & delete" confirm
// button re-validates the clicker, and /tickets close only ever shows it
// ephemerally. A non-staff member who was added to the ticket channel (so can
// see and click in it) must not be able to close and delete the ticket.
describe('Close confirm authz (F2 regression)', () => {
  async function ticketWithAddedOutsider() {
    const s = await openIntegrationTicket()
    // The outsider was added to the channel (a member, not staff, not opener).
    s.channel.overwrites.push({ id: s.outsider.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })
    return s
  }

  it('refuses a non-staff channel member who clicks tk:close_confirm; nothing is closed', async () => {
    const s = await ticketWithAddedOutsider()
    const i = buttonInteraction(s.guild, s.channel, s.outsider, `tk:close_confirm:${s.ticketId}`)
    await executeCloseConfirm({ interaction: i as any, ticketId: s.ticketId })
    expect(i.editReply).toHaveBeenCalledWith({ content: 'Only the opener or staff can close this ticket.', components: [] })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).not.toBe('closed')
    expect(t.discordChannelId).toBe(s.channel.id)
    expect(s.channel.deleted).toBe(false)
    expect(s.opener.sentDMs).toHaveLength(0)
  })

  it('a crafted customId naming another ticket does not help: access comes from the channel', async () => {
    const s = await ticketWithAddedOutsider()
    const i = buttonInteraction(s.guild, s.channel, s.outsider, `tk:close_confirm:${s.ticketId + 999}`)
    await executeCloseConfirm({ interaction: i as any, ticketId: s.ticketId + 999 })
    expect(i.editReply).toHaveBeenCalledWith({ content: 'Only the opener or staff can close this ticket.', components: [] })
    expect(s.channel.deleted).toBe(false)
  })

  it('the category-staff manager can still close through the confirm button', async () => {
    const s = await ticketWithAddedOutsider()
    const i = buttonInteraction(s.guild, s.channel, s.manager, `tk:close_confirm:${s.ticketId}`)
    await executeCloseConfirm({ interaction: i as any, ticketId: s.ticketId })
    expect(i.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ content: 'Only the opener or staff can close this ticket.' }))
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('closed')
    expect(t.closedByUserId).toBe(await userIdFor(s.manager.id))
    expect(s.channel.deleted).toBe(true)
  })

  function slashClose(s: Awaited<ReturnType<typeof ticketWithAddedOutsider>>, member: FakeMember) {
    return {
      inGuild: () => true,
      guild: s.guild,
      channelId: s.channel.id,
      channel: s.channel,
      user: { id: member.id },
      client: s.client,
      options: { getSubcommand: () => 'close' },
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
    }
  }

  it('/tickets close shows the confirm button ephemerally to staff, and refuses the added outsider', async () => {
    const s = await ticketWithAddedOutsider()
    const staff = slashClose(s, s.manager)
    await executeTickets(staff as any)
    expect(staff.reply).toHaveBeenCalledTimes(1)
    const payload = (staff.reply.mock.calls[0] as any)[0]
    expect(payload.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral)
    expect(componentsJson(payload)).toContain(`tk:close_confirm:${s.ticketId}`)
    expect(s.channel.sent.some((m) => componentsJson(m).includes('tk:close_confirm:'))).toBe(false)

    const outsider = slashClose(s, s.outsider)
    await executeTickets(outsider as any)
    expect(outsider.reply).toHaveBeenCalledWith({ content: 'Only the opener or staff can close this ticket.', ephemeral: true })
    expect(s.channel.deleted).toBe(false)
  })
})

describe('POST /api/internal/tickets/close', () => {
  it('no actor → closes as the bot; opener DM links the correct business', async () => {
    const s = await openIntegrationTicket()
    const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })
    expect(res).toEqual({ status: 200, body: { closed: true, closedBy: 'bot' } })

    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('closed')
    expect(t.closedByUserId).toBe(await userIdFor(s.guild.me.id))
    expect(s.channel.deleted).toBe(true)

    expect(s.opener.sentDMs).toHaveLength(1)
    const dm = s.opener.sentDMs[0].content!
    expect(dm).toContain(`https://tickets.example.test/b/${s.second.business.slug}/tickets/${s.ticketId}`)
    expect(dm).not.toContain(`/b/${s.first.business.slug}/`)
    expect(dm).toContain('closed by EuphoricTickets')

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.ticketId, s.ticketId))
    const closed = audits.find((a) => a.action === 'closed')!
    expect(closed.metadata).toMatchObject({ via: `integration:${s.integration.slug}` })
  })

  it('a staff actor is the closer; the reason reaches the DM and audit', async () => {
    const s = await openIntegrationTicket()
    const res = await handleIntegrationClose(s.client, {
      ticketId: s.ticketId,
      businessId: s.second.business.id, integrationId: s.integration.id,
      actorDiscordId: s.manager.id,
      reason: 'All songs reviewed',
    })
    expect(res).toEqual({ status: 200, body: { closed: true, closedBy: 'actor' } })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.closedByUserId).toBe(await userIdFor(s.manager.id))
    expect(s.opener.sentDMs[0].content).toContain('closed by manager')
    expect(s.opener.sentDMs[0].content).toContain('Reason: All songs reviewed')
    const [closed] = (await db.select().from(auditLogs).where(eq(auditLogs.ticketId, s.ticketId))).filter((a) => a.action === 'closed')
    expect(closed.metadata).toMatchObject({ via: `integration:${s.integration.slug}`, reason: 'All songs reviewed' })
  })

  it('a non-staff actor falls back to the bot as closer (closedBy: bot)', async () => {
    const s = await openIntegrationTicket()
    const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id, actorDiscordId: s.outsider.id })
    expect(res).toEqual({ status: 200, body: { closed: true, closedBy: 'bot' } })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.closedByUserId).toBe(await userIdFor(s.guild.me.id))
  })

  // Integration actor staff = category staff ∪ team staff ∪ team admin roles —
  // identical to the web's checkActor; ManageGuild / sudo do NOT count.
  for (const [label, opts, expected] of [
    ['team staff (businesses.staff_role_ids) only', { roles: [TEAM_STAFF_ROLE] }, 'actor'],
    ['team admin role only', { roles: [ADMIN_ROLE] }, 'actor'],
    ['Manage Server with no staff role', { manageGuild: true }, 'bot'],
    ['a pending member holding a staff role', { roles: [TEAM_STAFF_ROLE], pending: true }, 'bot'],
  ] as const) {
    it(`close actor rule: ${label} → closedBy ${expected}`, async () => {
      const s = await openIntegrationTicket()
      const actor = s.guild.addMember({ username: 'actor', ...opts })
      const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id, actorDiscordId: actor.id })
      expect(res).toEqual({ status: 200, body: { closed: true, closedBy: expected } })
      const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
      expect(t.closedByUserId).toBe(await userIdFor(expected === 'actor' ? actor.id : s.guild.me.id))
    })
  }

  it('the DB-only close (channel gone) also reports closedBy and records the staff actor', async () => {
    const s = await openIntegrationTicket()
    await s.channel.delete()
    const actor = s.guild.addMember({ username: 'teamstaff', roles: [TEAM_STAFF_ROLE] })
    const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id, actorDiscordId: actor.id })
    expect(res).toEqual({ status: 200, body: { closed: true, closedBy: 'actor' } })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.closedByUserId).toBe(await userIdFor(actor.id))
  })

  it('human Discord flows are unchanged: Manage Server still passes the Close button', async () => {
    const s = await openIntegrationTicket()
    const mg = s.guild.addMember({ username: 'mod', manageGuild: true })
    const i = buttonInteraction(s.guild, s.channel, mg, `tk:close:${s.ticketId}`)
    await handleTicketClose(i as any)
    expect(componentsJson((i.editReply.mock.calls[0] as any)[0])).toContain(`tk:close_confirm:${s.ticketId}`)
  })

  it('409 already_closed; 403 for a mismatched business, 404 for another integration, 400 without integrationId', async () => {
    const s = await openIntegrationTicket()
    expect(await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.first.business.id, integrationId: s.integration.id })).toEqual({
      status: 403,
      body: { error: 'integration_forbidden' },
    })
    const sibling = await seedIntegration(s.second.business.id)
    expect(await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: sibling.id })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id })).status).toBe(400)
    await db.update(integrations).set({ enabled: false }).where(eq(integrations.id, s.integration.id))
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).status).toBe(403)
    await db.update(integrations).set({ enabled: true }).where(eq(integrations.id, s.integration.id))
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).status).toBe(200)
    expect(await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).toEqual({
      status: 409,
      body: { error: 'already_closed' },
    })
  })

  it('closes the row when the channel is already gone', async () => {
    const s = await openIntegrationTicket()
    await s.channel.delete()
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).status).toBe(200)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('closed')
  })

  it('a transient channel fetch error → 503 guild_unavailable, row untouched; the retry closes fully', async () => {
    const s = await openIntegrationTicket()
    const realFetch = s.guild.channels.fetch
    for (const e of [
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
      Object.assign(new Error('Missing Access'), { code: 50001 }),
      new TypeError('fetch failed'),
    ]) {
      s.guild.channels.fetch = async () => {
        throw e
      }
      expect(await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).toEqual({
        status: 503,
        body: { error: 'guild_unavailable' },
      })
      const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
      expect(t.status).toBe('open')
      expect(t.closedAt).toBeNull()
      expect(s.channel.deleted).toBe(false)
    }
    s.guild.channels.fetch = realFetch
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).status).toBe(200)
    expect(s.channel.deleted).toBe(true)
    expect(s.opener.sentDMs).toHaveLength(1)
  })

  it('a channel id that now resolves to a non-text channel counts as gone', async () => {
    const s = await openIntegrationTicket()
    s.guild.channelMap.set(s.channel.id, { id: s.channel.id, type: ChannelType.GuildVoice })
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })).status).toBe(200)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('closed')
  })

  it('markdown: an already-escaped reason (the web escapes it) reaches the DM verbatim — never double-escaped', async () => {
    const s = await openIntegrationTicket()
    const reason = '\\[Approve\\](https://evil.example) \\*\\*done\\*\\*'
    await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id, reason })
    expect(s.opener.sentDMs[0].content).toContain(`Reason: ${reason}`)
  })
})


// v0.9.0: closing also posts a copium.pics text paste and links it in the DM.
describe('Close → copium.pics transcript paste', () => {
  const PAGE_URL = 'https://tucker.copium.pics/i/qVx79Apa'
  let pasteCalls: { url: string; init: RequestInit }[]
  let albumCalls: { url: string; init: RequestInit }[]

  function routeCopium(
    response: () => Response | Promise<Response>,
    albumResponse: () => Response | Promise<Response> = () => new Response(JSON.stringify({ added: 1, album: {} }), { status: 200 }),
  ) {
    pasteCalls = []
    albumCalls = []
    vi.mocked(globalThis.fetch).mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('https://copium.pics/api/albums/')) {
        albumCalls.push({ url, init })
        return albumResponse()
      }
      if (url.startsWith('https://copium.pics/')) {
        pasteCalls.push({ url, init })
        return response()
      }
      return new Response('{}', { status: 200 })
    })
  }

  beforeEach(() => {
    Object.assign(env, { COPIUM_TOKEN: 'copium-test-token', COPIUM_LINK_HOST: 'i.tucker.host' })
  })
  afterEach(() => {
    Object.assign(env, { COPIUM_TOKEN: undefined, COPIUM_LINK_HOST: undefined, COPIUM_ALBUM_ID: undefined })
  })

  async function close(s: Awaited<ReturnType<typeof openIntegrationTicket>>) {
    const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, integrationId: s.integration.id })
    expect(res.status).toBe(200)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    return t
  }

  it('success: the DM carries the paste link (custom host) and the column is set', async () => {
    const s = await openIntegrationTicket()
    routeCopium(() => new Response(JSON.stringify({ id: 'qVx79Apa', pageUrl: PAGE_URL }), { status: 201 }))
    const t = await close(s)

    expect(pasteCalls).toHaveLength(1)
    const body = JSON.parse(String(pasteCalls[0].init.body))
    expect(body.title).toBe(`Ticket #${s.ticketId} — ${s.channel.name} (Test Guild)`)
    expect(body.language).toBe('plaintext')
    expect(body.content).toContain(`Ticket #${s.ticketId}`)

    expect(t.status).toBe('closed')
    expect(t.externalTranscriptUrl).toBe('https://i.tucker.host/i/qVx79Apa')
    expect(s.channel.deleted).toBe(true)
    expect(s.opener.sentDMs).toHaveLength(1)
    const dm = s.opener.sentDMs[0].content!
    expect(dm).toContain(`https://tickets.example.test/b/${s.second.business.slug}/tickets/${s.ticketId}`)
    expect(dm).toContain('\n\nTranscript: https://i.tucker.host/i/qVx79Apa')
    expect(dm).toContain('A full transcript is attached.')
    expect((s.opener.sentDMs[0] as any).files).toHaveLength(1)
  })

  it('never overwrites an existing external_transcript_url (TicketTool imports)', async () => {
    const s = await openIntegrationTicket()
    await db.update(tickets).set({ externalTranscriptUrl: 'https://tickettool.example/t/1' }).where(eq(tickets.id, s.ticketId))
    routeCopium(() => new Response(JSON.stringify({ pageUrl: PAGE_URL }), { status: 201 }))
    const t = await close(s)
    expect(t.externalTranscriptUrl).toBe('https://tickettool.example/t/1')
    expect(s.opener.sentDMs[0].content).toContain('Transcript: https://i.tucker.host/i/qVx79Apa')
  })

  it('failure (401): close still completes, the DM is still sent without the link, column untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await openIntegrationTicket()
    routeCopium(() => new Response(JSON.stringify({ error: 'Upload token is invalid or was revoked' }), { status: 401 }))
    const t = await close(s)
    expect(pasteCalls).toHaveLength(1)
    expect(t.status).toBe('closed')
    expect(t.externalTranscriptUrl).toBeNull()
    expect(s.channel.deleted).toBe(true)
    expect(s.opener.sentDMs).toHaveLength(1)
    expect(s.opener.sentDMs[0].content).not.toContain('Transcript:')
    expect(s.opener.sentDMs[0].content).toContain('A full transcript is attached.')
  })

  it('failure (fetch throws): close still completes and the DM is still sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await openIntegrationTicket()
    routeCopium(() => {
      throw new TypeError('fetch failed')
    })
    const t = await close(s)
    expect(t.status).toBe('closed')
    expect(t.externalTranscriptUrl).toBeNull()
    expect(s.opener.sentDMs).toHaveLength(1)
    expect(s.opener.sentDMs[0].content).not.toContain('Transcript:')
  })

  it('disabled (no COPIUM_TOKEN): no paste request at all', async () => {
    Object.assign(env, { COPIUM_TOKEN: undefined })
    const s = await openIntegrationTicket()
    routeCopium(() => new Response(JSON.stringify({ pageUrl: PAGE_URL }), { status: 201 }))
    const t = await close(s)
    expect(pasteCalls).toHaveLength(0)
    expect(t.externalTranscriptUrl).toBeNull()
    expect(s.opener.sentDMs[0].content).not.toContain('Transcript:')
  })

  it('album: a successful paste is added to COPIUM_ALBUM_ID (exact URL, headers, body)', async () => {
    Object.assign(env, { COPIUM_ALBUM_ID: 'alb123' })
    const s = await openIntegrationTicket()
    routeCopium(() => new Response(JSON.stringify({ id: 'qVx79Apa', pageUrl: PAGE_URL }), { status: 201 }))
    const t = await close(s)
    // Fire-and-forget: the request is issued, but close does not wait for it.
    await vi.waitFor(() => expect(albumCalls).toHaveLength(1))
    expect(albumCalls[0].url).toBe('https://copium.pics/api/albums/alb123/images')
    expect(albumCalls[0].init.method).toBe('POST')
    expect(albumCalls[0].init.headers).toEqual({
      Authorization: 'Bearer copium-test-token',
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
    })
    expect(JSON.parse(String(albumCalls[0].init.body))).toEqual({ imageIds: ['qVx79Apa'] })
    expect(t.externalTranscriptUrl).toBe('https://i.tucker.host/i/qVx79Apa')
    expect(s.opener.sentDMs[0].content).toContain('Transcript: https://i.tucker.host/i/qVx79Apa')
  })

  it('album: no COPIUM_ALBUM_ID → no album request', async () => {
    const s = await openIntegrationTicket()
    routeCopium(() => new Response(JSON.stringify({ id: 'qVx79Apa', pageUrl: PAGE_URL }), { status: 201 }))
    await close(s)
    await new Promise((r) => setTimeout(r, 50))
    expect(pasteCalls).toHaveLength(1)
    expect(albumCalls).toHaveLength(0)
  })

  it('album: a failed album add keeps the DM link, the column and the close', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.assign(env, { COPIUM_ALBUM_ID: 'alb123' })
    for (const albumResponse of [
      () => new Response(JSON.stringify({ error: 'Album not found' }), { status: 404 }),
      () => new Response(JSON.stringify({ added: 0 }), { status: 200 }),
      (): Response => {
        throw new TypeError('fetch failed')
      },
    ]) {
      const s = await openIntegrationTicket()
      routeCopium(() => new Response(JSON.stringify({ id: 'qVx79Apa', pageUrl: PAGE_URL }), { status: 201 }), albumResponse)
      const t = await close(s)
      await vi.waitFor(() => expect(albumCalls).toHaveLength(1))
      expect(t.status).toBe('closed')
      expect(t.externalTranscriptUrl).toBe('https://i.tucker.host/i/qVx79Apa')
      expect(s.channel.deleted).toBe(true)
      expect(s.opener.sentDMs).toHaveLength(1)
      expect(s.opener.sentDMs[0].content).toContain('Transcript: https://i.tucker.host/i/qVx79Apa')
    }
  })

  it('album: close completes (channel deleted, DM sent, row closed) while the album request is still pending', async () => {
    Object.assign(env, { COPIUM_ALBUM_ID: 'alb123' })
    const s = await openIntegrationTicket()
    let albumSettled = false
    routeCopium(
      () => new Response(JSON.stringify({ id: 'qVx79Apa', pageUrl: PAGE_URL }), { status: 201 }),
      // Never resolves (ignores the abort signal too).
      () => new Promise<Response>(() => {}).finally(() => (albumSettled = true)),
    )
    const t = await close(s)
    expect(albumCalls).toHaveLength(1)
    expect(albumSettled).toBe(false)
    expect(t.status).toBe('closed')
    expect(t.externalTranscriptUrl).toBe('https://i.tucker.host/i/qVx79Apa')
    expect(s.channel.deleted).toBe(true)
    expect(s.opener.sentDMs).toHaveLength(1)
    expect(s.opener.sentDMs[0].content).toContain('Transcript: https://i.tucker.host/i/qVx79Apa')
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.ticketId, s.ticketId))
    expect(audits.some((a) => a.action === 'closed')).toBe(true)
  })
})
