import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'

// Mirrored from euphoric-tickets-web. Open-ticket form options — each row
// is one button/dropdown item.
export const ticketCategories = pgTable(
  'ticket_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    emoji: text('emoji'),
    description: text('description'),
    sortOrder: text('sort_order').notNull().default('0'),

    // Discord channel category (GUILD_CATEGORY) under which per-ticket
    // channels for this category land. Falls through to
    // businesses.discord_fallback_category_id when null.
    discordParentCategoryId: text('discord_parent_category_id'),

    // Per-category override for "where closed tickets go". Falls through
    // to businesses.discord_closed_category_id when null.
    discordClosedCategoryId: text('discord_closed_category_id'),

    // P1 (lantern): per-category permission tiers — bot + web enforce these
    // in P2. Empty string = inherit (anyone-can-open for allow_role_ids,
    // businesses.admin_role_ids for staff_role_ids). CSV of role snowflakes.
    allowRoleIds: text('allow_role_ids').notNull().default(''),
    staffRoleIds: text('staff_role_ids').notNull().default(''),

    // P1 (lantern, used by P4): optional custom template the bot renders as
    // the ticket's first message instead of the default welcome card.
    // Supports {{user}}, {{ticketId}}, {{subject}}, {{category}} placeholders.
    firstMessageTemplate: text('first_message_template'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ businessKey: uniqueIndex('ticket_categories_business_key_uq').on(t.businessId, t.key) }),
)

export type TicketCategory = typeof ticketCategories.$inferSelect
export type NewTicketCategory = typeof ticketCategories.$inferInsert
