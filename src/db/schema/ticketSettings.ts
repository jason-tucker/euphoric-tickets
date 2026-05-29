import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const ticketSettings = pgTable('ticket_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TicketSetting = typeof ticketSettings.$inferSelect
