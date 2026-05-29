import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type TextChannel,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets } from '../db/schema/tickets'
import { isSudoUser } from '../services/sudoService'
import {
  getCategoryId,
  getLogChannelId,
  getPanelCategories,
  getStaffRoleIds,
  getTranscriptChannelId,
} from '../services/settingsService'
import { claimTicket, closeTicket } from '../services/ticketService'
import { buildCloseConfirm } from '../services/ticketRenderer'

export const data = new SlashCommandBuilder()
  .setName('tickets')
  .setDescription('Ticket controls')
  .addSubcommand((sc) => sc.setName('settings').setDescription('View/edit ticket settings (sudo)'))
  .addSubcommand((sc) => sc.setName('claim').setDescription('Claim the current ticket'))
  .addSubcommand((sc) => sc.setName('close').setDescription('Close the current ticket'))
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Server-only command.', ephemeral: true })
    return
  }
  const sub = interaction.options.getSubcommand(true)
  if (sub === 'settings') return await openSettings(interaction)
  if (sub === 'claim') return await claimHere(interaction)
  if (sub === 'close') return await closeHere(interaction)
}

async function openSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const [catId, transcriptId, logId, staffIds, panelCats] = await Promise.all([
    getCategoryId(),
    getTranscriptChannelId(),
    getLogChannelId(),
    getStaffRoleIds(),
    getPanelCategories(),
  ])

  const lines = [
    '## ⚙️ Ticket Settings',
    `**Tickets category:** ${catId ? `<#${catId}> (\`${catId}\`)` : '_(not set)_'}`,
    `**Transcript channel:** ${transcriptId ? `<#${transcriptId}>` : '_(not set — transcripts disabled)_'}`,
    `**Log channel:** ${logId ? `<#${logId}>` : '_(not set — lifecycle events not logged)_'}`,
    `**Staff roles:** ${staffIds.length ? staffIds.map((id) => `<@&${id}>`).join(' ') : '_(none — only opener can see ticket)_'}`,
    `**Panel categories:** ${panelCats.length} configured`,
  ]
  const catJsonPreview =
    '```json\n' +
    JSON.stringify(panelCats, null, 2).slice(0, 700) +
    (JSON.stringify(panelCats).length > 700 ? '\n…' : '') +
    '\n```'

  const container = new ContainerBuilder()
    .setAccentColor(0xa855f7)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Panel categories JSON\n' + catJsonPreview))

  const editBtn = new ButtonBuilder()
    .setCustomId('tk:settings:edit')
    .setLabel('Edit settings')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('✏️')

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn)

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  } as any)
}

async function claimHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds()
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  if (!isStaff && !isSudoUser(member)) {
    await interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true })
    return
  }

  const channelId = interaction.channelId
  const rows = await db.select().from(tickets).where(eq(tickets.channelId, channelId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true })
    return
  }

  const result = await claimTicket({ ticket, claimer: member })
  if (!result.ok) {
    await interaction.reply({ content: result.reason, ephemeral: true })
    return
  }
  await interaction.reply({ content: `✋ Claimed by <@${member.id}>.`, allowedMentions: { parse: [] } })
}

async function closeHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const channelId = interaction.channelId
  const rows = await db.select().from(tickets).where(eq(tickets.channelId, channelId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true })
    return
  }

  const staffRoles = await getStaffRoleIds()
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  const isOpener = ticket.openerDiscordId === member.id
  if (!isStaff && !isOpener && !isSudoUser(member)) {
    await interaction.reply({ content: 'Only the opener or staff can close this ticket.', ephemeral: true })
    return
  }

  await interaction.reply({
    ...(buildCloseConfirm(ticket.id) as any),
  })
}

export async function executeCloseConfirm(opts: {
  interaction: import('discord.js').ButtonInteraction
  ticketId: number
}): Promise<void> {
  const { interaction, ticketId } = opts
  if (!interaction.inGuild() || !interaction.guild) return
  await interaction.deferUpdate()

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.editReply({ content: 'Ticket not found.', components: [] })
    return
  }
  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.editReply({ content: 'Channel context missing.', components: [] })
    return
  }
  const closer = await interaction.guild.members.fetch(interaction.user.id)

  const result = await closeTicket({
    guild: interaction.guild,
    channel,
    ticket,
    closer,
  })
  if (!result.ok) {
    await interaction.editReply({ content: result.reason, components: [] })
    return
  }
}
