import { type Client, type DMChannel, type NonThreadGuildBasedChannel } from 'discord.js'
import { closeShadowTicket } from '../../services/ticketToolIngest'
import { log } from '../../services/logger'

// TicketTool coexistence — when a TicketTool channel is deleted (TicketTool
// closed/deleted the ticket), mark our shadow ticket closed. DB-only; the
// transcript we ingested stays in the archive. No-op for euphoric-owned tickets
// and for any channel without a tickettool shadow row.
export function registerChannelDelete(client: Client): void {
  client.on('channelDelete', (channel: DMChannel | NonThreadGuildBasedChannel) => {
    void closeShadowTicket(channel.id).catch((err) => {
      log.warn('channelDelete close failed', { channelId: channel.id, err: String(err) })
    })
  })
}
