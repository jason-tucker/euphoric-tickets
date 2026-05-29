import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets, type Ticket } from '../db/schema/tickets'
import {
  getCategoryId,
  getPanelCategories,
  getStaffRoleIds,
  getTranscriptChannelId,
} from './settingsService'
import { buildTicketWelcome } from './ticketRenderer'
import { fetchAllMessages, renderTranscriptHtml } from './transcriptService'
import { logTicketEvent } from './ticketLogger'
import { log } from './logger'

export type OpenResult =
  | { ok: true; channel: TextChannel; ticket: Ticket }
  | { ok: false; reason: string }

export async function openTicket(opts: {
  guild: Guild
  opener: GuildMember
  categoryKey: string
}): Promise<OpenResult> {
  const { guild, opener, categoryKey } = opts

  const ticketsCategoryId = await getCategoryId()
  if (!ticketsCategoryId) {
    return { ok: false, reason: 'Tickets category is not configured. Ask an admin to run `/tickets settings`.' }
  }
  const parentCat = await guild.channels.fetch(ticketsCategoryId).catch(() => null)
  if (!parentCat || parentCat.type !== ChannelType.GuildCategory) {
    return { ok: false, reason: 'Configured tickets category no longer exists. Ask an admin to fix `/tickets settings`.' }
  }

  const panelCats = await getPanelCategories()
  const cat = panelCats.find((c) => c.key === categoryKey)
  if (!cat) return { ok: false, reason: 'Unknown ticket category. The panel may be out of date.' }

  const existing = await db
    .select()
    .from(tickets)
    .where(eq(tickets.openerDiscordId, opener.id))
  const stillOpen = existing.find((t) => t.status === 'open' && t.categoryKey === categoryKey)
  if (stillOpen) {
    const ch = await guild.channels.fetch(stillOpen.channelId).catch(() => null)
    if (ch) {
      return { ok: false, reason: `You already have an open ticket in this category: <#${stillOpen.channelId}>` }
    }
    await db.update(tickets).set({ status: 'closed', closedAt: new Date() }).where(eq(tickets.id, stillOpen.id))
  }

  const staffRoleIds = await getStaffRoleIds()

  const safeName = opener.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user'
  const baseName = `ticket-${safeName}`

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: opener.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...staffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    })),
  ]

  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildText,
    parent: parentCat.id,
    permissionOverwrites,
    topic: `Ticket for ${opener.user.tag} · category: ${cat.label}`,
  })

  const [row] = await db
    .insert(tickets)
    .values({
      guildId: guild.id,
      channelId: channel.id,
      openerDiscordId: opener.id,
      categoryKey: cat.key,
    })
    .returning()

  await channel.setName(`ticket-${row.id}-${safeName}`).catch(() => {})

  const welcome = buildTicketWelcome({
    ticketId: row.id,
    openerId: opener.id,
    categoryLabel: cat.label,
    staffRoleIds,
    claimerId: null,
  })

  // Ping opener + staff roles once on creation, then suppress mention resolution
  // on the welcome card itself.
  const pingContent = staffRoleIds.length
    ? `<@${opener.id}> ${staffRoleIds.map((id) => `<@&${id}>`).join(' ')}`
    : `<@${opener.id}>`
  await channel.send({
    content: pingContent,
    allowedMentions: { users: [opener.id], roles: staffRoleIds },
  })
  await channel.send(welcome as any)

  void logTicketEvent({
    guild,
    kind: 'open',
    ticketId: row.id,
    fields: {
      Opener: `<@${opener.id}>`,
      Category: cat.label,
      Channel: `<#${channel.id}>`,
    },
  })

  return { ok: true, channel, ticket: row }
}

