import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { ticketSettings } from '../db/schema/ticketSettings'
import { log } from './logger'

export type PanelCategory = {
  key: string
  label: string
  emoji?: string
  description?: string
}

export const SETTING_KEYS = {
  categoryId: 'tickets.category_id',
  transcriptChannelId: 'tickets.transcript_channel_id',
  logChannelId: 'tickets.log_channel_id',
  staffRoleIds: 'tickets.staff_role_ids',
  panelCategories: 'tickets.panel_categories',
} as const

const SNOWFLAKE_RE = /^\d{17,20}$/

export const DEFAULT_PANEL_CATEGORIES: PanelCategory[] = [
  { key: 'support', label: 'Open a ticket', emoji: '🎫', description: 'General support' },
]

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(ticketSettings).where(eq(ticketSettings.key, key)).limit(1)
  return rows[0]?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(ticketSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: ticketSettings.key,
      set: { value, updatedAt: sql`now()` },
    })
}

export async function getCategoryId(): Promise<string | null> {
  return getSetting(SETTING_KEYS.categoryId)
}

export async function getTranscriptChannelId(): Promise<string | null> {
  return getSetting(SETTING_KEYS.transcriptChannelId)
}

export async function getLogChannelId(): Promise<string | null> {
  return getSetting(SETTING_KEYS.logChannelId)
}

export async function getStaffRoleIds(): Promise<string[]> {
  const raw = await getSetting(SETTING_KEYS.staffRoleIds)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string')
  } catch (err) {
    log.warn('staff_role_ids JSON parse failed', { err: String(err) })
  }
  return []
}

export async function getPanelCategories(): Promise<PanelCategory[]> {
  const raw = await getSetting(SETTING_KEYS.panelCategories)
  if (!raw) return DEFAULT_PANEL_CATEGORIES
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .filter((c): c is PanelCategory => typeof c?.key === 'string' && typeof c?.label === 'string')
        .slice(0, 5) // Discord limit: 5 buttons per ActionRow
    }
  } catch (err) {
    log.warn('panel_categories JSON parse failed', { err: String(err) })
  }
  return DEFAULT_PANEL_CATEGORIES
}

export function parseSnowflakeCsv(input: string): { ok: string[]; bad: string[] } {
  const ok: string[] = []
  const bad: string[] = []
  for (const tok of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (SNOWFLAKE_RE.test(tok)) ok.push(tok)
    else bad.push(tok)
  }
  return { ok, bad }
}

export function isSnowflake(s: string): boolean {
  return SNOWFLAKE_RE.test(s)
}

export function validatePanelCategoriesJson(input: string): { ok: true; value: PanelCategory[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${String(err)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'Must be a JSON array' }
  if (parsed.length === 0) return { ok: false, error: 'At least one category is required' }
  if (parsed.length > 5) return { ok: false, error: 'Discord allows at most 5 buttons per row' }
  const out: PanelCategory[] = []
  for (const [idx, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: `Item ${idx} is not an object` }
    const obj = item as Record<string, unknown>
    if (typeof obj.key !== 'string' || !obj.key) return { ok: false, error: `Item ${idx}: "key" is required (string)` }
    if (!/^[a-z0-9_-]{1,32}$/i.test(obj.key)) return { ok: false, error: `Item ${idx}: "key" must match [a-z0-9_-]{1,32}` }
    if (typeof obj.label !== 'string' || !obj.label) return { ok: false, error: `Item ${idx}: "label" is required (string)` }
    out.push({
      key: obj.key,
      label: obj.label,
      emoji: typeof obj.emoji === 'string' ? obj.emoji : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
    })
  }
  return { ok: true, value: out }
}
