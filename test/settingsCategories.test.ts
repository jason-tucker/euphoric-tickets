import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { businesses, ticketCategories } from '../src/db/schema'
import { getPanelCategories, replaceTicketCategories } from '../src/services/settingsService'
import { handleSettingsModalSubmit } from '../src/interactions/modals/settingsModal'
import { seedTeam } from './fakes'
import { stubFetch } from './helpers'

const MANAGER_ROLE = '200000000000000011'

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

// A team with one integration_only category (as sudo/seed would create it,
// with its own staff roles and parent) plus one ordinary category.
async function teamWithIntegrationCategory() {
  const s = await seedTeam({ category: { key: 'newsong', label: 'New song', staffRoleIds: MANAGER_ROLE, integrationOnly: true } })
  const parent = s.guild.addCategory()
  await db.update(ticketCategories).set({ discordParentCategoryId: parent, sortOrder: '7' }).where(eq(ticketCategories.id, s.category.id))
  await db.insert(ticketCategories).values({ businessId: s.business.id, key: 'support', label: 'Support' })
  const [integrationCat] = await db.select().from(ticketCategories).where(eq(ticketCategories.id, s.category.id))
  return { ...s, integrationCat }
}

async function categoriesOf(businessId: string) {
  return db.select().from(ticketCategories).where(eq(ticketCategories.businessId, businessId))
}

function modalSubmit(s: Awaited<ReturnType<typeof teamWithIntegrationCategory>>, panelJson: string) {
  const admin = s.guild.addMember({ manageGuild: true })
  const fields: Record<string, string> = {
    category_id: s.parentId,
    staff_role_ids: '200000000000000099',
    panel_categories: panelJson,
    tickettool_category_ids: '',
    tickettool_prefix: '$',
  }
  return {
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
}

describe('settings modal vs integration_only categories', () => {
  it('(1) the editable JSON excludes integration_only categories', async () => {
    const s = await teamWithIntegrationCategory()
    const cats = await getPanelCategories(s.guild.id, s.business)
    expect(cats.map((c) => c.key)).toEqual(['support'])
  })

  it('(1) replaceTicketCategories preserves integration_only rows untouched and replaces the rest', async () => {
    const s = await teamWithIntegrationCategory()
    const res = await replaceTicketCategories(s.guild.id, [{ key: 'billing', label: 'Billing' }, { key: 'help', label: 'Help' }], s.business)
    expect(res).toEqual({ ok: true })
    const after = await categoriesOf(s.business.id)
    expect(after.map((c) => c.key).sort()).toEqual(['billing', 'help', 'newsong'])
    const kept = after.find((c) => c.key === 'newsong')!
    // Same row (id), same config — not deleted and re-inserted.
    expect(kept).toEqual(s.integrationCat)
  })

  it('(1) an empty JSON list still keeps integration_only rows', async () => {
    const s = await teamWithIntegrationCategory()
    expect(await replaceTicketCategories(s.guild.id, [], s.business)).toEqual({ ok: true })
    const after = await categoriesOf(s.business.id)
    expect(after).toEqual([s.integrationCat])
  })

  it('(1) end-to-end modal save keeps the integration_only category and its staff roles', async () => {
    const s = await teamWithIntegrationCategory()
    const i = modalSubmit(s, JSON.stringify([{ key: 'support', label: 'Support v2' }]))
    await handleSettingsModalSubmit(i as any)
    expect(String((i.editReply.mock.calls.at(-1) as any)[0].content)).toContain('Settings saved')
    const after = await categoriesOf(s.business.id)
    expect(after.find((c) => c.key === 'support')!.label).toBe('Support v2')
    expect(after.find((c) => c.key === 'newsong')).toEqual(s.integrationCat)
  })

  it('(2) refuses a JSON category whose key matches an integration_only one (any case)', async () => {
    const s = await teamWithIntegrationCategory()
    for (const key of ['newsong', 'NewSong']) {
      const res = await replaceTicketCategories(s.guild.id, [{ key: 'support', label: 'Support' }, { key, label: 'Hijack' }], s.business)
      expect(res.ok).toBe(false)
      expect(!res.ok && res.reason).toContain(`\`${key}\``)
      expect(!res.ok && res.reason).toContain('integration-only')
    }
    // Nothing changed.
    const after = await categoriesOf(s.business.id)
    expect(after.map((c) => c.key).sort()).toEqual(['newsong', 'support'])
    expect(after.find((c) => c.key === 'newsong')).toEqual(s.integrationCat)
  })

  it('(2) the modal refuses the clash before writing anything (no partial save)', async () => {
    const s = await teamWithIntegrationCategory()
    const i = modalSubmit(s, JSON.stringify([{ key: 'newsong', label: 'Mine now' }]))
    await handleSettingsModalSubmit(i as any)
    const reply = String((i.editReply.mock.calls.at(-1) as any)[0])
    expect(reply).toContain('Could not save')
    expect(reply).toContain('reserved by an integration-only category')
    const [biz] = await db.select().from(businesses).where(eq(businesses.id, s.business.id))
    expect(biz.adminRoleIds).toBe(s.business.adminRoleIds) // business settings untouched
    const after = await categoriesOf(s.business.id)
    expect(after.find((c) => c.key === 'newsong')).toEqual(s.integrationCat)
    expect(after.find((c) => c.key === 'support')!.label).toBe('Support')
  })

  it('other teams in the same guild are unaffected', async () => {
    const s = await teamWithIntegrationCategory()
    const other = await seedTeam({ guild: s.guild, category: { key: 'newsong', integrationOnly: false } })
    expect(await replaceTicketCategories(s.guild.id, [{ key: 'x', label: 'X' }], other.business)).toEqual({ ok: true })
    expect(
      await db.select().from(ticketCategories).where(and(eq(ticketCategories.businessId, s.business.id), eq(ticketCategories.key, 'newsong'))),
    ).toEqual([s.integrationCat])
  })
})
