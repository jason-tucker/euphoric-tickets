import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { db } from '../src/db/client'
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

