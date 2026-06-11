import type { ButtonInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets } from '../../db/schema/tickets'
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

  // Defer before the lookups below — ticket row + member fetch + staff/opener
  // resolution can outlast Discord's 3s interaction window under load.
  await interaction.deferReply({ ephemeral: true })

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.editReply({ content: 'Ticket not found.' })
    return
  }

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds(interaction.guild.id)
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)
  const isOpener = openerDiscordId === member.id
  if (!isStaff && !isOpener && !isSudoUser(member)) {
    await interaction.editReply({ content: 'Only the opener or staff can close this ticket.' })
    return
  }

  await interaction.editReply(buildCloseConfirm(ticket.id) as any)
}

export async function handleTicketCloseCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: 'Cancelled.', components: [] } as any).catch(() => {})
}
