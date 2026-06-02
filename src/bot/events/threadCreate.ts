import { type Client, type ThreadChannel } from 'discord.js'
import { linkInternalThread } from '../../services/ticketToolIngest'
import { log } from '../../services/logger'

// TicketTool coexistence — when TicketTool creates its private "notes" thread on
// one of its ticket channels, adopt it as euphoric's internal-notes thread so
// its messages ingest as internal notes (and the web doesn't make a second
// thread). No-op for non-TicketTool threads / channels.
export function registerThreadCreate(client: Client): void {
  client.on('threadCreate', (thread: ThreadChannel) => {
    void linkInternalThread(thread).catch((err) => {
      log.warn('threadCreate link failed', { threadId: thread.id, err: String(err) })
    })
  })
}
