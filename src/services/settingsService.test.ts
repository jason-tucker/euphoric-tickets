import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/client', async () => {
  const { FakeDb } = await import('../test/dbMock')
  return { db: new FakeDb(), closeDb: async () => {} }
})

import { isSnowflake, parseSnowflakeCsv, validatePanelCategoriesJson } from './settingsService'

describe('isSnowflake', () => {
  it('accepts 17–20 digit ids', () => {
    expect(isSnowflake('12345678901234567')).toBe(true)
    expect(isSnowflake('12345678901234567890')).toBe(true)
  })
  it('rejects short ids, words, and embedded junk', () => {
    expect(isSnowflake('1234567890123456')).toBe(false)
    expect(isSnowflake('not-a-snowflake')).toBe(false)
    expect(isSnowflake('123456789012345678x')).toBe(false)
    expect(isSnowflake('')).toBe(false)
  })
})

describe('parseSnowflakeCsv', () => {
  it('partitions valid and invalid tokens, trimming whitespace', () => {
    const { ok, bad } = parseSnowflakeCsv(' 123456789012345678 , nope, 987654321098765432 ')
    expect(ok).toEqual(['123456789012345678', '987654321098765432'])
    expect(bad).toEqual(['nope'])
  })
  it('drops empty tokens entirely', () => {
    const { ok, bad } = parseSnowflakeCsv(',, ,')
    expect(ok).toEqual([])
    expect(bad).toEqual([])
  })
})

describe('validatePanelCategoriesJson', () => {
  it('accepts a valid category array and normalizes optional fields', () => {
    const res = validatePanelCategoriesJson(
      JSON.stringify([
        { key: 'support', label: 'Support', emoji: '🎫', description: 'General' },
        { key: 'billing', label: 'Billing' },
      ]),
    )
    expect(res).toEqual({
      ok: true,
      value: [
        { key: 'support', label: 'Support', emoji: '🎫', description: 'General' },
        { key: 'billing', label: 'Billing', emoji: undefined, description: undefined },
      ],
    })
  })

  it('rejects malformed JSON', () => {
    const res = validatePanelCategoriesJson('{not json')
    expect(res.ok).toBe(false)
  })

  it('rejects non-arrays and empty arrays', () => {
    expect(validatePanelCategoriesJson('{}').ok).toBe(false)
    expect(validatePanelCategoriesJson('[]').ok).toBe(false)
  })

  it('rejects more than 5 categories (Discord button-row cap)', () => {
    const six = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })),
    )
    const res = validatePanelCategoriesJson(six)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/at most 5/)
  })

  it('rejects bad keys and missing labels with the item index in the error', () => {
    const badKey = validatePanelCategoriesJson(JSON.stringify([{ key: 'has spaces!', label: 'X' }]))
    expect(badKey.ok).toBe(false)
    if (!badKey.ok) expect(badKey.error).toMatch(/Item 0/)

    const noLabel = validatePanelCategoriesJson(JSON.stringify([{ key: 'ok' }]))
    expect(noLabel.ok).toBe(false)
  })
})
