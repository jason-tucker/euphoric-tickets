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
  getPanelCategories,
  getStaffRoleIds,
  updateBusinessSettings,
} from '../../services/settingsService'
import { getBusinessByGuildId, getBusinessBySlugInGuild } from '../../services/businessResolver'
import { reconcileBusinessTicketTool } from '../../services/ticketToolIngest'

export async function handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return

  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  // customId is `tk:settings:<action>[:<teamSlug>]` — the slug scopes the action
  // to a specific team (servers can host more than one). Legacy buttons omit it.
  const [action, slug] = interaction.customId.slice('tk:settings:'.length).split(':')
  const business = slug
    ? await getBusinessBySlugInGuild(interaction.guild.id, slug)
    : await getBusinessByGuildId(interaction.guild.id)
  if (!business) {
    await interaction.reply({
      content: 'This server is not configured as a team — create one at https://tickets.euphoric.fm/admin.',
      ephemeral: true,
    })
    return
  }

  // Flip the ticket system for this team between euphoric-native and TicketTool.
  if (action === 'togglemode') {
    const next = business.ticketMode === 'tickettool' ? 'euphoric' : 'tickettool'
    await updateBusinessSettings(interaction.guild.id, { ticketMode: next }, business)

    // Switching on → back-grab any already-open TicketTool tickets now.
    let grabbed = 0
    if (next === 'tickettool') {
      const fresh = await getBusinessBySlugInGuild(interaction.guild.id, business.slug)
      if (fresh) grabbed = await reconcileBusinessTicketTool(interaction.client, fresh).catch(() => 0)
    }

    await interaction.reply({
      content:
        next === 'tickettool'
          ? '🔁 This team now runs on **TicketTool**. euphoric won’t open its own tickets here — it ingests + controls TicketTool’s.' +
            (grabbed > 0 ? ` Back-grabbed **${grabbed}** open ticket${grabbed === 1 ? '' : 's'}.` : '') +
            ' Make sure watched categories + prefix are set, and that this bot is whitelisted in TicketTool → Server Configs → Bot.'
          : '🔁 This team now runs on **Euphoric Tickets** (native panels + web). TicketTool ingestion is paused.',
      ephemeral: true,
    })
    return
  }

  if (action !== 'edit') {
    await interaction.reply({ content: `Unknown settings action: ${action}`, ephemeral: true })
    return
  }

  // Source of truth lives on `businesses` / `ticket_categories`, scoped to the
  // resolved team.
  const [catId, staffIds, panelCats] = await Promise.all([
    getCategoryId(interaction.guild.id, business),
    getStaffRoleIds(interaction.guild.id, business),
    getPanelCategories(interaction.guild.id, business),
  ])

  const modal = new ModalBuilder()
    .setCustomId(`tk:settings_modal:${business.slug}`)
    .setTitle(`Edit Settings — ${business.name}`.slice(0, 45))

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

  // TicketTool coexistence: watched category IDs (CSV) + command prefix. Empty
  // category list = feature off. Editing here mirrors the web settings card.
  const ttCategoriesInput = new TextInputBuilder()
    .setCustomId('tickettool_category_ids')
    .setLabel('TicketTool category IDs (CSV, blank=off)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('Categories TicketTool opens tickets under')
    .setValue(business?.ticketToolCategoryIds ?? '')

  const ttPrefixInput = new TextInputBuilder()
    .setCustomId('tickettool_prefix')
    .setLabel('TicketTool command prefix')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(5)
    .setValue(business?.ticketToolPrefix ?? '$')

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(categoryInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(staffInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(panelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(ttCategoriesInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(ttPrefixInput),
  )

  await interaction.showModal(modal)
}
