import { type Client, type TextChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets } from '../db/schema'
import { businesses } from '../db/schema/businesses'
import { log } from './logger'

// TicketTool coexistence (control side). euphoric drives a TicketTool ticket by
// posting TicketTool's $-prefix commands into the channel AS THE BOT USER —
// TicketTool whitelists the controlling bot by user id, so these must be bot
// sends (not webhook posts). The web reaches this via the internal HTTP bridge.
//
// Supported control set (the only commands we emit): closeRequest, rename, add,
// remove. We never emit $close/$delete — TicketTool stays the system of record.

export type TicketToolAction = 'closeRequest' | 'rename' | 'add' | 'remove'

export type TicketToolCommandInput = {
  ticketId: number
  action: TicketToolAction
  name?: string
  discordUserId?: string
}

function buildCommand(prefix: string, input: TicketToolCommandInput): string | { error: string } {
  switch (input.action) {
    case 'closeRequest':
      return `${prefix}closeRequest`
    case 'rename': {
      const name = (input.name ?? '').trim()
      if (!name) return { error: 'Name required' }
      return `${prefix}rename ${name}`
    }
    case 'add':
    case 'remove': {
      if (!input.discordUserId || !/^\d{17,20}$/.test(input.discordUserId)) {
        return { error: 'Valid Discord user id required' }
      }
      return `${prefix}${input.action} <@${input.discordUserId}>`
    }
    default:
      return { error: 'Unknown action' }
  }
}

export async function runTicketToolCommand(
  client: Client,
  input: TicketToolCommandInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select({
      channelId: tickets.discordChannelId,
      externalSource: tickets.externalSource,
      prefix: businesses.ticketToolPrefix,
    })
    .from(tickets)
    .innerJoin(businesses, eq(tickets.businessId, businesses.id))
    .where(eq(tickets.id, input.ticketId))
    .limit(1)
  if (!row) return { ok: false, error: 'Ticket not found' }
  if (row.externalSource !== 'tickettool') return { ok: false, error: 'Not a TicketTool ticket' }
  if (!row.channelId) return { ok: false, error: 'Ticket has no channel' }

  const built = buildCommand(row.prefix || '$', input)
  if (typeof built !== 'string') return { ok: false, error: built.error }

  const channel = await client.channels.fetch(row.channelId).catch(() => null)
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return { ok: false, error: 'Channel unavailable' }
  }

  try {
    // allowedMentions parse:[] — the <@id> in $add/$remove must NOT ping the
    // user, but TicketTool still reads the raw mention from the message content.
    await (channel as TextChannel).send({ content: built, allowedMentions: { parse: [] } })
  } catch (err) {
    log.warn('tickettool: command send failed', {
      ticketId: input.ticketId,
      action: input.action,
      err: String(err),
    })
    return { ok: false, error: String(err) }
  }
  log.info('tickettool: emitted command', { ticketId: input.ticketId, action: input.action })
  return { ok: true }
}
