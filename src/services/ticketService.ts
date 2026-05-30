import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js'
import { and, desc, eq } from 'drizzle-orm'
import { env } from '../config/env'
import { db } from '../db/client'
import { tickets, type Ticket } from '../db/schema/tickets'
import { ticketCategories } from '../db/schema/ticketCategories'
import { getBusinessByGuildId } from './businessResolver'
import { getOrCreateUserByDiscordId, getDiscordIdForUserId } from './userResolver'
import { buildTicketWelcome } from './ticketRenderer'
import { fetchAllMessages, renderTranscriptHtml } from './transcriptService'
import { logTicketEvent } from './ticketLogger'
import { log } from './logger'
import { canOpenCategory, staffRoleIdsForCategory } from './permissions'
import { postTicketStatus } from './ticketStatus'

export type OpenResult =
  | { ok: true; channel: TextChannel; ticket: Ticket }
  | { ok: false; reason: string }

const NOT_CONFIGURED =
  'This server is not configured as a team — ask an admin to create one at https://tickets.euphoric.fm/admin.'

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export async function openTicket(opts: {
  guild: Guild
  opener: GuildMember
  categoryKey: string
}): Promise<OpenResult> {
  const { guild, opener, categoryKey } = opts

  const business = await getBusinessByGuildId(guild.id)
  if (!business) return { ok: false, reason: NOT_CONFIGURED }

  const catRows = await db
    .select()
    .from(ticketCategories)
    .where(and(eq(ticketCategories.businessId, business.id), eq(ticketCategories.key, categoryKey)))
    .limit(1)
  const cat = catRows[0]
  if (!cat) return { ok: false, reason: 'Unknown ticket category. The panel may be out of date.' }

  // P2: per-category open-gate. Empty allow_role_ids = anyone may open.
  if (!canOpenCategory(opener, business, cat)) {
    return {
      ok: false,
      reason: `You don't have access to open a **${cat.label}** ticket. Ask an admin if you think you should.`,
    }
  }

  const parentCategoryId = cat.discordParentCategoryId ?? business.discordFallbackCategoryId
  if (!parentCategoryId) {
    return {
      ok: false,
      reason:
        'No Discord category configured for ticket channels. Ask an admin to set one in the web settings or per-category override.',
    }
  }

  const parentCat = await guild.channels.fetch(parentCategoryId).catch(() => null)
  if (!parentCat || parentCat.type !== ChannelType.GuildCategory) {
    return {
      ok: false,
      reason: 'Configured Discord category no longer exists. Ask an admin to fix it on the web.',
    }
  }

  // P2: per-category override wins; falls back to businesses.admin_role_ids
  // when the category has none. Drives the channel ACLs below + the
  // welcome card's staff @ ping.
  const staffRoleIds = staffRoleIdsForCategory(business, cat)

  const openerUserId = await getOrCreateUserByDiscordId(opener.id, {
    name: opener.user.globalName ?? opener.user.username,
    image: opener.user.displayAvatarURL(),
  })

  // Dedupe by (business, opener, category, status='open').
  const existing = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.businessId, business.id), eq(tickets.openerUserId, openerUserId)))
  const stillOpen = existing.find(
    (t) => t.status !== 'closed' && t.categoryId === cat.id,
  )
  if (stillOpen && stillOpen.discordChannelId) {
    const ch = await guild.channels.fetch(stillOpen.discordChannelId).catch(() => null)
    if (ch) {
      return {
        ok: false,
        reason: `You already have an open ticket in this category: <#${stillOpen.discordChannelId}>`,
      }
    }
    // Channel was deleted out from under us — auto-close the row.
    await db
      .update(tickets)
      .set({ status: 'closed', closedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(tickets.id, stillOpen.id))
  }

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

  const subject = truncate(`${categoryKey} from ${opener.user.username}`, 120)
  const [row] = await db
    .insert(tickets)
    .values({
      businessId: business.id,
      openerUserId,
      categoryId: cat.id,
      subject,
      status: 'open',
      discordChannelId: channel.id,
      lastActivityAt: new Date(),
    })
    .returning()

  await channel.setName(`ticket-${row.id}-${safeName}`).catch(() => {})

  const welcome = buildTicketWelcome({
    ticketId: row.id,
    openerId: opener.id,
    categoryLabel: cat.label,
    staffRoleIds,
    claimerId: null,
    webUrl: `${env.WEB_BASE_URL}/b/${business.slug}/tickets/${row.id}`,
  })

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
  if (ticket.status === 'closed') return { ok: false, reason: 'This ticket is already closed.' }
  if (ticket.assigneeUserId) {
    const assigneeDiscordId = await getDiscordIdForUserId(ticket.assigneeUserId)
    return {
      ok: false,
      reason: assigneeDiscordId
        ? `Already claimed by <@${assigneeDiscordId}>.`
        : 'Already claimed.',
    }
  }

  const claimerUserId = await getOrCreateUserByDiscordId(claimer.id, {
    name: claimer.user.globalName ?? claimer.user.username,
    image: claimer.user.displayAvatarURL(),
  })

  const [updated] = await db
    .update(tickets)
    .set({ status: 'claimed', assigneeUserId: claimerUserId, lastActivityAt: new Date() })
    .where(eq(tickets.id, ticket.id))
    .returning()

  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)

  // Silent subtext footer in the ticket channel.
  if (ticket.discordChannelId) {
    const ch = await claimer.guild.channels.fetch(ticket.discordChannelId).catch(() => null)
    if (ch?.isTextBased()) await postTicketStatus(ch as TextChannel, `Ticket claimed by <@${claimer.id}>`)
  }

  void logTicketEvent({
    guild: claimer.guild,
    kind: 'claim',
    ticketId: ticket.id,
    fields: {
      Claimer: `<@${claimer.id}>`,
      Opener: openerDiscordId ? `<@${openerDiscordId}>` : '_(unknown)_',
      Channel: ticket.discordChannelId ? `<#${ticket.discordChannelId}>` : '_(no channel)_',
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

  const closerUserId = await getOrCreateUserByDiscordId(closer.id, {
    name: closer.user.globalName ?? closer.user.username,
    image: closer.user.displayAvatarURL(),
  })

  await db
    .update(tickets)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedByUserId: closerUserId,
      lastActivityAt: new Date(),
    })
    .where(eq(tickets.id, ticket.id))

  // Transcript HTML — used for the opener DM. (The transcript channel
  // setting no longer exists on the web schema; we drop posting to a
  // dedicated channel for now. The DM-to-opener path is preserved.)
  try {
    const messages = await fetchAllMessages(channel)
    const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)
    const opener = openerDiscordId
      ? await guild.members.fetch(openerDiscordId).catch(() => null)
      : null

    const categoryLabel = await loadCategoryLabel(ticket.categoryId)
    const html = renderTranscriptHtml({
      guildName: guild.name,
      channelName: channel.name,
      ticketId: ticket.id,
      openerTag: opener?.user.tag ?? openerDiscordId ?? 'unknown',
      closedByTag: closer.user.tag,
      messages,
    })
    const buf = Buffer.from(html, 'utf8')

    if (opener) {
      const dmFile = new AttachmentBuilder(buf, {
        name: `ticket-${ticket.id}-${channel.name}.html`,
      })
      // Resolve the host business slug for the web link. Best-effort: if
      // the guild isn't tied to a business row, omit the link.
      const business = await getBusinessByGuildId(guild.id)
      const webLink = business
        ? `${env.WEB_BASE_URL}/b/${business.slug}/tickets/${ticket.id}`
        : null
      const content =
        `Your ticket **#${ticket.id}** in **${guild.name}** was closed by ${closer.user.tag}.` +
        (webLink ? `\n\nView the conversation on the web: ${webLink}` : '') +
        '\n\nA full transcript is attached.'
      await opener
        .send({ content, files: [dmFile] })
        .catch((err) => {
          log.info('Opener DM failed (likely DMs closed)', {
            ticketId: ticket.id,
            err: String(err),
          })
        })
    }

    void logTicketEvent({
      guild,
      kind: 'close',
      ticketId: ticket.id,
      fields: {
        Closer: `<@${closer.id}>`,
        Opener: openerDiscordId ? `<@${openerDiscordId}>` : '_(unknown)_',
        Category: categoryLabel ?? '_(none)_',
        Duration: `<t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R> opened`,
      },
    })
  } catch (err) {
    log.error('Transcript generation failed', { ticketId: ticket.id, err: String(err) })
  }

  await channel.delete(`Ticket #${ticket.id} closed by ${closer.user.tag}`).catch((err) => {
    log.warn('Channel delete failed', { ticketId: ticket.id, err: String(err) })
  })

  return { ok: true }
}

async function loadCategoryLabel(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null
  const rows = await db
    .select({ label: ticketCategories.label })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1)
  return rows[0]?.label ?? null
}

// Helper for /tickets list and similar lookups that previously sorted by
// openedAt — pulled out so the command files don't need to repeat the
// ordering ceremony.
export async function listOpenTicketsForBusiness(businessId: string) {
  return db
    .select()
    .from(tickets)
    .where(and(eq(tickets.businessId, businessId)))
    .orderBy(desc(tickets.openedAt))
}
