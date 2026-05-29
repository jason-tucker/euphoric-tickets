import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'

// Mirrored from euphoric-tickets-web. Used by `/panel post` and
// `/panel refresh` to find a previously-posted panel message. `business_id`
// is the canonical FK; `guild_id` is denormalised so lookup paths can
// resolve panels without a join.
export const ticketPanels = pgTable('ticket_panels', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id').notNull().unique(),
  postedByDiscordId: text('posted_by_discord_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TicketPanel = typeof ticketPanels.$inferSelect
export type NewTicketPanel = typeof ticketPanels.$inferInsert
