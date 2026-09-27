import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

// The WEB (euphoric-tickets-web) owns this database's schema and runs
// drizzle-kit push on its own deploys. This repo's src/db/schema is a SUBSET
// mirror, so a bot push would try to drop everything the bot doesn't mirror.
//
// 1. Pushing is refused unless ALLOW_BOT_SCHEMA_PUSH=1 (test/globalSetup.ts
//    sets it for the throwaway test database). Never set it against a shared DB.
// 2. tablesFilter hides the web-only tables from drizzle-kit, so even an
//    allowed push can never DROP them. Keep in sync with
//    drizzle.docker.config.cjs and with the web's table list.
const WEB_ONLY_TABLES = [
  'integration_audit',
  'integration_deliveries',
  'integration_ticket_state',
  'integration_webhook_allowlist',
]

const command = process.argv.slice(2).find((a) => !a.startsWith('-'))
if ((command === 'push' || command === 'migrate') && process.env.ALLOW_BOT_SCHEMA_PUSH !== '1') {
  throw new Error(
    `Refusing "drizzle-kit ${command}" from the bot repo: euphoric-tickets-web owns the schema. ` +
      'Push from the web repo instead (set ALLOW_BOT_SCHEMA_PUSH=1 only for a throwaway database).',
  )
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  tablesFilter: WEB_ONLY_TABLES.map((t) => `!${t}`),
})
