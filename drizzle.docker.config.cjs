const { defineConfig } = require('drizzle-kit')

// See drizzle.config.ts: the web owns the schema. Pushing from the bot image
// is refused unless ALLOW_BOT_SCHEMA_PUSH=1, and the web-only tables are
// filtered out so a push can never drop them. Keep the list in sync.
const WEB_ONLY_TABLES = [
  'integration_audit',
  'integration_deliveries',
  'integration_ticket_state',
  'integration_webhook_allowlist',
]

// Refuse if `push` or `migrate` appears ANYWHERE in argv, not just as the
// first non-flag argument (`drizzle-kit --config x push`, wrappers, etc.).
const command = process.argv.find((a) => a === 'push' || a === 'migrate')
if (command && process.env.ALLOW_BOT_SCHEMA_PUSH !== '1') {
  throw new Error(
    `Refusing "drizzle-kit ${command}" from the bot image: euphoric-tickets-web owns the schema. ` +
      'Set ALLOW_BOT_SCHEMA_PUSH=1 only for a throwaway database.',
  )
}

module.exports = defineConfig({
  schema: './dist/db/schema/index.js',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: WEB_ONLY_TABLES.map((t) => `!${t}`),
})
