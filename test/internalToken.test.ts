// P1c (plan §4.6 step 5): the web ↔ bot internal channel authenticates ONLY
// with a dedicated INTERNAL_TOKEN of at least 32 characters. Env validation
// rejects a missing or short token (the process exits 1 at boot), and there is
// no DISCORD_BOT_TOKEN fallback on the internal HTTP server.

import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { INTERNAL_TOKEN_MIN_LENGTH, envSchema } from '../src/config/env'
import { createInternalServer } from '../src/bot/internalHttp'
import { FakeGuild, fakeClient } from './fakes'

const BASE_ENV = {
  DISCORD_BOT_TOKEN: 'test-bot-token-not-real-but-long-enough-to-matter-000000',
  DISCORD_CLIENT_ID: '100000000000000001',
  GUILD_ID: '100000000000000002',
  DATABASE_URL: 'postgres://unused/unused',
}

describe('env validation: INTERNAL_TOKEN', () => {
  it('requires at least 32 characters', () => {
    expect(INTERNAL_TOKEN_MIN_LENGTH).toBe(32)
  })

  it('rejects a missing token, even with DISCORD_BOT_TOKEN set', () => {
    const r = envSchema.safeParse({ ...BASE_ENV })
    expect(r.success).toBe(false)
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('INTERNAL_TOKEN')
  })

  it('rejects a short token without echoing it', () => {
    const short = 'Qx7-leak-canary'.padEnd(31, 'q')
    const r = envSchema.safeParse({ ...BASE_ENV, INTERNAL_TOKEN: short })
    expect(r.success).toBe(false)
    const issue = r.error!.issues.find((i) => i.path.join('.') === 'INTERNAL_TOKEN')!
    expect(issue.message).toMatch(/at least 32/)
    expect(JSON.stringify(r.error!.issues.map((i) => i.message))).not.toContain('Qx7-leak-canary')
  })

  it('accepts a token of exactly 32 characters', () => {
    const r = envSchema.safeParse({ ...BASE_ENV, INTERNAL_TOKEN: 'a'.repeat(32) })
    expect(r.success).toBe(true)
    expect(r.data!.INTERNAL_TOKEN).toBe('a'.repeat(32))
  })

  // The real boot path: src/config/env.ts is the first import of src/index.ts
  // and exits the process on invalid env. Run it in a child process with no
  // .env file (DOTENV_CONFIG_PATH points nowhere).
  function bootEnv(internalToken: string | undefined) {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      DOTENV_CONFIG_PATH: '/nonexistent/.env',
      ...BASE_ENV,
    }
    if (internalToken !== undefined) env.INTERNAL_TOKEN = internalToken
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('./src/config/env.ts').then(() => console.log('ENV_OK'))"],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 },
    )
  }

  it('boot exits 1 when INTERNAL_TOKEN is missing, empty or short', () => {
    for (const token of [undefined, '', 'Qx7-leak-canary'.padEnd(31, 'q')]) {
      const r = bootEnv(token)
      expect(r.status, `token=${String(token?.length)}`).toBe(1)
      expect(r.stdout).not.toContain('ENV_OK')
      expect(r.stderr).toContain('INTERNAL_TOKEN')
      expect(r.stderr).not.toContain('Qx7-leak-canary')
    }
  })

  it('boot succeeds with a valid token', () => {
    const r = bootEnv('v'.repeat(64))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('ENV_OK')
  })
})

describe('internal HTTP: x-internal-token', () => {
  const ROUTES = [
    '/api/internal/dm',
    '/api/internal/tickettool/command',
    '/api/internal/tickettool/reconcile',
    '/api/internal/tickettool/reprocess-embeds',
    '/api/internal/guild/leave',
    '/api/internal/bot/username',
    '/api/internal/tickets/open',
    '/api/internal/tickets/close',
    '/api/internal/tickets/webhook/ensure',
  ]

  it('every route returns 401 for a wrong, missing, or bot token; the right token passes auth', async () => {
    const token = process.env.INTERNAL_TOKEN!
    expect(token.length).toBeGreaterThanOrEqual(32)
    const server = createInternalServer(fakeClient(new FakeGuild()))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (path: string, tok: string | null, body = '{}') =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(tok === null ? {} : { 'x-internal-token': tok }) },
        body,
      })
    try {
      for (const path of ROUTES) {
        expect((await post(path, 'w'.repeat(token.length))).status, path).toBe(401)
        expect((await post(path, token.slice(0, -1))).status, path).toBe(401)
        expect((await post(path, null)).status, path).toBe(401)
        expect((await post(path, '')).status, path).toBe(401)
        // No fallback: the Discord bot token is not an internal secret.
        expect((await post(path, process.env.DISCORD_BOT_TOKEN!)).status, path).toBe(401)
      }
      // The right token gets past auth (the invalid body is then a 400).
      expect((await post('/api/internal/dm', token)).status).toBe(400)
      expect((await post('/api/internal/tickets/open', token, 'not json')).status).toBe(400)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
