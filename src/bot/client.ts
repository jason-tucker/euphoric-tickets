import { Client, GatewayIntentBits, Partials } from 'discord.js'

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // P14: receive DMs so the bot can guide users who message it directly.
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.GuildMember, Partials.Channel, Partials.Message],
  allowedMentions: { parse: [] },
})
