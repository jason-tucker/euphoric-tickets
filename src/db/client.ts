import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env'
import * as schema from './schema'

const queryClient = postgres(env.DATABASE_URL, {
  // The gateway fans out concurrent events (message relay + interactions +
  // startup resync); 10 connections starved under bursts. 20 still leaves
  // ample headroom under Postgres' default max_connections=100 alongside the
  // web app's pool of 10.
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
})
export const db = drizzle(queryClient, { schema })

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 })
}
