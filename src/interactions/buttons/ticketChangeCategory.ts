import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tickets } from '../../db/schema/tickets'
import { ticketCategories } from '../../db/schema/ticketCategories'
import { getBusinessByGuildId } from '../../services/businessResolver'
import { isAdminForBusiness } from '../../services/permissions'
import { changeTicketCategory } from '../../services/ticketService'

// P5: the "🗂️ Category" button on the welcome card. Admin-only. Replies with
// an ephemeral select of the team's categories.
export async function handleChangeCategoryButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return
  const ticketId = Number(interaction.customId.slice('tk:changecat:'.length))
  if (!Number.isInteger(ticketId)) return

  // Defer before the member fetch + business/category lookups — they can
  // outlast Discord's 3s interaction window under load.
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const business = await getBusinessByGuildId(interaction.guild.id)
  if (!business) {
    await interaction.editReply({ content: 'This server is not configured as a team.' })
    return
  }
  if (!isAdminForBusiness(member, business)) {
    await interaction.editReply({ content: "Only admins can change a ticket's category." })
    return
  }

  const cats = await db
    .select()
    .from(ticketCategories)
    .where(eq(ticketCategories.businessId, business.id))
    .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.label))
  if (cats.length === 0) {
    await interaction.editReply({ content: 'No categories configured for this team yet.' })
    return
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tk:changecat_sel:${ticketId}`)
    .setPlaceholder('Choose a new category')
    .addOptions(
      cats.slice(0, 25).map((c) => ({
        label: c.label.slice(0, 100),
        value: c.key,
        emoji: c.emoji ?? undefined,
        description: c.description ? c.description.slice(0, 100) : undefined,
      })),
    )

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  await interaction.editReply({ content: 'Move this ticket to…', components: [row] })
}

// P5: the category select. Performs the move via the shared service.
export async function handleChangeCategorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return
  const ticketId = Number(interaction.customId.slice('tk:changecat_sel:'.length))
  if (!Number.isInteger(ticketId)) return

  await interaction.deferUpdate()

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const business = await getBusinessByGuildId(interaction.guild.id)
  if (!business || !isAdminForBusiness(member, business)) {
    await interaction.editReply({ content: "Only admins can change a ticket's category.", components: [] })
    return
  }

  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  if (!ticket) {
    await interaction.editReply({ content: 'Ticket not found.', components: [] })
    return
  }

  const key = interaction.values[0]
  const [cat] = await db
    .select()
    .from(ticketCategories)
    .where(and(eq(ticketCategories.businessId, business.id), eq(ticketCategories.key, key)))
    .limit(1)
  if (!cat) {
    await interaction.editReply({ content: `Unknown category \`${key}\`.`, components: [] })
    return
  }

  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.editReply({ content: 'Channel context missing.', components: [] })
    return
  }

  const result = await changeTicketCategory({
    guild: interaction.guild,
    channel,
    ticket,
    newCategory: cat,
    business,
    actorId: member.id,
  })
  await interaction.editReply({
    content: result.ok ? `✓ Moved to ${cat.emoji ? `${cat.emoji} ` : ''}**${cat.label}**.` : result.reason,
    components: [],
  })
}
