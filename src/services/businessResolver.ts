import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses, type Business } from '../db/schema/businesses'

// Per-process cache, 60-second TTL. We hit this on every interaction in
// guild — admins editing settings via the web shouldn't have to wait
// long, but the lookup is too hot to do uncached on each click.
const TTL_MS = 60_000

type Entry = { value: Business | null; expiresAt: number }
const cache = new Map<string, Entry>()

export async function getBusinessByGuildId(guildId: string): Promise<Business | null> {
  const now = Date.now()
  const hit = cache.get(guildId)
  if (hit && hit.expiresAt > now) return hit.value

  const rows = await db
    .select()
    .from(businesses)
    .where(eq(businesses.discordGuildId, guildId))
    .limit(1)
  const value = rows[0] ?? null
  cache.set(guildId, { value, expiresAt: now + TTL_MS })
  return value
}

export function invalidateBusinessCache(guildId?: string): void {
  if (guildId) cache.delete(guildId)
  else cache.clear()
}

// All teams (businesses) in a guild — a guild may host more than one. Uncached
// (used only by the panel/settings commands + their autocomplete). Oldest first
// so the default team (what getBusinessByGuildId tends to pick) leads.
export async function getBusinessesByGuildId(guildId: string): Promise<Business[]> {
  return db
    .select()
    .from(businesses)
    .where(eq(businesses.discordGuildId, guildId))
    .orderBy(asc(businesses.createdAt))
}

export async function getBusinessBySlugInGuild(guildId: string, slug: string): Promise<Business | null> {
  const rows = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.discordGuildId, guildId), eq(businesses.slug, slug)))
    .limit(1)
  return rows[0] ?? null
}
