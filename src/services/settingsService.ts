import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses } from '../db/schema/businesses'
import { ticketCategories } from '../db/schema/ticketCategories'
import { getBusinessByGuildId, invalidateBusinessCache } from './businessResolver'

export type PanelCategory = {
  key: string
  label: string
  emoji?: string
  description?: string
}

const SNOWFLAKE_RE = /^\d{17,20}$/

export const DEFAULT_PANEL_CATEGORIES: PanelCategory[] = [
  { key: 'support', label: 'Open a ticket', emoji: '🎫', description: 'General support' },
]

// All reads below scope by guild because that's how Discord interactions
// arrive. The bot used to be single-tenant and read raw key/value rows;
// now everything routes through `businesses` keyed on the Discord guild.

export async function getCategoryId(guildId: string): Promise<string | null> {
  const biz = await getBusinessByGuildId(guildId)
  return biz?.discordFallbackCategoryId ?? null
}

// Not in the web schema. Left as no-op so callers don't need conditional
// imports; the close path still DMs the opener regardless.
export async function getTranscriptChannelId(_guildId: string): Promise<string | null> {
  // TODO(web schema): add a transcript_channel_id column to businesses if
  // we want the bot to post HTML transcripts to a channel again.
  return null
}

// Not in the web schema either — log channel was bot-only. Same TODO.
export async function getLogChannelId(_guildId: string): Promise<string | null> {
  return null
}

export async function getStaffRoleIds(guildId: string): Promise<string[]> {
  const biz = await getBusinessByGuildId(guildId)
  if (!biz?.adminRoleIds) return []
  return biz.adminRoleIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function getPanelCategories(guildId: string): Promise<PanelCategory[]> {
  const biz = await getBusinessByGuildId(guildId)
  if (!biz) return DEFAULT_PANEL_CATEGORIES
  const rows = await db
    .select({
      key: ticketCategories.key,
      label: ticketCategories.label,
      emoji: ticketCategories.emoji,
      description: ticketCategories.description,
      staffOnly: ticketCategories.staffOnly,
    })
    .from(ticketCategories)
    .where(eq(ticketCategories.businessId, biz.id))
    .orderBy(asc(ticketCategories.sortOrder))

  if (rows.length === 0) return DEFAULT_PANEL_CATEGORIES
  // Discord ActionRow caps at 5 buttons. Staff-only destinations never get
  // a panel button — they exist only as move-into targets in the staff
  // change-category flow.
  return rows
    .filter((r) => !r.staffOnly)
    .slice(0, 5)
    .map((r) => ({
      key: r.key,
      label: r.label,
      emoji: r.emoji ?? undefined,
      description: r.description ?? undefined,
    }))
}

// Settings writes — used by /tickets settings modal. The category list
// is no longer JSON-on-a-key; admins manage it via the web UI. The modal
// here only writes the few business-level columns the bot still owns.
export async function updateBusinessSettings(
  guildId: string,
  patch: {
    discordFallbackCategoryId?: string | null
    adminRoleIds?: string
    ticketMode?: string
    ticketToolCategoryIds?: string
    ticketToolPrefix?: string
  },
): Promise<void> {
  await db
    .update(businesses)
    .set({ ...patch })
    .where(eq(businesses.discordGuildId, guildId))
  invalidateBusinessCache(guildId)
}

// Replace the bot's ticket categories for a guild with the given list.
// Wipes and re-inserts in a single transaction — the panel JSON in the
// settings modal is treated as the source of truth on submit.
export async function replaceTicketCategories(
  guildId: string,
  cats: PanelCategory[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const biz = await getBusinessByGuildId(guildId)
  if (!biz) {
    return {
      ok: false,
      reason: 'This server is not configured as a team — create one at https://tickets.euphoric.fm/admin.',
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(ticketCategories).where(eq(ticketCategories.businessId, biz.id))
    if (cats.length === 0) return
    await tx.insert(ticketCategories).values(
      cats.map((c, i) => ({
        businessId: biz.id,
        key: c.key,
        label: c.label,
        emoji: c.emoji ?? null,
        description: c.description ?? null,
        sortOrder: String(i),
      })),
    )
  })
  invalidateBusinessCache(guildId)
  return { ok: true }
}

// Unused on the read path now but kept for /tickets settings:
export async function findCategoryForGuild(
  guildId: string,
  key: string,
): Promise<{ id: string; discordParentCategoryId: string | null; label: string } | null> {
  const biz = await getBusinessByGuildId(guildId)
  if (!biz) return null
  const rows = await db
    .select({
      id: ticketCategories.id,
      discordParentCategoryId: ticketCategories.discordParentCategoryId,
      label: ticketCategories.label,
    })
    .from(ticketCategories)
    .where(and(eq(ticketCategories.businessId, biz.id), eq(ticketCategories.key, key)))
    .limit(1)
  return rows[0] ?? null
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

export function validatePanelCategoriesJson(
  input: string,
): { ok: true; value: PanelCategory[] } | { ok: false; error: string } {
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
