import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses } from '../db/schema/businesses'
import { invalidateBusinessCache } from './businessResolver'
import { log } from './logger'

// Auto-provisioning — the bot creates a `host` team row for any guild it's in
// so it works on a server with zero manual setup. The web owns the schema; this
// only inserts rows (same as the existing `/admin business create`). Multiple
// businesses may share a guild, so we provision only when the guild has none.

// Turn a guild name into a candidate slug: lowercase, non-alphanumerics → '-',
// collapse repeats, trim hyphens, clamp length. Returns '' when nothing usable
// survives (e.g. an all-emoji name) so the caller falls back to the guild id.
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// Find a slug not already taken. Tries the base, then base-2…base-5, then a
// guild-id-suffixed form which is effectively collision-proof. `businesses.slug`
// is unique in the DB, so even a lost race surfaces as a caught insert error.
async function uniqueSlug(base: string, guildId: string): Promise<string> {
  const candidates: string[] = []
  if (base) {
    candidates.push(base)
    for (let i = 2; i <= 5; i++) candidates.push(`${base}-${i}`)
  }
  candidates.push(`team-${guildId.slice(-6)}`, `g-${guildId}`)

  for (const slug of candidates) {
    if (!SLUG_RE.test(slug)) continue
    const [hit] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.slug, slug))
      .limit(1)
    if (!hit) return slug
  }
  return `g-${guildId}`
}

// Ensure a `host` team row exists for this guild. Idempotent: a no-op when the
// guild already maps to at least one team. Best-effort — never throws into the
// caller. Used on guildCreate (just added) and on startup backfill (guilds the
// bot was already in before auto-provisioning existed).
export async function ensureBusinessForGuild(guild: { id: string; name: string }): Promise<void> {
  try {
    const existing = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.discordGuildId, guild.id))
      .limit(1)
    if (existing.length > 0) return

    const base = slugifyName(guild.name ?? '')
    const slug = await uniqueSlug(base, guild.id)
    const name = (guild.name?.trim() || `Team ${guild.id.slice(-4)}`).slice(0, 80)

    await db.insert(businesses).values({
      slug,
      name,
      discordGuildId: guild.id,
    })
    invalidateBusinessCache(guild.id)
    log.info('auto-provisioned team for guild', { guildId: guild.id, slug })
  } catch (err) {
    log.error('ensureBusinessForGuild failed', { guildId: guild.id, err: String(err) })
  }
}

// Backfill — make sure every guild the bot is currently in has a team row.
// Runs once on startup. One batched existence query replaces a round-trip per
// guild (the common case is "everything already provisioned"); only the
// missing guilds go through ensureBusinessForGuild, which stays idempotent.
export async function backfillBusinessesForGuilds(
  guilds: Iterable<{ id: string; name: string }>,
): Promise<void> {
  const list = [...guilds]
  if (list.length === 0) return

  let provisioned: Set<string> | null = null
  try {
    const rows = await db
      .selectDistinct({ guildId: businesses.discordGuildId })
      .from(businesses)
      .where(inArray(businesses.discordGuildId, list.map((g) => g.id)))
    provisioned = new Set(rows.map((r) => r.guildId))
  } catch (err) {
    log.error('backfill existence query failed; falling back to per-guild checks', {
      err: String(err),
    })
  }

  for (const g of list) {
    if (provisioned?.has(g.id)) continue
    await ensureBusinessForGuild(g)
  }
}
