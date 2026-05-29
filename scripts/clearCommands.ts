import { REST, Routes } from 'discord.js'
import { env } from '../src/config/env'

// Usage:
//   pnpm commands:clear           — clears guild commands only (default)
//   pnpm commands:clear --global  — clears global commands only
//   pnpm commands:clear --all     — clears both
//
// The --global / --all forms exist because this Discord app was previously
// used by another bot (Ticket Tool) that registered 28 global commands.
// Stale globals show up in Discord's autocomplete and route to our bot
// without a handler, producing "application did not respond" errors.

async function clear(): Promise<void> {
  const args = process.argv.slice(2)
  const wantGlobal = args.includes('--global') || args.includes('--all')
  const wantGuild = args.includes('--all') || (!wantGlobal)

  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)

  if (wantGuild) {
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID), { body: [] })
    console.log(`✓ Cleared guild commands in ${env.GUILD_ID}`)
  }
  if (wantGlobal) {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] })
    console.log('✓ Cleared global commands')
  }
}

clear().catch((err) => {
  console.error('Failed to clear commands:', err)
  process.exit(1)
})
