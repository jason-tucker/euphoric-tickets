import { bigserial, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// P12 (lantern) — persistent error log with 5-day retention. The bot writes
// structured rows via persistError(); a sudo-only /admin/errors page reads the
// tail; the bot's hourly cleanup sweep drops anything older than 5 days.
export const botErrors = pgTable(
  'bot_errors',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    level: text('level').notNull(), // 'error' | 'warn' | 'info'
    source: text('source'), // e.g. 'startup-resync', 'messageCreate'
    message: text('message').notNull(),
    stack: text('stack'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byCreatedAt: index('bot_errors_created_at_idx').on(t.createdAt) }),
)

export type BotError = typeof botErrors.$inferSelect
export type NewBotError = typeof botErrors.$inferInsert
