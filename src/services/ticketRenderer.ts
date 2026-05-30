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

// Substitute the per-category first-message template placeholders. Shared by
// openTicket (initial render) and the claim re-render so the body stays
// stable when the card refreshes. `{{user}}` becomes a mention — the send
// call uses allowedMentions parse:[] so it renders without an extra ping.
export function renderFirstMessage(
  template: string,
  vars: { userId: string; ticketId: number; subject: string; category: string },
): string {
  return template
    .split('{{user}}').join(`<@${vars.userId}>`)
    .split('{{ticketId}}').join(String(vars.ticketId))
    .split('{{subject}}').join(vars.subject)
    .split('{{category}}').join(vars.category)
}

// P4 (lantern) welcome card. Compact info header up top (rendered as `-#`
// subtext), the ticket reason as the dominant body (custom first-message
// template when the category sets one, else the subject + default prompt),
// and the control buttons underneath.
export function buildTicketWelcome(opts: {
  ticketId: number
  openerId: string
  categoryLabel: string
  categoryEmoji?: string | null
  subject?: string | null
  openedAt?: Date
  staffRoleIds: string[]
  claimerId: string | null
  // Rendered custom first message (already substituted). Null → default body.
  firstMessage?: string | null
  // Optional URL to the web ticket detail — Link button alongside Claim/Close.
  webUrl?: string | null
}) {
  const { ticketId, openerId, categoryLabel, categoryEmoji, subject, openedAt, claimerId, firstMessage, webUrl } =
    opts

  const openedTs = Math.floor((openedAt ?? new Date()).getTime() / 1000)
  const emoji = categoryEmoji ? `${categoryEmoji} ` : '🎫 '

  // Compact header — small subtext so the body dominates.
  const header = [
    `-# ${emoji}**Ticket #${ticketId}** · ${categoryLabel}`,
    `-# Opened by <@${openerId}> · <t:${openedTs}:R>${claimerId ? ` · claimed by <@${claimerId}>` : ''}`,
  ].join('\n')

  // Dominant body — custom template, else subject heading + default prompt.
  const body =
    firstMessage && firstMessage.trim().length > 0
      ? firstMessage.trim()
      : `${subject ? `### ${subject}\n` : ''}Describe your issue in this channel — staff will be with you shortly.`

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))

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
  if (webUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Open in web')
        .setStyle(ButtonStyle.Link)
        .setURL(webUrl)
        .setEmoji('🌐'),
    )
  }

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
