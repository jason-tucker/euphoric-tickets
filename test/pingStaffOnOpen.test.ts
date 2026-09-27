import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { ticketCategories } from '../src/db/schema'
import { openTicket } from '../src/services/ticketService'
import { handleIntegrationOpen } from '../src/services/integrationTickets'
import { getPanelCategories, PANEL_JSON_MAX, panelCategoriesModalJson, replaceTicketCategories, validatePanelCategoriesJson } from '../src/services/settingsService'
import { handleSettingsModalSubmit } from '../src/interactions/modals/settingsModal'
import { componentsJson, fakeClient, seedTeam } from './fakes'
import { openBody, seedIntegration, stubFetch } from './helpers'

const STAFF_ROLE = '200000000000000021'

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ticket_categories.ping_staff_on_open — open message', () => {
  it('default (true): pings the opener and every staff role, as before', async () => {
    const s = await seedTeam({ category: { key: 'support', staffRoleIds: STAFF_ROLE } })
    const member = s.guild.addMember({ username: 'alice' })
    const res = await openTicket({ guild: s.guild as any, opener: member as any, categoryKey: 'support', business: s.business })
    expect(res.ok).toBe(true)
    const [ch] = s.guild.liveTextChannels()
    expect(ch.sent[0].content).toBe(`<@${member.id}> <@&${STAFF_ROLE}>`)
    expect(ch.sent[0].allowedMentions).toEqual({ users: [member.id], roles: [STAFF_ROLE] })
  })

  it('false (panel open): pings only the opener; staff keep channel access', async () => {
    const s = await seedTeam({
      category: { key: 'support', staffRoleIds: STAFF_ROLE, pingStaffOnOpen: false },
    })
    const member = s.guild.addMember({ username: 'alice' })
    const res = await openTicket({ guild: s.guild as any, opener: member as any, categoryKey: 'support', business: s.business })
    expect(res.ok).toBe(true)
    const [ch] = s.guild.liveTextChannels()
    expect(ch.sent[0].content).toBe(`<@${member.id}>`)
    expect(ch.sent[0].allowedMentions).toEqual({ users: [member.id], roles: [] })
    // Permissions untouched: the staff role still gets its overwrite.
    expect(ch.overwrites.map((o) => o.id).sort()).toEqual([s.guild.id, member.id, STAFF_ROLE].sort())
    // Welcome card follows, pinging nobody (unchanged).
    expect(componentsJson(ch.sent[1])).toContain('tk:claim:')
    expect(ch.sent[1].allowedMentions).toEqual({ parse: [] })
    // No other message in the open flow mentions a role.
    for (const m of ch.sent) expect((m.allowedMentions as any)?.roles ?? []).toEqual([])
  })

  it('false (Integration API open, e.g. EFM newsong): pings only the opener', async () => {
    const s = await seedTeam({ category: { staffRoleIds: STAFF_ROLE, integrationOnly: true, pingStaffOnOpen: false } })
    const opener = s.guild.addMember({ username: 'songwriter' })
    const integration = await seedIntegration(s.business.id, { allowedCategoryKeys: [s.category.key] })
    const body = openBody({ integration, business: s.business, category: s.category, openerDiscordId: opener.id })
    const res = await handleIntegrationOpen(fakeClient(s.guild), body)
    expect(res.status).toBe(201)
    const [ch] = s.guild.liveTextChannels()
    expect(ch.sent[0].content).toBe(`<@${opener.id}>`)
    expect(ch.sent[0].allowedMentions).toEqual({ users: [opener.id], roles: [] })
    expect(ch.overwrites.map((o) => o.id)).toContain(STAFF_ROLE)
  })
})

