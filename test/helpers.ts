import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { integrationOpenClaims, tickets } from '../src/db/schema'
import type { Business, TicketCategory } from '../src/db/schema'

// Captures notify-bridge POSTs; passes loopback requests (the internal HTTP
// server under test) through to the real fetch.
export function stubFetch() {
  const realFetch = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response('{}', { status: 200 })
  })
  return { calls, spy }
}

export async function seedIntegration(slug = `int-${randomUUID().slice(0, 6)}`) {
  const id = randomUUID()
  await db.execute(sql`insert into integrations (id, slug, name) values (${id}, ${slug}, ${'EFM Music'})`)
  return { id, slug, name: 'EFM Music' }
}

export function openBody(opts: {
  integration: { id: string; slug: string; name: string }
  business: Business
  category: TicketCategory
  openerDiscordId: string
  externalRef?: string
  subject?: string
  card?: unknown
}) {
  return {
    integrationId: opts.integration.id,
    integrationSlug: opts.integration.slug,
    integrationName: opts.integration.name,
    businessId: opts.business.id,
    categoryKey: opts.category.key,
    openerDiscordId: opts.openerDiscordId,
    subject: opts.subject ?? 'Batch #12 — 3 songs',
    externalRef: opts.externalRef ?? `batch-${randomUUID()}`,
    card:
      opts.card === undefined
        ? {
            title: 'New song batch #12',
            lines: ['Song #1 — Artist A - Track One', 'Song #2 — Artist B - Track Two'],
            link: { label: 'Open in portal', url: 'https://music.euphoric.fm/batches/12' },
          }
        : opts.card,
  }
}

export async function getClaim(integrationId: string, externalRef: string) {
  const [c] = await db
    .select()
    .from(integrationOpenClaims)
    .where(and(eq(integrationOpenClaims.integrationId, integrationId), eq(integrationOpenClaims.externalRef, externalRef)))
  return c
}

export async function ticketsForRef(integrationId: string, externalRef: string) {
  return db
    .select()
    .from(tickets)
    .where(and(eq(tickets.integrationId, integrationId), eq(tickets.externalRef, externalRef)))
}

export async function ageClaim(integrationId: string, externalRef: string, seconds: number) {
  await db.execute(
    sql`update integration_open_claims set updated_at = now() - make_interval(secs => ${seconds}::int)
        where integration_id = ${integrationId} and external_ref = ${externalRef}`,
  )
}
