import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'
import { tickets } from './tickets'
import { users } from './users'

// Mirrored from euphoric-tickets-web. Lifecycle event log written by
// both the bot (slash commands + buttons) and the web (server actions).
// The web's ticket detail page joins this with `ticket_messages` to render
// a chronological conversation that mixes chat and "X did Y" status lines.
//
// See the web copy for the full design note; this mirror exists so the
// bot can `db.insert(auditLogs).values(...)` directly.
export const auditActions = [
  'opened',
  'claimed',
  'unclaimed',
  'status_changed',
  'assigned',
  'unassigned',
  'category_changed',
  'member_added',
  'member_removed',
  'owner_changed',
  'closed',
  'reopened',
  'channel_deleted',
  'renamed',
] as const
export type AuditAction = (typeof auditActions)[number]

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action', { enum: auditActions }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTicket: index('audit_logs_ticket_idx').on(t.ticketId, t.createdAt),
    byBusiness: index('audit_logs_business_idx').on(t.businessId, t.createdAt),
  }),
)

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
