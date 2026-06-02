import type { ModalSubmitInteraction } from 'discord.js'
import { isSudoUser } from '../../services/sudoService'

// Read a TextInput that may be absent on a stale modal submit (the TicketTool
// rows were added after the original 3). getTextInputValue throws when the
// field is missing, so swallow that and default to empty.
function optionalField(interaction: ModalSubmitInteraction, customId: string): string {
  try {
    return interaction.fields.getTextInputValue(customId).trim()
  } catch {
    return ''
  }
}
import {
  isSnowflake,
  parseSnowflakeCsv,
  replaceTicketCategories,
  updateBusinessSettings,
  validatePanelCategoriesJson,
} from '../../services/settingsService'
import { getBusinessByGuildId } from '../../services/businessResolver'
import { reconcileBusinessTicketTool } from '../../services/ticketToolIngest'

export async function handleSettingsModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  // Require an existing business row — the bot doesn't bootstrap one
  // from scratch. Admins do that via the web at /admin.
  const business = await getBusinessByGuildId(interaction.guild.id)
  if (!business) {
    await interaction.editReply(
      'This server is not configured as a team — create one at https://tickets.euphoric.fm/admin.',
    )
    return
  }

  const categoryId = interaction.fields.getTextInputValue('category_id').trim()
  const staffRoleIdsRaw = interaction.fields.getTextInputValue('staff_role_ids').trim()
  const panelCategoriesRaw = interaction.fields.getTextInputValue('panel_categories')
  const ttCategoriesRaw = optionalField(interaction, 'tickettool_category_ids')
  const ttPrefixRaw = optionalField(interaction, 'tickettool_prefix')

  const errors: string[] = []

  if (!isSnowflake(categoryId)) errors.push('• Fallback tickets category ID is not a valid Discord snowflake.')

  const { ok: validStaff, bad: badStaff } = parseSnowflakeCsv(staffRoleIdsRaw)
  if (badStaff.length) errors.push(`• Invalid staff role IDs: \`${badStaff.join('`, `')}\``)

  const panelResult = validatePanelCategoriesJson(panelCategoriesRaw)
  if (!panelResult.ok) errors.push(`• Panel categories: ${panelResult.error}`)

  const { ok: validTtCats, bad: badTtCats } = parseSnowflakeCsv(ttCategoriesRaw)
  if (badTtCats.length) errors.push(`• Invalid TicketTool category IDs: \`${badTtCats.join('`, `')}\``)
  if (ttPrefixRaw.length > 5) errors.push('• TicketTool prefix must be 1–5 characters.')

  if (errors.length) {
    await interaction.editReply('Could not save:\n' + errors.join('\n'))
    return
  }

  await updateBusinessSettings(interaction.guild.id, {
    discordFallbackCategoryId: categoryId,
    adminRoleIds: validStaff.join(','),
    ticketToolCategoryIds: validTtCats.join(','),
    ticketToolPrefix: ttPrefixRaw || '$',
  })

  if (panelResult.ok) {
    const result = await replaceTicketCategories(interaction.guild.id, panelResult.value)
    if (!result.ok) {
      await interaction.editReply(result.reason)
      return
    }
  }

  // Back-grab already-open TicketTool tickets under the (possibly just-changed)
  // watched categories. updateBusinessSettings invalidated the cache, so this
  // re-read sees the new categories. No-op unless the team is in TicketTool mode.
  let ttReconciled = 0
  const fresh = await getBusinessByGuildId(interaction.guild.id)
  if (fresh) ttReconciled = await reconcileBusinessTicketTool(interaction.client, fresh).catch(() => 0)

  const summary = [
    '✓ Settings saved.',
    `**Fallback tickets category:** <#${categoryId}>`,
    validStaff.length
      ? `**Staff roles:** ${validStaff.map((id) => `<@&${id}>`).join(' ')}`
      : '**Staff roles:** _(none)_',
    `**Panel categories:** ${panelResult.ok ? panelResult.value.length : 0} configured`,
    ...(ttReconciled > 0
      ? [`**TicketTool:** back-grabbed ${ttReconciled} open ticket${ttReconciled === 1 ? '' : 's'} under the watched categories.`]
      : []),
    '',
    '_Run `/panel refresh` on existing panels to apply the new category buttons._',
    '_Transcript + log channel settings are no longer bot-managed — they\'ll come back when the web schema grows columns for them._',
  ].join('\n')
  await interaction.editReply({ content: summary, allowedMentions: { parse: [] } })
}
