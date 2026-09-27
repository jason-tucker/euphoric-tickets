import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Mirrored from euphoric-tickets-web (Integration API, v0.8.0). One row per
// (integration, external_ref) — the idempotency claim the bot's
// /api/internal/tickets/open route takes before it creates a Discord channel,
// so retries and concurrent opens of the same ref converge on ONE channel.
//   opening — a request owns the ref and is creating the channel/ticket.
//             channel_id is written the moment the channel exists, so a
//             crash between channel create and ticket insert leaves a
//             findable orphan that the next takeover deletes.
//   open    — the ticket exists (ticket_id set).
//   failed  — the open failed; the next request takes the claim over.
export const integrationOpenClaimStates = ['opening', 'open', 'failed'] as const
export type IntegrationOpenClaimState = (typeof integrationOpenClaimStates)[number]

export const integrationOpenClaims = pgTable(
  'integration_open_claims',
  {
    integrationId: uuid('integration_id').notNull(),
    externalRef: text('external_ref').notNull(),
    state: text('state', { enum: integrationOpenClaimStates }).notNull().default('opening'),
    channelId: text('channel_id'),
    ticketId: integer('ticket_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.integrationId, t.externalRef] }) }),
)

export type IntegrationOpenClaim = typeof integrationOpenClaims.$inferSelect