export async function claimTicket(opts: {
  ticket: Ticket
  claimer: GuildMember
}): Promise<{ ok: true; updated: Ticket } | { ok: false; reason: string }> {
  const { ticket, claimer } = opts
  if (ticket.status !== 'open') return { ok: false, reason: 'This ticket is already closed.' }
  if (ticket.claimerDiscordId) return { ok: false, reason: `Already claimed by <@${ticket.claimerDiscordId}>.` }
  const [updated] = await db
    .update(tickets)
    .set({ claimerDiscordId: claimer.id })
    .where(eq(tickets.id, ticket.id))
    .returning()

  void logTicketEvent({
    guild: claimer.guild,
    kind: 'claim',
    ticketId: ticket.id,
    fields: {
      Claimer: `<@${claimer.id}>`,
      Opener: `<@${ticket.openerDiscordId}>`,
      Channel: `<#${ticket.channelId}>`,
    },
  })

  return { ok: true, updated }
}

export async function closeTicket(opts: {
  guild: Guild
  channel: TextChannel
  ticket: Ticket
  closer: GuildMember
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { guild, channel, ticket, closer } = opts

  if (ticket.status === 'closed') return { ok: false, reason: 'This ticket is already closed.' }

  await db
    .update(tickets)
    .set({ status: 'closed', closedAt: new Date(), closedByDiscordId: closer.id })
    .where(eq(tickets.id, ticket.id))

  const transcriptChannelId = await getTranscriptChannelId()
  // Render the transcript once if either destination is configured —
  // re-fetching the channel history per destination would be wasteful and
  // the second fetch would see the channel after the first has touched it.
  const wantOpenerDm = true
  if (transcriptChannelId || wantOpenerDm) {
    try {
      const messages = await fetchAllMessages(channel)
      const opener = await guild.members.fetch(ticket.openerDiscordId).catch(() => null)
      const html = renderTranscriptHtml({
        guildName: guild.name,
        channelName: channel.name,
        ticketId: ticket.id,
        openerTag: opener?.user.tag ?? ticket.openerDiscordId,
        closedByTag: closer.user.tag,
        messages,
      })
      const buf = Buffer.from(html, 'utf8')

      if (transcriptChannelId) {
        const file = new AttachmentBuilder(buf, { name: `ticket-${ticket.id}-${channel.name}.html` })
        const transcriptCh = await guild.channels.fetch(transcriptChannelId).catch(() => null)
        if (transcriptCh && transcriptCh.isTextBased() && !transcriptCh.isDMBased()) {
          await transcriptCh.send({
            content:
              `**Ticket #${ticket.id}** closed by <@${closer.id}>\n` +
              `Opened by <@${ticket.openerDiscordId}> · Category: \`${ticket.categoryKey}\` · ${messages.length} messages`,
            files: [file],
          })
        } else {
          log.warn('Transcript channel not text-based', { transcriptChannelId })
        }
      }

      if (opener) {
        const dmFile = new AttachmentBuilder(buf, { name: `ticket-${ticket.id}-${channel.name}.html` })
        await opener
          .send({
            content:
              `Your ticket **#${ticket.id}** in **${guild.name}** was closed by ${closer.user.tag}. ` +
              `A full transcript is attached.`,
            files: [dmFile],
          })
          .catch((err) => {
            log.info('Opener DM failed (likely DMs closed)', { ticketId: ticket.id, err: String(err) })
          })
      }
    } catch (err) {
      log.error('Transcript generation failed', { ticketId: ticket.id, err: String(err) })
    }
  }

  void logTicketEvent({
    guild,
    kind: 'close',
    ticketId: ticket.id,
    fields: {
      Closer: `<@${closer.id}>`,
      Opener: `<@${ticket.openerDiscordId}>`,
      Category: ticket.categoryKey,
      Duration: `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R> opened`,
    },
  })

  await channel.delete(`Ticket #${ticket.id} closed by ${closer.user.tag}`).catch((err) => {
    log.warn('Channel delete failed', { ticketId: ticket.id, err: String(err) })
  })

  return { ok: true }
}
