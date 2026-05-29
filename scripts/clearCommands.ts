import { REST, Routes } from 'discord.js'
import { env } from '../src/config/env'

async function clear(): Promise<void> {
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID), { body: [] })
  console.log(`✓ Cleared guild commands in ${env.GUILD_ID}`)
}

clear().catch((err) => {
  console.error('Failed to clear commands:', err)
  process.exit(1)
})
