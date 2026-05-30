import { integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tickets } from './tickets'
import { users } from './users'

// P16 (lantern) — web-only access grant for Discord users who are NOT in the
// team's guild. They sign in with Discord OAuth (no guild membership needed)
// and see the ticket on the web via this join. Their replies still post into
// the Discord channel via the webhook spoof.
export const ticketExternalMembers = pgTable(
  'ticket_external_members',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedByUserId: uuid('added_by_user_id').references(() => users.id),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ticketId, t.userId] }) }),
)

export type TicketExternalMember = typeof ticketExternalMembers.$inferSelect
export type NewTicketExternalMember = typeof ticketExternalMembers.$inferInsert
