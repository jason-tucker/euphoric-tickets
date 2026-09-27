import type { ButtonInteraction } from 'discord.js'
import { buildCloseConfirm } from '../../services/ticketRenderer'
import { resolveTicketAccessByChannel } from '../../services/permissions'

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:close:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad close id.', ephemeral: true })
    return
  }

  // Defer before the lookups below — ticket row + member fetch + staff/opener
  // resolution can outlast Discord's 3s interaction window under load.
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild.members.fetch(interaction.user.id)
  // Gate against the ticket's OWN team and category (per-category staff roles,
  // opener, admins/sudo) — resolved from the channel, not the guild default.
  const res = await resolveTicketAccessByChannel(member, null, interaction.channelId)
  if (!res || res.ticket.id !== ticketId) {
    await interaction.editReply({ content: 'Ticket not found.' })
    return
  }
  if (!res.access.canClose) {
    await interaction.editReply({ content: 'Only the opener or staff can close this ticket.' })
    return
  }

  await interaction.editReply(buildCloseConfirm(res.ticket.id) as any)
}

export async function handleTicketCloseCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: 'Cancelled.', components: [] } as any).catch(() => {})
}
