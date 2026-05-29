import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { users } from '../db/schema/users'

// Resolves a Discord snowflake → users.id (uuid), inserting a row on miss.
// The web is the canonical writer for `name` / `image` / `email` (it gets
// the full OAuth profile); the bot only touches them when creating a row
// from scratch and otherwise leaves them alone — so a Discord-side display
// name change here doesn't clobber what the user chose to put on their
// web profile.

const cache = new Map<string, string>()

export async function getOrCreateUserByDiscordId(
  discordId: string,
  profile: { name?: string | null; image?: string | null } = {},
): Promise<string> {
  const cached = cache.get(discordId)
  if (cached) return cached

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, discordId))
    .limit(1)
  if (existing[0]) {
    cache.set(discordId, existing[0].id)
    return existing[0].id
  }

  // Race-safe: another process may have just inserted the row. Fall back
  // to a re-select on conflict.
  const inserted = await db
    .insert(users)
    .values({
      discordId,
      name: profile.name ?? null,
      image: profile.image ?? null,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: { updatedAt: sql`now()` },
    })
    .returning({ id: users.id })

  const id = inserted[0]!.id
  cache.set(discordId, id)
  return id
}

// Reverse lookup: given a users.id, return the Discord snowflake. Used to
// render `<@…>` mentions for tickets where we only stored the user uuid.
const discordIdCache = new Map<string, string>()

export async function getDiscordIdForUserId(userId: string): Promise<string | null> {
  const cached = discordIdCache.get(userId)
  if (cached) return cached
  const rows = await db
    .select({ discordId: users.discordId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const did = rows[0]?.discordId ?? null
  if (did) discordIdCache.set(userId, did)
  return did
}
