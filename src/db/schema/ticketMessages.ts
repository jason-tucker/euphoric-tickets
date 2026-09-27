import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tickets } from './tickets'
import { users } from './users'

// Mirrored from euphoric-tickets-web. 'internal' = staff-only note posted
// in a Discord thread off the main ticket channel.
export const messageSources = ['web', 'discord', 'system', 'internal'] as const
export type MessageSource = (typeof messageSources)[number]

// Who authored a row. 'integration' = posted through the Integration API
// (/api/v1/tickets/:id/messages on the web); every other insert path —
// including this bot's Discord relay — takes the DB default 'human'. The web's
// outbound webhook dispatcher skips 'integration' rows so an integration never
// hears its own messages echoed back.
export const messageAuthorKinds = ['human', 'integration'] as const
export type MessageAuthorKind = (typeof messageAuthorKinds)[number]

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

    // Captured Discord attachments (audio/files). Empty array when none.
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),

    // Integration API (v0.8.0). Mirrors euphoric-tickets-web.
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    authorKind: text('author_kind', { enum: messageAuthorKinds }).notNull().default('human'),
    idempotencyKey: text('idempotency_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTicket: index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
    // Relay/backfill dedupe by discord_message_id. Plain index, NOT unique —
    // uniqueness would make the web's drizzle-kit push fail on duplicate rows.
    byDiscordMessage: index('ticket_messages_discord_message_idx').on(t.discordMessageId),
    // Integration message idempotency (NULL keys are distinct, so relay rows
    // without a key never collide).
    byIdempotencyKey: uniqueIndex('ticket_messages_ticket_idempotency_uq').on(t.ticketId, t.idempotencyKey),
  }),
)

export type TicketMessage = typeof ticketMessages.$inferSelect
export type NewTicketMessage = typeof ticketMessages.$inferInsert
