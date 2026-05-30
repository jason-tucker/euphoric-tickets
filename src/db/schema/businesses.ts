import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Mirrored from euphoric-tickets-web. One row per tenant. Multiple
// businesses MAY share a Discord guild (slug stays unique; guild id does
// not). The bot still resolves one business per guild for ticket-opening.
export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),

  // The Discord guild this business lives in. NOT unique — see web mirror.
  discordGuildId: text('discord_guild_id').notNull(),

  // Comma-separated snowflakes (we keep it as text + parse on read so the
  // settings UI can post a single CSV form value).
  adminRoleIds: text('admin_role_ids').notNull().default(''),

  // Legacy single-channel webhook — used as a fallback when per-ticket
  // channels can't be created (bot token missing or guild misconfigured).
  // Format: full https://discord.com/api/webhooks/<id>/<token>
  webhookUrl: text('webhook_url'),

  // Discord channel category (type GUILD_CATEGORY) under which to create
  // per-ticket channels when the ticket's own category doesn't define one.
  // If both this and the per-category mapping are null, we fall back to
  // posting to webhookUrl in a single shared channel.
  discordFallbackCategoryId: text('discord_fallback_category_id'),

  // Per-business "Closed tickets" Discord category. On ticket close the
  // per-ticket channel is moved here (instead of just renamed). Per-category
  // override lives on ticket_categories.discord_closed_category_id.
  discordClosedCategoryId: text('discord_closed_category_id'),

  // Auto-delete closed tickets older than this many days. Null = keep forever.
  deleteClosedAfterDays: integer('delete_closed_after_days'),

  // 'business' or 'client' — affects UI nouns.
  terminology: text('terminology', { enum: ['business', 'client'] }).notNull().default('business'),

  // Structural distinction (web#12).
  //   host   = vendor that operates the ticket system (e.g. EuphoricFM).
  //   client = visitor org whose members come in and open tickets at a host.
  // Client businesses must have parent_business_id pointing at a host.
  kind: text('kind', { enum: ['host', 'client'] }).notNull().default('host'),
  parentBusinessId: uuid('parent_business_id'),

  // Free-form JSON for forward-compat (color, custom labels, etc.).
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Business = typeof businesses.$inferSelect
export type NewBusiness = typeof businesses.$inferInsert
