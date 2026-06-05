import type { Client } from 'discord.js'
import { ensureBusinessForGuild } from '../../services/businessProvision'
import { log } from '../../services/logger'

// The bot was just added to a guild — auto-provision a team row so panels,
// settings and the web dashboard work immediately, with zero manual setup.
export function registerGuildCreateEvent(client: Client): void {
  client.on('guildCreate', (guild) => {
    log.info('joined guild', { guildId: guild.id, name: guild.name })
    void ensureBusinessForGuild(guild)
  })
}