describe('ticket_categories.ping_staff_on_open — settings modal JSON', () => {
  async function teamWithTwo() {
    const s = await seedTeam({ category: { key: 'quiet', label: 'Quiet', pingStaffOnOpen: false } })
    await db.insert(ticketCategories).values({ businessId: s.business.id, key: 'loud', label: 'Loud', sortOrder: '1' })
    return s
  }
  async function pingOf(businessId: string) {
    const rows = await db.select().from(ticketCategories).where(eq(ticketCategories.businessId, businessId))
    return Object.fromEntries(rows.map((r) => [r.key, r.pingStaffOnOpen]))
  }

  it('the editable JSON shows the current value per category', async () => {
    const s = await teamWithTwo()
    const cats = await getPanelCategories(s.guild.id, s.business)
    expect(cats.map((c) => [c.key, c.pingStaffOnOpen])).toEqual([
      ['quiet', false],
      ['loud', true],
    ])
  })

  it('validation accepts booleans, rejects anything else, and leaves it absent when omitted', () => {
    const ok = validatePanelCategoriesJson(JSON.stringify([{ key: 'a', label: 'A', pingStaffOnOpen: false }, { key: 'b', label: 'B' }]))
    expect(ok.ok && ok.value).toEqual([
      { key: 'a', label: 'A', emoji: undefined, description: undefined, pingStaffOnOpen: false },
      { key: 'b', label: 'B', emoji: undefined, description: undefined },
    ])
    const bad = validatePanelCategoriesJson(JSON.stringify([{ key: 'a', label: 'A', pingStaffOnOpen: 'no' }]))
    expect(!bad.ok && bad.error).toContain('pingStaffOnOpen')
  })

  it('a round-trip of the shown JSON preserves each value', async () => {
    const s = await teamWithTwo()
    const shown = JSON.stringify(await getPanelCategories(s.guild.id, s.business))
    const parsed = validatePanelCategoriesJson(shown)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(await replaceTicketCategories(s.guild.id, parsed.value, s.business)).toEqual({ ok: true })
    expect(await pingOf(s.business.id)).toEqual({ quiet: false, loud: true })
  })

  it('omitting the field keeps the previous value; a new key defaults to true; explicit values win', async () => {
    const s = await teamWithTwo()
    await replaceTicketCategories(
      s.guild.id,
      [
        { key: 'quiet', label: 'Quiet' },
        { key: 'loud', label: 'Loud', pingStaffOnOpen: false },
        { key: 'fresh', label: 'Fresh' },
      ],
      s.business,
    )
    expect(await pingOf(s.business.id)).toEqual({ quiet: false, loud: false, fresh: true })
    await replaceTicketCategories(s.guild.id, [{ key: 'quiet', label: 'Quiet', pingStaffOnOpen: true }], s.business)
    expect(await pingOf(s.business.id)).toEqual({ quiet: true })
  })

  it('an integration_only category keeps ping_staff_on_open=false through a modal save', async () => {
    const s = await seedTeam({ category: { key: 'newsong', staffRoleIds: STAFF_ROLE, integrationOnly: true, pingStaffOnOpen: false } })
    await db.insert(ticketCategories).values({ businessId: s.business.id, key: 'support', label: 'Support' })
    const [before] = await db.select().from(ticketCategories).where(eq(ticketCategories.id, s.category.id))
    const admin = s.guild.addMember({ manageGuild: true })
    const fields: Record<string, string> = {
      category_id: s.parentId,
      staff_role_ids: '',
      panel_categories: JSON.stringify([{ key: 'support', label: 'Support v2' }]),
    }
    const i = {
      inGuild: () => true,
      guild: s.guild,
      client: { guilds: { fetch: async () => null } },
      user: { id: admin.id },
      customId: `tk:settings_modal:${s.business.slug}`,
      fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    }
    await handleSettingsModalSubmit(i as any)
    expect(String((i.editReply.mock.calls.at(-1) as any)[0].content)).toContain('Settings saved')
    const [after] = await db.select().from(ticketCategories).where(eq(ticketCategories.id, s.category.id))
    expect(after).toEqual(before)
    expect(after.pingStaffOnOpen).toBe(false)
  })
})

describe('settings modal JSON size (Discord TextInput 4000-char cap)', () => {
  it('keeps pingStaffOnOpen when it fits', () => {
    const cats = [{ key: 'a', label: 'A', pingStaffOnOpen: true }, { key: 'b', label: 'B', pingStaffOnOpen: false }]
    expect(panelCategoriesModalJson(cats)).toBe(JSON.stringify(cats, null, 2))
  })

  it('drops only default-true values when the JSON would overflow, and the result round-trips', () => {
    const long = 'x'.repeat(710)
    const cats = [0, 1, 2, 3, 4].map((n) => ({ key: `k${n}`, label: `L${n}`, description: long, pingStaffOnOpen: n !== 2 }))
    expect(JSON.stringify(cats, null, 2).length).toBeGreaterThan(PANEL_JSON_MAX)
    const out = panelCategoriesModalJson(cats)
    expect(out.length).toBeLessThanOrEqual(PANEL_JSON_MAX)
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>
    expect(parsed.map((c) => c.pingStaffOnOpen)).toEqual([undefined, undefined, false, undefined, undefined])
    expect(validatePanelCategoriesJson(out).ok).toBe(true)
  })
})
