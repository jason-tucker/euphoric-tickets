import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PermissionFlagsBits, PermissionsBitField, type GuildMember } from 'discord.js'
import type { Business } from '../db/schema/businesses'

vi.mock('../db/client', async () => {
  const { FakeDb } = await import('../test/dbMock')
  return { db: new FakeDb(), closeDb: async () => {} }
})
vi.mock('./sudoService', () => ({ isSudoUser: vi.fn(() => false) }))
vi.mock('./userResolver', () => ({
  getDiscordIdForUserId: vi.fn(async () => null as string | null),
  getOrCreateUserByDiscordId: vi.fn(async () => 'user-uuid'),
}))

import { db } from '../db/client'
import type { FakeDb } from '../test/dbMock'
import { isSudoUser } from './sudoService'
import { getDiscordIdForUserId } from './userResolver'
import {
  canManageGuildSettings,
  canOpenCategory,
  isAdminForBusiness,
  isStaffForCategory,
  parseCsv,
  resolveTicketAccess,
  resolveTicketAccessByChannel,
  staffRoleIdsForCategory,
} from './permissions'

const fakeDb = db as unknown as FakeDb

// roles.cache only needs `.has(id)` — a Map keyed by role id is enough to
// stand in for discord.js's Collection. PermissionsBitField is the real class
// (pure data), so Administrator → ManageGuild subsumption stays authentic.
function fakeMember(opts: { id?: string; roles?: string[]; manageGuild?: boolean; administrator?: boolean } = {}): GuildMember {
  const bits: bigint[] = []
  if (opts.manageGuild) bits.push(PermissionFlagsBits.ManageGuild)
  if (opts.administrator) bits.push(PermissionFlagsBits.Administrator)
  return {
    id: opts.id ?? '100000000000000001',
    permissions: new PermissionsBitField(bits),
    roles: { cache: new Map((opts.roles ?? []).map((r) => [r, true])) },
  } as unknown as GuildMember
}

function fakeBusiness(adminRoleIds = ''): Business {
  return { id: 'biz-1', slug: 'team', adminRoleIds } as Business
}

beforeEach(() => {
  fakeDb.reset()
  vi.mocked(isSudoUser).mockReturnValue(false)
  vi.mocked(getDiscordIdForUserId).mockResolvedValue(null)
})

describe('parseCsv', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseCsv(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
  })
  it('returns [] for null/undefined/empty', () => {
    expect(parseCsv(null)).toEqual([])
    expect(parseCsv(undefined)).toEqual([])
    expect(parseCsv('')).toEqual([])
  })
})

describe('staffRoleIdsForCategory', () => {
  it('prefers the per-category staff roles when set', () => {
    expect(staffRoleIdsForCategory(fakeBusiness('1,2'), { staffRoleIds: '3,4' })).toEqual(['3', '4'])
  })
  it('falls back to business admin roles when the category list is empty', () => {
    expect(staffRoleIdsForCategory(fakeBusiness('1,2'), { staffRoleIds: '' })).toEqual(['1', '2'])
    expect(staffRoleIdsForCategory(fakeBusiness('1,2'), null)).toEqual(['1', '2'])
  })
})

describe('isAdminForBusiness', () => {
  it('grants admin to Manage Server', () => {
    expect(isAdminForBusiness(fakeMember({ manageGuild: true }), fakeBusiness())).toBe(true)
  })
  it('grants admin to Administrator (subsumes Manage Server)', () => {
    expect(isAdminForBusiness(fakeMember({ administrator: true }), fakeBusiness())).toBe(true)
  })
  it('grants admin to a Ticket Master role from admin_role_ids', () => {
    expect(isAdminForBusiness(fakeMember({ roles: ['555'] }), fakeBusiness('444,555'))).toBe(true)
  })
  it('grants admin to sudo users regardless of roles', () => {
    vi.mocked(isSudoUser).mockReturnValue(true)
    expect(isAdminForBusiness(fakeMember(), fakeBusiness())).toBe(true)
  })
  it('denies a plain member', () => {
    expect(isAdminForBusiness(fakeMember({ roles: ['999'] }), fakeBusiness('444'))).toBe(false)
  })
})

describe('canManageGuildSettings', () => {
  it('passes a Ticket Master of ANY team on a multi-team server', () => {
    const teams = [fakeBusiness('111'), { ...fakeBusiness('222'), id: 'biz-2' } as Business]
    expect(canManageGuildSettings(fakeMember({ roles: ['222'] }), teams)).toBe(true)
  })
  it('denies a plain member even with teams present', () => {
    expect(canManageGuildSettings(fakeMember({ roles: ['999'] }), [fakeBusiness('111')])).toBe(false)
  })
  it('passes Manage Server with no teams at all', () => {
    expect(canManageGuildSettings(fakeMember({ manageGuild: true }), [])).toBe(true)
  })
})

