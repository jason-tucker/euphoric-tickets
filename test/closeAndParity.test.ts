import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { auditLogs, tickets, users } from '../src/db/schema'
import { handleIntegrationClose, handleIntegrationOpen } from '../src/services/integrationTickets'
import { handleTicketClaim } from '../src/interactions/buttons/ticketClaim'
import { handleTicketClose } from '../src/interactions/buttons/ticketClose'
import { componentsJson, fakeClient, seedTeam, type FakeGuild, type FakeMember, type FakeTextChannel } from './fakes'
import { openBody, seedIntegration, stubFetch } from './helpers'

const ADMIN_ROLE = '200000000000000010' // team admin_role_ids ("Ticket Master")
const MANAGER_ROLE = '200000000000000011' // category staff only (EFM Managers)

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
    category: { key: 'newsong', staffRoleIds: MANAGER_ROLE, integrationOnly: true },
  })
  const guild = first.guild
  const opener = guild.addMember({ username: 'songwriter' })
  const manager = guild.addMember({ username: 'manager', roles: [MANAGER_ROLE] })
  const outsider = guild.addMember({ username: 'outsider' })
  const integration = await seedIntegration('efm-music')
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

describe('POST /api/internal/tickets/close', () => {
  it('no actor → closes as the bot; opener DM links the correct business', async () => {
    const s = await openIntegrationTicket()
    const res = await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id })
    expect(res).toEqual({ status: 200, body: { closed: true } })

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
    expect(closed.metadata).toMatchObject({ via: 'integration:efm-music' })
  })

  it('a staff actor is the closer; the reason reaches the DM and audit', async () => {
    const s = await openIntegrationTicket()
    const res = await handleIntegrationClose(s.client, {
      ticketId: s.ticketId,
      businessId: s.second.business.id,
      actorDiscordId: s.manager.id,
      reason: 'All songs reviewed',
    })
    expect(res.status).toBe(200)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.closedByUserId).toBe(await userIdFor(s.manager.id))
    expect(s.opener.sentDMs[0].content).toContain('closed by manager')
    expect(s.opener.sentDMs[0].content).toContain('Reason: All songs reviewed')
    const [closed] = (await db.select().from(auditLogs).where(eq(auditLogs.ticketId, s.ticketId))).filter((a) => a.action === 'closed')
    expect(closed.metadata).toMatchObject({ via: 'integration:efm-music', reason: 'All songs reviewed' })
  })

  it('a non-staff actor falls back to the bot as closer', async () => {
    const s = await openIntegrationTicket()
    await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id, actorDiscordId: s.outsider.id })
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.closedByUserId).toBe(await userIdFor(s.guild.me.id))
  })

  it('409 already_closed, and 404 for a mismatched business', async () => {
    const s = await openIntegrationTicket()
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.first.business.id })).status).toBe(404)
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id })).status).toBe(200)
    expect(await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id })).toEqual({
      status: 409,
      body: { error: 'already_closed' },
    })
  })

  it('closes the row when the channel is already gone', async () => {
    const s = await openIntegrationTicket()
    await s.channel.delete()
    expect((await handleIntegrationClose(s.client, { ticketId: s.ticketId, businessId: s.second.business.id })).status).toBe(200)
    const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId))
    expect(t.status).toBe('closed')
  })
})
