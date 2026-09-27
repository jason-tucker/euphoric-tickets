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
import type { IntegrationCard } from '../db/schema/tickets'

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
  // Integration API: the integration-supplied card (persisted on the ticket as
  // integration_card). Its title + lines replace the default body and its
  // link becomes an extra Link button. The tk:* customIds are unchanged.
  card?: IntegrationCard | null
}) {
  const { ticketId, openerId, categoryLabel, categoryEmoji, subject, openedAt, claimerId, firstMessage, webUrl, card } =
    opts

  const openedTs = Math.floor((openedAt ?? new Date()).getTime() / 1000)
  const emoji = categoryEmoji ? `${categoryEmoji} ` : '🎫 '

  // Compact header — small subtext so the body dominates.
  const header = [
    `-# ${emoji}**Ticket #${ticketId}** · ${categoryLabel}`,
    `-# Opened by <@${openerId}> · <t:${openedTs}:R>${claimerId ? ` · claimed by <@${claimerId}>` : ''}`,
  ].join('\n')

  const cardBody = card ? renderCardBody(card) : null
  const hasTemplate = Boolean(firstMessage && firstMessage.trim().length > 0)

  // Dominant body — custom template, else the integration card, else subject
  // heading + default prompt.
  const body = hasTemplate
    ? firstMessage!.trim()
    : cardBody ??
      `${subject ? `### ${subject}\n` : ''}Describe your issue in this channel — staff will be with you shortly.`

  const container = new ContainerBuilder()
    .setAccentColor(ACCENT)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
  // A category template AND a card: the template leads, the card follows.
  if (hasTemplate && cardBody) {
    container.addSeparatorComponents(sep()).addTextDisplayComponents(new TextDisplayBuilder().setContent(cardBody))
  }

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

  // P5: opens an ephemeral category select. The handler enforces admin.
  const changeCatBtn = new ButtonBuilder()
    .setCustomId(`tk:changecat:${ticketId}`)
    .setLabel('Category')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('🗂️')

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(claimBtn, closeBtn, changeCatBtn)
  if (webUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Open in web')
        .setStyle(ButtonStyle.Link)
        .setURL(webUrl)
        .setEmoji('🌐'),
    )
  }
  const cardLinkUrl = card?.link ? safeLinkUrl(card.link.url) : null
  if (card?.link && cardLinkUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel((card.link.label || 'Open').slice(0, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(cardLinkUrl),
    )
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  }
}

// Text Display content caps at 4000 chars; a max-size card (title 100 + 25
// lines × 200) can exceed that, so clamp.
const CARD_BODY_MAX = 3900

function renderCardBody(card: IntegrationCard): string {
  const text = [`### ${card.title}`, ...(card.lines ?? [])].join('\n')
  return text.length > CARD_BODY_MAX ? text.slice(0, CARD_BODY_MAX - 1) + '…' : text
}

// Discord's maximum link-button URL length.
export const LINK_URL_MAX = 512

// Link buttons reject anything but http(s) and anything over 512 chars; a bad
// URL would fail the whole card send, so drop the button instead. The length
// is checked AFTER normalisation — new URL() can lengthen a URL (percent-
// encoding). (The web already enforces the integration's link_origin.)
export function safeLinkUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const out = u.toString()
    return out.length <= LINK_URL_MAX ? out : null
  } catch {
    return null
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
