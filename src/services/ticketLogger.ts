import type { Guild } from 'discord.js'

// Lifecycle event logger. The web schema has no log_channel_id column,
// so for now this no-ops — callers still emit events so we can plumb
// them through to a per-business log channel later without revisiting
// every callsite. See the TODO in settingsService.ts.

type Kind = 'open' | 'claim' | 'close' | 'add' | 'remove' | 'rename'

export async function logTicketEvent(_opts: {
  guild: Guild
  kind: Kind
  ticketId: number
  fields: Record<string, string>
}): Promise<void> {
  // No-op until the web schema grows a log channel column. The function
  // intentionally still accepts the same shape so reinstating it is a
  // one-file change.
}
