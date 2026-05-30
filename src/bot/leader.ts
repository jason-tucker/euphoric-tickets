import postgres from 'postgres'
import { env } from '../config/env'
import { log } from '../services/logger'

// P18 (lantern) — single-leader election via a Postgres session-level advisory
// lock. Discord rejects multiple gateway connections for a non-sharded bot, so
// when the same image runs on several VPS only ONE may connect. Each instance
// blocks here until it holds the lock; followers poll every 30s. When the
// leader's process (and thus its dedicated connection) dies, Postgres releases
// the lock and a follower acquires it — automatic failover within ~30s.
//
// The lock MUST be held on a dedicated, long-lived connection (a pooled
// connection could be recycled and silently drop the lock), so this opens its
// own single connection separate from the query pool.

const BOT_LEADER_LOCK_ID = 0x4575_7068 // "Euph" — arbitrary but stable

let lockConn: ReturnType<typeof postgres> | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Blocks until this instance becomes the leader. Returns once the advisory
// lock is held on a dedicated connection that stays open for the process life.
export async function ensureLeadership(): Promise<void> {
  // Allow opting out (single-VPS deploys): set LEADER_ELECTION=off.
  if (process.env.LEADER_ELECTION === 'off') {
    log.info('leader election disabled (LEADER_ELECTION=off)')
    return
  }

  lockConn = postgres(env.DATABASE_URL, { max: 1, idle_timeout: 0, connect_timeout: 10 })

  for (;;) {
    try {
      const [{ locked }] = await lockConn`SELECT pg_try_advisory_lock(${BOT_LEADER_LOCK_ID}) AS locked`
      if (locked) {
        log.info('acquired bot leadership — connecting to Discord')
        return
      }
    } catch (err) {
      log.warn('leader election query failed; retrying', { err: String(err) })
    }
    log.info('not the leader — another instance holds the gateway; retrying in 30s')
    await sleep(30_000)
  }
}

export async function releaseLeadership(): Promise<void> {
  if (lockConn) {
    try {
      await lockConn`SELECT pg_advisory_unlock(${BOT_LEADER_LOCK_ID})`
    } catch {
      /* connection may already be gone */
    }
    await lockConn.end({ timeout: 2 }).catch(() => {})
    lockConn = null
  }
}
