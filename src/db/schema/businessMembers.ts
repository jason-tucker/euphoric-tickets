import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'
import { users } from './users'

// Mirrored from euphoric-tickets-web. Snapshot of "this Discord user is in
// this business's guild, at this role level" — refreshed by the web on each
// login. The bot mostly reads this; it doesn't currently write here.
export const businessMembers = pgTable(
  'business_members',
  {
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['member', 'admin', 'owner'] }).notNull().default('member'),
    discordRolesSnapshot: text('discord_roles_snapshot').notNull().default('[]'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.businessId, t.userId] }) }),
)

export type BusinessMember = typeof businessMembers.$inferSelect
export type NewBusinessMember = typeof businessMembers.$inferInsert
