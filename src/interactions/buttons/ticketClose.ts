import type { ButtonInteraction, TextChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets } from '../../db/schema/tickets'
import { closeTicket } from '../../services/ticketService'
import { buildCloseConfirm } from '../../services/ticketRenderer'
import { getStaffRoleIds } from '../../services/settingsService'
import { getDiscordIdForUserId } from '../../services/userResolver'
import { isSudoUser } from '../../services/sudoService'

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:close:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad close id.', ephemeral: true })
    return
  }

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.reply({ content: 'Ticket not found.', ephemeral: true })
    return
  }

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds(interaction.guild.id)
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)
  const isOpener = openerDiscordId === member.id
  if (!isStaff && !isOpener && !isSudoUser(member)) {
    await interaction.reply({ content: 'Only the opener or staff can close this ticket.', ephemeral: true })
    return
  }

  await interaction.reply({
    ...(buildCloseConfirm(ticket.id) as any),
    ephemeral: true,
  })
}

export async function handleTicketCloseConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:close_confirm:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad close id.', ephemeral: true })
    return
  }

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.update({ content: 'Ticket not found.', components: [] } as any).catch(() => {})
    return
  }

  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.update({ content: 'Channel context missing.', components: [] } as any).catch(() => {})
    return
  }

  await interaction.update({
    content: '🔒 Closing — saving transcript and deleting channel…',
    components: [],
  } as any).catch(() => {})

  const closer = await interaction.guild.members.fetch(interaction.user.id)
  await closeTicket({ guild: interaction.guild, channel, ticket, closer })
  // Channel is deleted by closeTicket; no further followUp needed.
}

export async function handleTicketCloseCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: 'Cancelled.', components: [] } as any).catch(() => {})
}
