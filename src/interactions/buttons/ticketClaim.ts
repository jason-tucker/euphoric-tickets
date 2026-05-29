import type { ButtonInteraction, TextChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets } from '../../db/schema/tickets'
import { ticketCategories } from '../../db/schema/ticketCategories'
import { claimTicket } from '../../services/ticketService'
import { buildTicketWelcome } from '../../services/ticketRenderer'
import { getPanelCategories, getStaffRoleIds } from '../../services/settingsService'
import { getDiscordIdForUserId } from '../../services/userResolver'
import { getBusinessByGuildId } from '../../services/businessResolver'
import { isSudoUser } from '../../services/sudoService'
import { env } from '../../config/env'

export async function handleTicketClaim(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:claim:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad claim id.', ephemeral: true })
    return
  }

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds(interaction.guild.id)
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

  // Resolve category label + opener snowflake for the welcome refresh.
  const [catRow] = ticket.categoryId
    ? await db
        .select({ label: ticketCategories.label, key: ticketCategories.key })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, ticket.categoryId))
        .limit(1)
    : [undefined]

  const panelCats = await getPanelCategories(interaction.guild.id)
  const panelCat = catRow ? panelCats.find((c) => c.key === catRow.key) : undefined
  const categoryLabel = panelCat?.label ?? catRow?.label ?? 'Ticket'

  const openerDiscordId = (await getDiscordIdForUserId(ticket.openerUserId)) ?? '0'
  const claimerDiscordId = result.updated.assigneeUserId
    ? await getDiscordIdForUserId(result.updated.assigneeUserId)
    : null
  const webBusiness = await getBusinessByGuildId(interaction.guild.id)

  const welcome = buildTicketWelcome({
    ticketId: ticket.id,
    openerId: openerDiscordId,
    categoryLabel,
    staffRoleIds: staffRoles,
    claimerId: claimerDiscordId,
    webUrl: webBusiness ? `${env.WEB_BASE_URL}/b/${webBusiness.slug}/tickets/${ticket.id}` : null,
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
