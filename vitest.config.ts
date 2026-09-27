import { defineConfig } from 'vitest/config'

// Integration-style unit tests: real Postgres (schema pushed from this repo's
// mirror by test/globalSetup.ts), mocked discord.js objects (test/fakes.ts).
// TEST_DATABASE_URL must point at a THROWAWAY database — scripts/test-docker.sh
// provisions one on a private Docker network and removes it afterwards.
const dbUrl = process.env.TEST_DATABASE_URL ?? ''

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // One shared database — run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      DISCORD_BOT_TOKEN: 'test-bot-token-not-real',
      DISCORD_CLIENT_ID: '100000000000000001',
      GUILD_ID: '100000000000000002',
      INTERNAL_TOKEN: 'test-internal-token-0123456789abcdef',
      WEB_BASE_URL: 'https://tickets.example.test',
      WEB_INTERNAL_URL: 'http://tickets-web:3000',
      INTERNAL_PORT: '8787', // unused: tests bind createInternalServer() to an ephemeral port
      SUDO_ROLE_IDS: '',
      SUDO_USER_IDS: '',
    },
  },
})
