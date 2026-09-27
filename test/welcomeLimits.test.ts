import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { ticketCategories } from '../src/db/schema'
import { buildTicketWelcome, CLAIM_SUFFIX_RESERVE, TOTAL_TEXT_MAX } from '../src/services/ticketRenderer'
import { handleIntegrationOpen } from '../src/services/integrationTickets'
import { handleTicketClaim } from '../src/interactions/buttons/ticketClaim'
import { assertDiscordLimits, fakeClient, seedTeam, textDisplays } from './fakes'
import { openBody, seedIntegration, stubFetch } from './helpers'

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// The largest card the web accepts: title 100 + 25 lines × 200.
const maxCard = {
  title: 'T'.repeat(100),
  lines: Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(200, 'L')),
  link: { label: 'Open in portal', url: 'https://music.euphoric.fm/batches/12' },
}
const total = (p: unknown) => textDisplays(p as never).reduce((n, t) => n + t.length, 0)

describe('welcome card — Components V2 total text ≤ 4000', () => {
  const base = {
    ticketId: 123456,
    openerId: '100000000000000123',
    categoryLabel: 'C'.repeat(80),
    categoryEmoji: '🎵',
    subject: 'S'.repeat(100),
    staffRoleIds: [],
    webUrl: 'https://tickets.example.test/b/x/tickets/1',
  }

  it('a max card alone is truncated with an ellipsis to fit', () => {
    const w = buildTicketWelcome({ ...base, claimerId: null, card: maxCard })
    expect(total(w)).toBeLessThanOrEqual(TOTAL_TEXT_MAX)
    const body = textDisplays(w as never)[1]
    expect(body.endsWith('…')).toBe(true)
    expect(body.startsWith(`### ${maxCard.title}`)).toBe(true)
    expect(() => assertDiscordLimits(w as never)).not.toThrow()
  })

  it('template (2000) + max card + claimer suffix still fits; the card body is the one cut', () => {
    const template = 'M'.repeat(2000)
    for (const claimerId of [null, '100000000000000999']) {
      const w = buildTicketWelcome({ ...base, claimerId, firstMessage: template, card: maxCard })
      const texts = textDisplays(w as never)
      expect(total(w)).toBeLessThanOrEqual(TOTAL_TEXT_MAX)
      expect(texts[1]).toBe(template)
      expect(texts[2].endsWith('…')).toBe(true)
      expect(() => assertDiscordLimits(w as never)).not.toThrow()
    }
  })

  it('initial render and Claim re-render truncate the card identically', () => {
    const a = textDisplays(buildTicketWelcome({ ...base, claimerId: null, card: maxCard }) as never)
    const b = textDisplays(buildTicketWelcome({ ...base, claimerId: '100000000000000999', card: maxCard }) as never)
    expect(b[1]).toBe(a[1])
  })

  it('reserves exactly the maximum claimer suffix (37 chars): a clipped body fills the rest, a 20-digit claim hits 4000', () => {
    expect(CLAIM_SUFFIX_RESERVE).toBe(37)
    const maxClaimer = '18446744073709551615' // u64 max — the longest possible snowflake
    expect(` · claimed by <@${maxClaimer}>`.length).toBe(CLAIM_SUFFIX_RESERVE)
    const open = buildTicketWelcome({ ...base, claimerId: null, card: maxCard })
    const claimed = buildTicketWelcome({ ...base, claimerId: maxClaimer, card: maxCard })
    expect(total(open)).toBe(TOTAL_TEXT_MAX - CLAIM_SUFFIX_RESERVE)
    expect(total(claimed)).toBe(TOTAL_TEXT_MAX)
    expect(() => assertDiscordLimits(claimed as never)).not.toThrow()
  })

  it('a non-integration template that fits beside the header and the claimer reserve is not clipped', () => {
    const header = textDisplays(buildTicketWelcome({ ...base, claimerId: null, firstMessage: 'x' }) as never)[0]
    const room = TOTAL_TEXT_MAX - header.length - CLAIM_SUFFIX_RESERVE
    const fits = 'M'.repeat(room)
    expect(textDisplays(buildTicketWelcome({ ...base, claimerId: null, firstMessage: fits }) as never)[1]).toBe(fits)
    const over = textDisplays(buildTicketWelcome({ ...base, claimerId: null, firstMessage: fits + 'M' }) as never)[1]
    expect(over).toHaveLength(room)
    expect(over.endsWith('…')).toBe(true)
  })

  it('a small card is left intact', () => {
    const card = { title: 'Batch', lines: ['one', 'two'], link: null }
    expect(textDisplays(buildTicketWelcome({ ...base, claimerId: null, card }) as never)[1]).toBe('### Batch\none\ntwo')
  })

  it('end to end: a template category + max card opens with the card, and Claim re-renders within limits', async () => {
    const s = await seedTeam({ category: { integrationOnly: true, label: 'L'.repeat(80) } })
    await db
      .update(ticketCategories)
      .set({ firstMessageTemplate: `Hi {{user}} — ${'M'.repeat(1900)}` })
      .where(eq(ticketCategories.id, s.category.id))
    const opener = s.guild.addMember({ username: 'songwriter' })
    const staff = s.guild.addMember({ manageGuild: true })
    const integration = await seedIntegration(s.business.id)
    const client = fakeClient(s.guild)
    const res = await handleIntegrationOpen(
      client,
      openBody({ integration, business: s.business, category: s.category, openerDiscordId: opener.id, card: maxCard }),
    )
    expect(res.status).toBe(201)
    const ch = s.guild.liveTextChannels()[0]
    expect(ch.sent).toHaveLength(2)
    expect(textDisplays(ch.sent[1])).toHaveLength(3) // header, template, card — first try, no fallback

    const edit = vi.fn(async (p: unknown) => {
      assertDiscordLimits(p as never)
      return {}
    })
    const i = {
      inGuild: () => true,
      guild: s.guild,
      customId: `tk:claim:${res.body.ticketId}`,
      channelId: ch.id,
      channel: ch,
      user: { id: staff.id },
      message: { edit },
      deferUpdate: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    }
    await handleTicketClaim(i as any)
    expect(edit).toHaveBeenCalledTimes(1)
    await expect(edit.mock.results[0].value).resolves.toEqual({})
    expect(total(edit.mock.calls[0][0])).toBeLessThanOrEqual(TOTAL_TEXT_MAX)
  })
})
