import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { businesses } from './businesses'
import { ticketCategories } from './ticketCategories'

// P13 (lantern) — per-user notification preferences. A row opts a user into a
// (channel × event) notification, optionally scoped to a business and/or
// category. Null business = all the user's teams; null category = all
// categories. Most-specific matching row wins at dispatch time.
export const notifyChannels = ['ntfy', 'dm'] as const
export const notifyEvents = ['new_ticket', 'reply'] as const
export type NotifyChannel = (typeof notifyChannels)[number]
export type NotifyEvent = (typeof notifyEvents)[number]

export const userNotificationPrefs = pgTable(
  'user_notification_prefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => ticketCategories.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: notifyChannels }).notNull(),
    event: text('event', { enum: notifyEvents }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // ntfy topic to POST to (per user). Ignored for the 'dm' channel.
    ntfyTopic: text('ntfy_topic'),
    // Optional custom ntfy server. Null/empty → default (NTFY_BASE_URL/ntfy.sh).
    ntfyServer: text('ntfy_server'),
  },
  (t) => ({ byUser: index('user_notification_prefs_user_idx').on(t.userId) }),
)

export type UserNotificationPref = typeof userNotificationPrefs.$inferSelect
export type NewUserNotificationPref = typeof userNotificationPrefs.$inferInsert
