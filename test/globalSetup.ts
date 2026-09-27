import { execFileSync } from 'node:child_process'

// Pushes this repo's schema mirror into the throwaway test database.
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
}
