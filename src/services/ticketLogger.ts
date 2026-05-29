import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Guild,
} from 'discord.js'
import { getLogChannelId } from './settingsService'
import { log } from './logger'

const COLOR_OPEN = 0x22c55e
const COLOR_CLAIM = 0x3b82f6
const COLOR_CLOSE = 0xef4444
const COLOR_OTHER = 0x6b7280

type Kind = 'open' | 'claim' | 'close' | 'add' | 'remove' | 'rename'

function colorFor(kind: Kind): number {
  switch (kind) {
    case 'open': return COLOR_OPEN
    case 'claim': return COLOR_CLAIM
    case 'close': return COLOR_CLOSE
    default: return COLOR_OTHER
  }
}

function titleFor(kind: Kind, ticketId: number): string {
  const tag: Record<Kind, string> = {
    open:   '🎫 Ticket opened',
    claim:  '✋ Ticket claimed',
    close:  '🔒 Ticket closed',
    add:    '➕ Member added',
    remove: '➖ Member removed',
    rename: '✏️ Ticket renamed',
  }
  return `${tag[kind]} — Ticket #${ticketId}`
}

export async function logTicketEvent(opts: {
  guild: Guild
  kind: Kind
  ticketId: number
  fields: Record<string, string>
}): Promise<void> {
  const { guild, kind, ticketId, fields } = opts
  const channelId = await getLogChannelId()
  if (!channelId) return

  const ch = await guild.channels.fetch(channelId).catch(() => null)
  if (!ch || !ch.isTextBased() || ch.isDMBased()) {
    log.warn('Log channel not text-based or missing', { channelId })
    return
  }

  const fieldLines = Object.entries(fields)
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n')

  const container = new ContainerBuilder()
    .setAccentColor(colorFor(kind))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${titleFor(kind, ticketId)}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldLines || '_(no details)_'))

  try {
    await ch.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [] },
    } as any)
  } catch (err) {
    log.warn('Failed to send log event', { kind, ticketId, err: String(err) })
  }
}
