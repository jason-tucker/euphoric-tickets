import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { businesses } from './businesses'
import { users } from './users'

// Mirrored from euphoric-tickets-web (Integration API, v0.8.0). One row per
// external integration (e.g. the EFM Music Portal). The web creates and
// manages these (sudo) and authenticates their API keys; the bot only READS
// `slug` for audit attribution (`via='integration:<slug>'`). The bot never
// touches key material. The web also owns integration_webhook_allowlist,
// integration_deliveries, integration_ticket_state and integration_audit —
// the bot neither reads nor writes those, so they are not mirrored here.
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    // No column defaults on the arrays (drizzle-kit re-diffs array defaults).
    scopes: text('scopes').array().notNull(),
    allowedCategoryKeys: text('allowed_category_keys').array().notNull(),
    linkOrigin: text('link_origin'),
    actorImpersonation: boolean('actor_impersonation').notNull().default(false),
    webhookUrl: text('webhook_url'),
    webhookSecretEnc: text('webhook_secret_enc'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    keyPrefixUq: uniqueIndex('integrations_key_prefix_uq').on(t.keyPrefix),
    slugUq: uniqueIndex('integrations_slug_uq').on(t.slug),
    byBusiness: index('integrations_business_idx').on(t.businessId),
  }),
)

export type Integration = typeof integrations.$inferSelect
