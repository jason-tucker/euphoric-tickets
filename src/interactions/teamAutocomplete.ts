import type { AutocompleteInteraction } from 'discord.js'
import { getBusinessesByGuildId } from '../services/businessResolver'

// Autocomplete for the `team` option shared by /panel and /tickets settings.
// Lists the teams (businesses) in this guild; value is the slug.
export async function handleTeamAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([])
    return
  }
  const focused = interaction.options.getFocused().toLowerCase()
  const teams = await getBusinessesByGuildId(interaction.guildId).catch(() => [])
  const choices = teams
    .filter((b) => b.slug.toLowerCase().includes(focused) || b.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((b) => ({ name: `${b.name} (${b.slug})`.slice(0, 100), value: b.slug }))
  await interaction.respond(choices).catch(() => {})
}
