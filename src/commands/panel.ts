import {
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js'
import { isSudoUser } from '../services/sudoService'
import { getPanelCategories } from '../services/settingsService'
import { buildPanelMessage } from '../services/ticketRenderer'
import { db } from '../db/client'
import { ticketPanels } from '../db/schema/ticketPanels'
import { eq } from 'drizzle-orm'

export const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Manage the ticket panel')
  .addSubcommand((sc) => sc.setName('post').setDescription('Post the ticket panel in this channel'))
  .addSubcommand((sc) =>
    sc
      .setName('refresh')
      .setDescription('Re-render an existing ticket panel after settings change')
      .addStringOption((opt) =>
        opt
          .setName('message_id')
          .setDescription('Optional: panel message ID to refresh (defaults to latest in this channel)')
          .setRequired(false),
      ),
  )
  .setDMPermission(false)
  .setDefaultMemberPermissions(0)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Server-only command.', ephemeral: true })
    return
  }
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'You need sudo to manage panels.', ephemeral: true })
    return
  }

  const sub = interaction.options.getSubcommand(true)
  if (sub === 'post') return await postPanel(interaction)
  if (sub === 'refresh') return await refreshPanel(interaction)
}

async function postPanel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: 'Run this in a regular text channel.', ephemeral: true })
    return
  }
  const channel = interaction.channel as TextChannel

  const botMember = await interaction.guild!.members.fetchMe()
  if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.reply({ content: "I can't send messages here.", ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const categories = await getPanelCategories()
  const payload = buildPanelMessage(categories)

  const sent = await channel.send(payload as any)

  await db.insert(ticketPanels).values({
    guildId: interaction.guildId!,
    channelId: channel.id,
    messageId: sent.id,
    postedByDiscordId: interaction.user.id,
  })

  await interaction.editReply(`✓ Posted panel in <#${channel.id}> (message \`${sent.id}\`).`)
}

async function refreshPanel(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const specificId = interaction.options.getString('message_id')
  const channelId = interaction.channelId

  let panelRow
  if (specificId) {
    const rows = await db.select().from(ticketPanels).where(eq(ticketPanels.messageId, specificId)).limit(1)
    panelRow = rows[0]
  } else {
    const rows = await db.select().from(ticketPanels).where(eq(ticketPanels.channelId, channelId))
    panelRow = rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0]
  }

  if (!panelRow) {
    await interaction.editReply('No panel found to refresh. Use `/panel post` first.')
    return
  }

  const channel = await interaction.guild!.channels.fetch(panelRow.channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply(`Panel channel <#${panelRow.channelId}> not found or not text.`)
    return
  }

  const message = await (channel as TextChannel).messages.fetch(panelRow.messageId).catch(() => null)
  if (!message) {
    await interaction.editReply(`Panel message \`${panelRow.messageId}\` is gone — post a new one with \`/panel post\`.`)
    return
  }

  const categories = await getPanelCategories()
  const payload = buildPanelMessage(categories)
  await message.edit(payload as any)
  await interaction.editReply(`✓ Refreshed panel \`${panelRow.messageId}\` in <#${panelRow.channelId}>.`)
}
