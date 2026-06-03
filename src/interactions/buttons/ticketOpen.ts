import type { ButtonInteraction } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { businesses } from '../../db/schema/businesses'
import { ticketPanels } from '../../db/schema/ticketPanels'
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

  // A guild can host multiple teams — open under the team that owns THIS panel,
  // resolved from the panel message. Falls back to the guild default when the
  // panel isn't on record (older panels).
  const [panel] = await db
    .select({ biz: businesses })
    .from(ticketPanels)
    .innerJoin(businesses, eq(businesses.id, ticketPanels.businessId))
    .where(eq(ticketPanels.messageId, interaction.message.id))
    .limit(1)

  try {
    const result = await openTicket({
      guild: interaction.guild,
      opener: member,
      categoryKey,
      business: panel?.biz,
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
