import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Mirrored from euphoric-tickets-web (web is the source of truth).
// Keep columns and types in lockstep; web pushes the schema via
// drizzle-kit push, the bot just reads/writes against the same DB.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  discordId: text('discord_id').notNull().unique(),
  name: text('name'),
  email: text('email'),
  image: text('image'),
  // Global sudo — read as `owner` on every business. Toggled manually via
  // SQL for now; a /admin UI to manage this is future work.
  isSudo: boolean('is_sudo').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
