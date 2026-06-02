import { db } from '../db/client'
import { auditLogs, type AuditAction } from '../db/schema/auditLogs'
import { log } from './logger'

// Mirrored from euphoric-tickets-web. Best-effort audit log writer for
// bot-side lifecycle events (panel-open clicks, claim buttons, /tickets
// commands, etc.). Never throws — a missed audit must never block the
// action it was tracking.
export async function writeAudit(opts: {
  businessId: string
  ticketId: number | null
  actorUserId: string | null
  action: AuditAction
  metadata?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      businessId: opts.businessId,
      ticketId: opts.ticketId,
      actorUserId: opts.actorUserId,
      action: opts.action,
      metadata: opts.metadata ?? {},
    })
  } catch (err) {
    log.warn('audit write failed', { action: opts.action, ticketId: opts.ticketId, err: String(err) })
  }
}
