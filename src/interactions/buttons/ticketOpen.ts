import type { ButtonInteraction } from 'discord.js'
import { openTicket } from '../../services/ticketService'
import { log } from '../../services/logger'

export async function handleTicketOpen(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Server-only.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const categoryKey = interaction.customId.slice('tk:open:'.length)
  const member = await interaction.guild.members.fetch(interaction.user.id)

  try {
    const result = await openTicket({
      guild: interaction.guild,
      opener: member,
      categoryKey,
    })
    if (!result.ok) {
      await interaction.editReply(result.reason)
      return
    }
    await interaction.editReply(`✓ Ticket opened: <#${result.channel.id}>`)
  } catch (err) {
    log.error('openTicket failed', { err: String(err), userId: member.id, categoryKey })
    await interaction.editReply('Something went wrong opening your ticket. Please ping a staff member.')
  }
}
