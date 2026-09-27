import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

// The web owns the schema: both drizzle configs must refuse push/migrate when
// either word appears ANYWHERE in argv, unless ALLOW_BOT_SCHEMA_PUSH=1. Each
// case loads the config in a fresh process with a synthetic argv.
const CONFIGS = [
  { name: 'drizzle.config.ts', loader: "await import('./drizzle.config.ts')" },
  { name: 'drizzle.docker.config.cjs', loader: "(await import('node:module')).createRequire(process.cwd() + '/')('./drizzle.docker.config.cjs')" },
]

function load(loader: string, argv: string[], allow?: string) {
  const script = `process.argv = ${JSON.stringify(['node', 'drizzle-kit', ...argv])};
(async () => { ${loader} })().then(() => console.log('LOADED'), (e) => { console.log('REFUSED ' + e.message); process.exit(3) })`
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' }
  delete env.ALLOW_BOT_SCHEMA_PUSH
  if (allow !== undefined) env.ALLOW_BOT_SCHEMA_PUSH = allow
  const r = spawnSync('node_modules/.bin/tsx', ['-e', script], { env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('drizzle push guard', () => {
  for (const c of CONFIGS) {
    it(`${c.name}: refuses push/migrate anywhere in argv`, () => {
      for (const argv of [
        ['push'],
        ['migrate'],
        ['--config', c.name, 'push'],
        ['--config', c.name, 'push', '--force'],
        ['--verbose', 'x', 'migrate'],
      ]) {
        const r = load(c.loader, argv)
        expect(r.status, `${argv.join(' ')}: ${r.out}`).toBe(3)
        expect(r.out).toContain('REFUSED')
      }
    })

    it(`${c.name}: allows other commands, and push only with ALLOW_BOT_SCHEMA_PUSH=1`, () => {
      for (const argv of [['generate'], ['studio'], ['--config', c.name, 'check']]) {
        const r = load(c.loader, argv)
        expect(r.status, `${argv.join(' ')}: ${r.out}`).toBe(0)
        expect(r.out).toContain('LOADED')
      }
      expect(load(c.loader, ['--config', c.name, 'push'], '1').status).toBe(0)
      expect(load(c.loader, ['--config', c.name, 'push'], 'true').status).toBe(3)
    })
  }
})
