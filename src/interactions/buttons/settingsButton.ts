import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
} from 'discord.js'
import { isSudoUser } from '../../services/sudoService'
import { getCategoryId, getPanelCategories, getStaffRoleIds } from '../../services/settingsService'

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

  // Source of truth now lives on `businesses` / `ticket_categories`.
  // Transcript + log channel rows were dropped — see settingsService TODO.
  const [catId, staffIds, panelCats] = await Promise.all([
    getCategoryId(interaction.guild.id),
    getStaffRoleIds(interaction.guild.id),
    getPanelCategories(interaction.guild.id),
  ])

  const modal = new ModalBuilder()
    .setCustomId('tk:settings_modal:all')
    .setTitle('Edit Ticket Settings')

  const categoryInput = new TextInputBuilder()
    .setCustomId('category_id')
    .setLabel('Fallback tickets category ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('Snowflake of a Discord category')
    .setValue(catId ?? '')

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
    new ActionRowBuilder<TextInputBuilder>().addComponents(staffInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(panelInput),
  )

  await interaction.showModal(modal)
}
