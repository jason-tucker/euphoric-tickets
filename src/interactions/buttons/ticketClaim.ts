import type { ButtonInteraction, TextChannel } from 'discord.js'
import { claimTicket } from '../../services/ticketService'
import { buildTicketWelcome, renderFirstMessage } from '../../services/ticketRenderer'
import { getDiscordIdForUserId } from '../../services/userResolver'
import { resolveTicketAccessByChannel, staffRoleIdsForCategory } from '../../services/permissions'
import { env } from '../../config/env'

export async function handleTicketClaim(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const ticketId = Number(interaction.customId.slice('tk:claim:'.length))
  if (!Number.isInteger(ticketId)) {
    await interaction.reply({ content: 'Bad claim id.', ephemeral: true })
    return
  }

  // Defer first — the access resolution below is several DB round-trips.
  await interaction.deferUpdate()

  const member = await interaction.guild.members.fetch(interaction.user.id)

  // Resolve the ticket from the CHANNEL (not the client-supplied id) and gate
  // against the ticket's OWN team + category staff roles — not the guild's
  // default team's admin roles. A category-staff member who isn't in the
  // team's admin_role_ids (e.g. an integration category's managers) can claim.
  const res = await resolveTicketAccessByChannel(member, null, interaction.channelId)
  if (!res || res.ticket.id !== ticketId) {
    await interaction.followUp({ content: 'This channel is not that ticket.', ephemeral: true })
    return
  }
  const { ticket, access, business } = res
  if (!access.canClaim) {
    await interaction.followUp({ content: 'Only staff can claim tickets.', ephemeral: true })
    return
  }

  const result = await claimTicket({ ticket, claimer: member })
  if (!result.ok) {
    await interaction.followUp({ content: result.reason, ephemeral: true })
    return
  }

  // Re-render the welcome card with the claimer, from the ticket's own team,
  // category and persisted integration card so nothing is lost on refresh.
  const category = access.category
  const categoryLabel = category?.label ?? 'Ticket'
  const openerDiscordId = (await getDiscordIdForUserId(ticket.openerUserId)) ?? '0'
  const claimerDiscordId = result.updated.assigneeUserId
    ? await getDiscordIdForUserId(result.updated.assigneeUserId)
    : null

  // Re-render the same custom first message so the body stays stable when the
  // card refreshes to show the claimer.
  const firstMessage = category?.firstMessageTemplate
    ? renderFirstMessage(category.firstMessageTemplate, {
        userId: openerDiscordId,
        ticketId: ticket.id,
        subject: ticket.subject,
        category: categoryLabel,
      })
    : null

  const welcome = buildTicketWelcome({
    ticketId: ticket.id,
    openerId: openerDiscordId,
    categoryLabel,
    categoryEmoji: category?.emoji ?? null,
    subject: ticket.subject,
    openedAt: ticket.openedAt,
    staffRoleIds: staffRoleIdsForCategory(business, category),
    claimerId: claimerDiscordId,
    firstMessage,
    webUrl: `${env.WEB_BASE_URL}/b/${business.slug}/tickets/${ticket.id}`,
    card: result.updated.integrationCard ?? ticket.integrationCard ?? null,
  })

  const msg = interaction.message
  await msg.edit({ ...(welcome as any), allowedMentions: { parse: [] } }).catch(() => {})

  const channel = interaction.channel as TextChannel | null
  if (channel) {
    await channel.send({
      content: `✋ Claimed by <@${member.id}>.`,
      allowedMentions: { parse: [] },
    })
  }
}
