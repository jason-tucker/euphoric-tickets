// Vitest setup — runs before each test file's module graph is evaluated.
//
// src/config/env.ts validates process.env at import time and process.exit(1)s
// on failure, and src/db/client.ts builds a postgres-js client from
// DATABASE_URL at import time (lazily — no connection happens until a query
// runs, and tests mock ../db/client before ever querying). Stub the required
// vars so importing any service module is safe in tests.
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.DISCORD_CLIENT_ID ??= '100000000000000000'
process.env.GUILD_ID ??= '100000000000000000'
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.NODE_ENV ??= 'test'
