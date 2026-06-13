import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../db/client', async () => {
  const { FakeDb } = await import('../test/dbMock')
  return { db: new FakeDb(), closeDb: async () => {} }
})

import { db } from '../db/client'
import type { FakeDb } from '../test/dbMock'
import { backfillBusinessesForGuilds, ensureBusinessForGuild } from './businessProvision'

const fakeDb = db as unknown as FakeDb

beforeEach(() => {
  fakeDb.reset()
})

describe('ensureBusinessForGuild', () => {
  it('is a no-op when the guild already has a team', async () => {
    fakeDb.queueSelect([{ id: 'biz-1' }]) // existence check by guild id
    await ensureBusinessForGuild({ id: '123456789012345678', name: 'My Server' })
    expect(fakeDb.insertedValues).toHaveLength(0)
  })

  it('slugifies the guild name for the new team', async () => {
    fakeDb.queueSelect([]) // no existing team
    fakeDb.queueSelect([]) // slug 'my-cool-server' free
    await ensureBusinessForGuild({ id: '123456789012345678', name: '  My Cool Server!! 🎉 ' })
    expect(fakeDb.insertedValues).toEqual([
      { slug: 'my-cool-server', name: 'My Cool Server!! 🎉', discordGuildId: '123456789012345678' },
    ])
  })

  it('falls through to base-2 when the base slug is taken', async () => {
    fakeDb.queueSelect([]) // no existing team
    fakeDb.queueSelect([{ id: 'other' }]) // 'my-server' taken
    fakeDb.queueSelect([]) // 'my-server-2' free
    await ensureBusinessForGuild({ id: '123456789012345678', name: 'My Server' })
    expect(fakeDb.insertedValues[0]?.slug).toBe('my-server-2')
  })

  it('uses the guild-id fallback when the name yields no usable slug', async () => {
    fakeDb.queueSelect([]) // no existing team
    fakeDb.queueSelect([]) // 'team-345678' free
    await ensureBusinessForGuild({ id: '123456789012345678', name: '🔥🔥🔥' })
    expect(fakeDb.insertedValues[0]?.slug).toBe('team-345678')
    expect(fakeDb.insertedValues[0]?.name).toBe('🔥🔥🔥')
  })

  it('never throws into the caller when the DB fails', async () => {
    fakeDb.queueSelect(new Error('connection refused'))
    await expect(
      ensureBusinessForGuild({ id: '123456789012345678', name: 'My Server' }),
    ).resolves.toBeUndefined()
    expect(fakeDb.insertedValues).toHaveLength(0)
  })
})

describe('backfillBusinessesForGuilds', () => {
  it('provisions only the guilds missing a team row', async () => {
    // Batched existence query: g1 + g2 already provisioned.
    fakeDb.queueSelect([{ guildId: '111111111111111111' }, { guildId: '222222222222222222' }])
    // ensureBusinessForGuild(g3): existence check, then slug check.
    fakeDb.queueSelect([])
    fakeDb.queueSelect([])
    await backfillBusinessesForGuilds([
      { id: '111111111111111111', name: 'One' },
      { id: '222222222222222222', name: 'Two' },
      { id: '333333333333333333', name: 'Three' },
    ])
    expect(fakeDb.insertedValues).toHaveLength(1)
    expect(fakeDb.insertedValues[0]).toMatchObject({ slug: 'three', discordGuildId: '333333333333333333' })
  })

  it('falls back to per-guild checks when the batched query fails', async () => {
    fakeDb.queueSelect(new Error('boom')) // batched existence query fails
    fakeDb.queueSelect([{ id: 'biz-1' }]) // g1 already provisioned
    fakeDb.queueSelect([{ id: 'biz-2' }]) // g2 already provisioned
    await backfillBusinessesForGuilds([
      { id: '111111111111111111', name: 'One' },
      { id: '222222222222222222', name: 'Two' },
    ])
    expect(fakeDb.insertedValues).toHaveLength(0)
  })

  it('does nothing for an empty guild list', async () => {
    await backfillBusinessesForGuilds([])
    expect(fakeDb.insertedValues).toHaveLength(0)
  })
})