describe('isStaffForCategory', () => {
  it('admins are always staff', () => {
    expect(isStaffForCategory(fakeMember({ manageGuild: true }), fakeBusiness(), { staffRoleIds: '777' })).toBe(true)
  })
  it('matches a per-category staff role', () => {
    expect(isStaffForCategory(fakeMember({ roles: ['777'] }), fakeBusiness('444'), { staffRoleIds: '777' })).toBe(true)
  })
  it('an empty category list falls back to business admin roles', () => {
    expect(isStaffForCategory(fakeMember({ roles: ['444'] }), fakeBusiness('444'), { staffRoleIds: '' })).toBe(true)
  })
  it('denies a member with no matching role', () => {
    expect(isStaffForCategory(fakeMember({ roles: ['999'] }), fakeBusiness('444'), { staffRoleIds: '777' })).toBe(false)
  })
})

describe('canOpenCategory', () => {
  it('empty allow_role_ids means anyone may open', () => {
    expect(canOpenCategory(fakeMember(), fakeBusiness(), { allowRoleIds: '' })).toBe(true)
  })
  it('non-empty allow_role_ids requires a matching role', () => {
    expect(canOpenCategory(fakeMember({ roles: ['10'] }), fakeBusiness(), { allowRoleIds: '10,11' })).toBe(true)
    expect(canOpenCategory(fakeMember({ roles: ['12'] }), fakeBusiness(), { allowRoleIds: '10,11' })).toBe(false)
  })
  it('admins bypass the allow list', () => {
    expect(canOpenCategory(fakeMember({ manageGuild: true }), fakeBusiness(), { allowRoleIds: '10' })).toBe(true)
  })
})

describe('resolveTicketAccess', () => {
  const ticket = { categoryId: 'cat-1', openerUserId: 'opener-uuid' }

  it('admin gets every flag including delete + change-category', async () => {
    fakeDb.queueSelect([{ id: 'cat-1', staffRoleIds: '' }])
    const access = await resolveTicketAccess(fakeMember({ manageGuild: true }), fakeBusiness(), ticket)
    expect(access).toMatchObject({
      isAdmin: true,
      isStaff: true,
      canClaim: true,
      canClose: true,
      canReply: true,
      canManageMembers: true,
      canChangeCategory: true,
      canDelete: true,
    })
  })

  it('staff can work the ticket but not delete or change category', async () => {
    fakeDb.queueSelect([{ id: 'cat-1', staffRoleIds: '777' }])
    const access = await resolveTicketAccess(fakeMember({ roles: ['777'] }), fakeBusiness('444'), ticket)
    expect(access).toMatchObject({
      isAdmin: false,
      isStaff: true,
      canClaim: true,
      canClose: true,
      canManageMembers: true,
      canChangeCategory: false,
      canDelete: false,
    })
  })

  it('the opener can close + reply to their own ticket but nothing else', async () => {
    fakeDb.queueSelect([{ id: 'cat-1', staffRoleIds: '777' }])
    vi.mocked(getDiscordIdForUserId).mockResolvedValue('100000000000000001')
    const access = await resolveTicketAccess(fakeMember({ id: '100000000000000001' }), fakeBusiness('444'), ticket)
    expect(access).toMatchObject({
      isOpener: true,
      isStaff: false,
      canClose: true,
      canReply: true,
      canClaim: false,
      canManageMembers: false,
      canDelete: false,
    })
  })

  it('a plain member gets nothing', async () => {
    fakeDb.queueSelect([{ id: 'cat-1', staffRoleIds: '777' }])
    const access = await resolveTicketAccess(fakeMember({ roles: ['999'] }), fakeBusiness('444'), ticket)
    expect(access).toMatchObject({
      isAdmin: false,
      isStaff: false,
      isOpener: false,
      canClaim: false,
      canClose: false,
      canReply: false,
      canDelete: false,
    })
  })

  it('an uncategorised ticket skips the category lookup and falls back to business roles', async () => {
    const access = await resolveTicketAccess(
      fakeMember({ roles: ['444'] }),
      fakeBusiness('444'),
      { categoryId: null, openerUserId: 'opener-uuid' },
    )
    expect(access.isStaff).toBe(true)
    expect(access.category).toBeNull()
  })
})

describe('resolveTicketAccessByChannel', () => {
  it('returns null when no ticket maps to the channel', async () => {
    fakeDb.queueSelect([])
    const res = await resolveTicketAccessByChannel(fakeMember(), fakeBusiness(), 'chan-1')
    expect(res).toBeNull()
  })

  it("resolves access against the ticket's OWN team on a multi-team server", async () => {
    // Ticket belongs to biz-2, not the guild-default biz-1 — staff roles must
    // come from biz-2's admin set.
    fakeDb.queueSelect([{ id: 7, businessId: 'biz-2', categoryId: null, openerUserId: 'opener-uuid' }])
    fakeDb.queueSelect([{ id: 'biz-2', slug: 'other-team', adminRoleIds: '888' }])
    const res = await resolveTicketAccessByChannel(fakeMember({ roles: ['888'] }), fakeBusiness('444'), 'chan-1')
    expect(res?.business.id).toBe('biz-2')
    expect(res?.access.isAdmin).toBe(true)
  })
})
