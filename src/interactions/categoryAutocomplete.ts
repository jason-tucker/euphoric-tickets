import type { AutocompleteInteraction } from 'discord.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses } from '../db/schema/businesses'
import { ticketCategories } from '../db/schema/ticketCategories'

// Autocomplete for the `category` option on /tickets open. Lists every
// openable (non-staff-only) category across the guild's teams; value is the
// key. The team name is appended only on multi-team servers so same-key
// categories can be told apart.
export async function handleCategoryAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([])
    return
  }
  const focused = interaction.options.getFocused().toLowerCase()
  const rows = await db
    .select({
      key: ticketCategories.key,
      label: ticketCategories.label,
      emoji: ticketCategories.emoji,
      teamId: businesses.id,
      teamName: businesses.name,
    })
    .from(ticketCategories)
    .innerJoin(businesses, eq(businesses.id, ticketCategories.businessId))
    .where(and(eq(businesses.discordGuildId, interaction.guildId), eq(ticketCategories.staffOnly, false)))
    .catch(() => [])
  const multiTeam = new Set(rows.map((r) => r.teamId)).size > 1
  const choices = rows
    .filter((r) => r.key.toLowerCase().includes(focused) || r.label.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((r) => ({
      name: `${r.emoji ? `${r.emoji} ` : ''}${r.label}${multiTeam ? ` — ${r.teamName}` : ''}`.slice(0, 100),
      value: r.key,
    }))
  await interaction.respond(choices).catch(() => {})
}
