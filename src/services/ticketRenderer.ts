import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js'
import type { PanelCategory } from './settingsService'

const ACCENT = 0xa855f7

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}

export function buildPanelMessage(categories: PanelCategory[]) {
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎫 Open a Ticket'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'Need help? Pick a category below to open a private ticket with the staff team.\n' +
      'Only you and staff will see the channel.'
    ))

  const buttons = categories.slice(0, 5).map((cat) => {
    const btn = new ButtonBuilder()
      .setCustomId(`tk:open:${cat.key}`)
      .setLabel(cat.label.slice(0, 80))
      .setStyle(ButtonStyle.Primary)
    if (cat.emoji) btn.setEmoji(cat.emoji)
    return btn
  })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  }
}

export function buildTicketWelcome(opts: {
  ticketId: number
  openerId: string
  categoryLabel: string
  staffRoleIds: string[]
  claimerId: string | null
}) {
  const { ticketId, openerId, categoryLabel, staffRoleIds, claimerId } = opts

  const lines: string[] = [
    `## 🎫 Ticket #${ticketId} — ${categoryLabel}`,
    `Opened by <@${openerId}>`,
  ]
  if (claimerId) lines.push(`Claimed by <@${claimerId}>`)
  const staffMentions = staffRoleIds.map((id) => `<@&${id}>`).join(' ')
  if (staffMentions) lines.push(`Staff: ${staffMentions}`)

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '_Describe your issue in this channel. Staff will be with you shortly._\n' +
      '_When the issue is resolved, anyone can press **Close** below._'
    ))

  const claimBtn = new ButtonBuilder()
    .setCustomId(`tk:claim:${ticketId}`)
    .setLabel(claimerId ? 'Claimed' : 'Claim')
    .setStyle(claimerId ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setEmoji('✋')
    .setDisabled(Boolean(claimerId))

  const closeBtn = new ButtonBuilder()
    .setCustomId(`tk:close:${ticketId}`)
    .setLabel('Close')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🔒')

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(claimBtn, closeBtn)

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  }
}

export function buildCloseConfirm(ticketId: number) {
  const container = new ContainerBuilder()
    .setAccentColor(0xef4444)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Close this ticket?'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'A transcript will be saved (if configured) and this channel will be deleted.'
    ))

  const confirm = new ButtonBuilder()
    .setCustomId(`tk:close_confirm:${ticketId}`)
    .setLabel('Close & delete')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🔒')

  const cancel = new ButtonBuilder()
    .setCustomId(`tk:close_cancel:${ticketId}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary)

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  }
}
