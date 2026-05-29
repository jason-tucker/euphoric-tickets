import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const ticketPanels = pgTable('ticket_panels', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id').notNull().unique(),
  postedByDiscordId: text('posted_by_discord_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TicketPanel = typeof ticketPanels.$inferSelect
