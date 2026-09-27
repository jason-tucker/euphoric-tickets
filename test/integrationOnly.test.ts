import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { tickets } from '../src/db/schema'
import { openTicket } from '../src/services/ticketService'
import { getPanelCategories } from '../src/services/settingsService'
import { handleTicketOpen } from '../src/interactions/buttons/ticketOpen'
import { execute as executeTickets } from '../src/commands/tickets'
import { seedTeam, snow, type FakeTextChannel } from './fakes'
import { stubFetch } from './helpers'
import { ticketCategories } from '../src/db/schema'

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('integration_only categories are refused outside the Integration API', () => {
  it('openTicket refuses them for the default (panel) source', async () => {
    const s = await seedTeam({ category: { key: 'newsong', integrationOnly: true } })
    const member = s.guild.addMember()
    const res = await openTicket({ guild: s.guild as any, opener: member as any, categoryKey: 'newsong', business: s.business })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.code).toBe('category_forbidden')
    expect(s.guild.liveTextChannels()).toHaveLength(0)
  })

  it('a stale panel button is refused (tk:open:<key>)', async () => {
    const s = await seedTeam({ category: { key: 'newsong', integrationOnly: true } })
    const member = s.guild.addMember({ manageGuild: true }) // even an admin
    const interaction = {
      inGuild: () => true,
      guild: s.guild,
      customId: 'tk:open:newsong',
      user: { id: member.id },
      message: { id: snow() },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    }
    await handleTicketOpen(interaction as any)
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("can't be opened from Discord"))
    expect(s.guild.liveTextChannels()).toHaveLength(0)
  })

  it('/tickets convert refuses an integration_only category', async () => {
    const s = await seedTeam({ category: { key: 'newsong', integrationOnly: true } })
    const admin = s.guild.addMember({ manageGuild: true })
    const channel = (await s.guild.channels.create({ name: 'general' })) as FakeTextChannel
    const interaction = {
      inGuild: () => true,
      guild: s.guild,
      user: { id: admin.id },
      channel,
      channelId: channel.id,
      options: {
        getSubcommand: () => 'convert',
        getString: (n: string) => (n === 'category' ? 'newsong' : null),
        getUser: () => null,
      },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    }
    await executeTickets(interaction as any)
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('integration-only'))
    expect(await db.select().from(tickets).where(eq(tickets.discordChannelId, channel.id))).toHaveLength(0)
  })

  it('panels never render a button for them', async () => {
    const s = await seedTeam({ category: { key: 'newsong', integrationOnly: true } })
    await db.insert(ticketCategories).values({ businessId: s.business.id, key: 'support', label: 'Support' })
    const cats = await getPanelCategories(s.guild.id, s.business)
    expect(cats.map((c) => c.key)).toEqual(['support'])
  })

  it('ordinary panel opens behave as before (dedupe, allow roles, subject)', async () => {
    const s = await seedTeam({ category: { key: 'support', label: 'Support' } })
    const member = s.guild.addMember({ username: 'alice' })
    const first = await openTicket({ guild: s.guild as any, opener: member as any, categoryKey: 'support', business: s.business })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.ticket.subject).toBe('support from alice')
    expect(first.ticket.integrationId).toBeNull()
    expect(first.ticket.discordWebhookUrl).toBeNull() // panel opens don't create webhooks (unchanged)
    const second = await openTicket({ guild: s.guild as any, opener: member as any, categoryKey: 'support', business: s.business })
    expect(!second.ok && second.code).toBe('duplicate')
  })
})
