import { defineConfig } from 'vitest/config'

// Unit tests run in a plain Node environment and live next to the code they
// cover as *.test.ts. src/test/setup.ts stubs the required env vars before any
// module under test imports src/config/env.ts (which process.exit(1)s on a
// missing var). Nothing here ever connects to Postgres or Discord — DB access
// is mocked per test file via src/test/dbMock.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
})
