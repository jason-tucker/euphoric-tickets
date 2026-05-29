import type { ModalSubmitInteraction } from 'discord.js'
import { isSudoUser } from '../../services/sudoService'
import {
  SETTING_KEYS,
  isSnowflake,
  parseSnowflakeCsv,
  setSetting,
  validatePanelCategoriesJson,
} from '../../services/settingsService'

export async function handleSettingsModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const categoryId = interaction.fields.getTextInputValue('category_id').trim()
  const transcriptChannelId = interaction.fields.getTextInputValue('transcript_channel_id').trim()
  const logChannelId = interaction.fields.getTextInputValue('log_channel_id').trim()
  const staffRoleIdsRaw = interaction.fields.getTextInputValue('staff_role_ids').trim()
  const panelCategoriesRaw = interaction.fields.getTextInputValue('panel_categories')

  const errors: string[] = []

  if (!isSnowflake(categoryId)) errors.push('• Tickets category ID is not a valid Discord snowflake.')

  if (transcriptChannelId && !isSnowflake(transcriptChannelId)) {
    errors.push('• Transcript channel ID is not a valid Discord snowflake.')
  }

  if (logChannelId && !isSnowflake(logChannelId)) {
    errors.push('• Log channel ID is not a valid Discord snowflake.')
  }

  const { ok: validStaff, bad: badStaff } = parseSnowflakeCsv(staffRoleIdsRaw)
  if (badStaff.length) errors.push(`• Invalid staff role IDs: \`${badStaff.join('`, `')}\``)

  const panelResult = validatePanelCategoriesJson(panelCategoriesRaw)
  if (!panelResult.ok) errors.push(`• Panel categories: ${panelResult.error}`)

  if (errors.length) {
    await interaction.editReply('Could not save:\n' + errors.join('\n'))
    return
  }

  await Promise.all([
    setSetting(SETTING_KEYS.categoryId, categoryId),
    setSetting(SETTING_KEYS.transcriptChannelId, transcriptChannelId),
    setSetting(SETTING_KEYS.logChannelId, logChannelId),
    setSetting(SETTING_KEYS.staffRoleIds, JSON.stringify(validStaff)),
    panelResult.ok ? setSetting(SETTING_KEYS.panelCategories, JSON.stringify(panelResult.value)) : Promise.resolve(),
  ])

  const summary = [
    '✓ Settings saved.',
    `**Tickets category:** <#${categoryId}>`,
    transcriptChannelId ? `**Transcript channel:** <#${transcriptChannelId}>` : '**Transcript channel:** _(none)_',
    logChannelId ? `**Log channel:** <#${logChannelId}>` : '**Log channel:** _(none)_',
    validStaff.length
      ? `**Staff roles:** ${validStaff.map((id) => `<@&${id}>`).join(' ')}`
      : '**Staff roles:** _(none)_',
    `**Panel categories:** ${panelResult.ok ? panelResult.value.length : 0} configured`,
    '',
    '_Run `/panel refresh` on existing panels to apply the new category buttons._',
  ].join('\n')
  await interaction.editReply({ content: summary, allowedMentions: { parse: [] } })
}
