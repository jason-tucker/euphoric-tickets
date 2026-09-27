import { execFileSync } from 'node:child_process'
import postgres from 'postgres'

// Pushes this repo's schema mirror into the throwaway test database, plus a
// minimal stand-in for the web-owned `integrations` table (the bot reads only
// its slug, via raw SQL, for close-audit attribution).
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set — run the suite via scripts/test-docker.sh')
  if (!/@(localhost|127\.0\.0\.1|et-test-pg[\w-]*)[:/]/.test(url)) {
    throw new Error(`Refusing to run tests against a non-throwaway database host: ${url.replace(/:[^:@/]*@/, ':***@')}`)
  }
  execFileSync('node_modules/.bin/drizzle-kit', ['push', '--force', '--config', 'drizzle.config.ts'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  await sql`create table if not exists integrations (id uuid primary key, slug text not null, name text not null)`
  await sql.end()
}
