import { boolean, index, integer, pgTable, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'
import { ticketCategories } from './ticketCategories'
import { users } from './users'

// Mirrored from euphoric-tickets-web. Discord IDs are stored on `users`
// (not here) — `openerUserId` / `assigneeUserId` / `closedByUserId` are
// FK uuids and need a join through `users` to recover the snowflake.
export const ticketStatuses = [
  'open',
  'claimed',
  'in_progress',
  'waiting',
  'on_hold',
  'completed',
  'closed',
] as const
export type TicketStatus = (typeof ticketStatuses)[number]

export const ticketKinds = ['normal', 'project'] as const
export type TicketKind = (typeof ticketKinds)[number]

export const tickets = pgTable(
  'tickets',
  {
    id: serial('id').primaryKey(),
    // The HOST business operating this ticket. Always set.
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    // The CLIENT business this ticket is for, when opened on behalf of one.
    // Null for tickets opened directly by host-side users.
    clientBusinessId: uuid('client_business_id').references(() => businesses.id, {
      onDelete: 'set null',
    }),
    openerUserId: uuid('opener_user_id')
      .notNull()
      .references(() => users.id),
    categoryId: uuid('category_id').references(() => ticketCategories.id),
    subject: text('subject').notNull(),
    status: text('status', { enum: ticketStatuses }).notNull().default('open'),
    kind: text('kind', { enum: ticketKinds }).notNull().default('normal'),
    parentTicketId: integer('parent_ticket_id'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id),

    // Per-ticket Discord channel — the bot creates this on open and the
    // web deep-links into it.
    discordChannelId: text('discord_channel_id'),

    discordWebhookId: text('discord_webhook_id'),
    discordWebhookUrl: text('discord_webhook_url'),
    discordInternalThreadId: text('discord_internal_thread_id'),

    priority: integer('priority').notNull().default(2), // 1=urgent .. 4=low
    // P11: set by the startup resync when a ticket's Discord channel has
    // vanished out from under us, so staff can spot orphaned tickets on the web.
    needsAttention: boolean('needs_attention').notNull().default(false),

    // Origin of the ticket. 'euphoric' = opened through this system (panel,
    // /tickets, or web). 'tickettool' = a channel the third-party TicketTool
    // bot opened that we ingest into the unified archive and control via its
    // $-prefix commands. Mirrors euphoric-tickets-web.
    externalSource: text('external_source').notNull().default('euphoric'),
    externalTranscriptUrl: text('external_transcript_url'),

    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBusinessStatus: index('tickets_business_status_idx').on(t.businessId, t.status),
    byOpener: index('tickets_opener_idx').on(t.openerUserId),
    byAssignee: index('tickets_assignee_idx').on(t.assigneeUserId),
    byExternalSource: index('tickets_external_source_idx').on(t.externalSource),
  }),
)

// Values for tickets.external_source. Plain text column (not a pg enum) to keep
// drizzle-kit push --force friction-free; this is the app-level source of truth.
export const ticketExternalSources = ['euphoric', 'tickettool'] as const
export type TicketExternalSource = (typeof ticketExternalSources)[number]

export type Ticket = typeof tickets.$inferSelect
export type NewTicket = typeof tickets.$inferInsert
