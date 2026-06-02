import { ChannelType, type Client, type NonThreadGuildBasedChannel } from 'discord.js'
import { ensureShadowTicket, isWatchedTicketToolChannel } from '../../services/ticketToolIngest'
import { getBusinessByGuildId } from '../../services/businessResolver'
import { log } from '../../services/logger'

// TicketTool coexistence — when TicketTool opens a ticket channel under one of a
// business's watched categories, ingest it as a shadow ticket. Best-effort: if
// the opener isn't resolvable yet (overwrites/welcome not posted), we defer and
// the messageCreate lazy hook picks it up on the first message.
export function registerChannelCreate(client: Client): void {
  client.on('channelCreate', (channel: NonThreadGuildBasedChannel) => {
    void handle(channel).catch((err) => {
      log.warn('channelCreate ingest failed', { channelId: channel.id, err: String(err) })
    })
  })
}

async function handle(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return
  const business = await getBusinessByGuildId(channel.guildId)
  if (!business) return
  if (!isWatchedTicketToolChannel(business, channel)) return
  await ensureShadowTicket(channel, business)
}
