import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tickets } from './tickets'
import { users } from './users'

// Mirrored from euphoric-tickets-web. 'internal' = staff-only note posted
// in a Discord thread off the main ticket channel.
export const messageSources = ['web', 'discord', 'system', 'internal'] as const
export type MessageSource = (typeof messageSources)[number]

// Captured Discord attachment. Mirror of the web's MessageAttachment.
export type MessageAttachment = {
  id: string
  name: string
  url: string
  contentType: string | null
  size: number
}

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => users.id),
    body: text('body').notNull(),
    source: text('source', { enum: messageSources }).notNull(),

    discordMessageId: text('discord_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTicket: index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
  }),
)

export type TicketMessage = typeof ticketMessages.$inferSelect
export type NewTicketMessage = typeof ticketMessages.$inferInsert
