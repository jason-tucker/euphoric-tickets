import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
} from 'discord.js'
import { isSudoUser } from '../../services/sudoService'
import {
  getCategoryId,
  getLogChannelId,
  getPanelCategories,
  getStaffRoleIds,
  getTranscriptChannelId,
} from '../../services/settingsService'

export async function handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  const action = interaction.customId.slice('tk:settings:'.length)
  if (action !== 'edit') {
    await interaction.reply({ content: `Unknown settings action: ${action}`, ephemeral: true })
    return
  }

  const [catId, transcriptId, logId, staffIds, panelCats] = await Promise.all([
    getCategoryId(),
    getTranscriptChannelId(),
    getLogChannelId(),
    getStaffRoleIds(),
    getPanelCategories(),
  ])

  const modal = new ModalBuilder()
    .setCustomId('tk:settings_modal:all')
    .setTitle('Edit Ticket Settings')

  const categoryInput = new TextInputBuilder()
    .setCustomId('category_id')
    .setLabel('Tickets category ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('Snowflake of a Discord category')
    .setValue(catId ?? '')

  const transcriptInput = new TextInputBuilder()
    .setCustomId('transcript_channel_id')
    .setLabel('Transcript channel ID (blank to disable)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(transcriptId ?? '')

  const logInput = new TextInputBuilder()
    .setCustomId('log_channel_id')
    .setLabel('Log channel ID (blank to disable)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(logId ?? '')

  const staffInput = new TextInputBuilder()
    .setCustomId('staff_role_ids')
    .setLabel('Staff role IDs (comma-separated)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(staffIds.join(','))

  const panelInput = new TextInputBuilder()
    .setCustomId('panel_categories')
    .setLabel('Panel categories JSON')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setValue(JSON.stringify(panelCats, null, 2))

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(categoryInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(transcriptInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(logInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(staffInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(panelInput),
  )

  await interaction.showModal(modal)
}
