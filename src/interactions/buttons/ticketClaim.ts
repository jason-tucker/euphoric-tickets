import type { ButtonInteraction, TextChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets } from '../../db/schema/tickets'
import { claimTicket } from '../../services/ticketService'
import { buildTicketWelcome } from '../../services/ticketRenderer'
import { getPanelCategories, getStaffRoleIds } from '../../services/settingsService'
import { isSudoUser } from '../../services/sudoService'

export async function handleTicketClaim(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:claim:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad claim id.', ephemeral: true })
    return
  }

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds()
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  if (!isStaff && !isSudoUser(member)) {
    await interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) return

  const result = await claimTicket({ ticket, claimer: member })
  if (!result.ok) {
    await interaction.followUp({ content: result.reason, ephemeral: true })
    return
  }

  const panelCats = await getPanelCategories()
  const cat = panelCats.find((c) => c.key === ticket.categoryKey)
  const welcome = buildTicketWelcome({
    ticketId: ticket.id,
    openerId: ticket.openerDiscordId,
    categoryLabel: cat?.label ?? ticket.categoryKey,
    staffRoleIds: staffRoles,
    claimerId: result.updated.claimerDiscordId,
  })

  const msg = interaction.message
  await msg.edit(welcome as any).catch(() => {})

  const channel = interaction.channel as TextChannel | null
  if (channel) {
    await channel.send({
      content: `✋ Claimed by <@${member.id}>.`,
      allowedMentions: { parse: [] },
    })
  }
}
