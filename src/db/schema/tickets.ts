import { pgTable, text, timestamp, serial } from 'drizzle-orm/pg-core'

export const tickets = pgTable('tickets', {
  id: serial('id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull().unique(),
  openerDiscordId: text('opener_discord_id').notNull(),
  categoryKey: text('category_key').notNull(),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  claimerDiscordId: text('claimer_discord_id'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByDiscordId: text('closed_by_discord_id'),
})

export type Ticket = typeof tickets.$inferSelect
