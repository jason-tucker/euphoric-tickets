import { REST, Routes } from 'discord.js'
import { env } from '../config/env'
import { data as panelData } from '../commands/panel'
import { data as ticketsData } from '../commands/tickets'

const commands = [panelData.toJSON(), ticketsData.toJSON()]

const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)

async function deploy(): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID), { body: commands })
  console.log(`✓ Deployed ${commands.length} command(s) to guild ${env.GUILD_ID}.`)
}

deploy().catch((err) => {
  console.error('Failed to deploy commands:', err)
  process.exit(1)
})
