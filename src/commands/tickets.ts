import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type GuildMember,
  type TextChannel,
} from 'discord.js'
import { logTicketEvent } from '../services/ticketLogger'
import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../db/client'
import { tickets, type Ticket } from '../db/schema/tickets'
import { ticketCategories } from '../db/schema/ticketCategories'
import { isSudoUser } from '../services/sudoService'
import {
  getCategoryId,
  getPanelCategories,
  getStaffRoleIds,
} from '../services/settingsService'
import { claimTicket, closeTicket } from '../services/ticketService'
import { buildCloseConfirm } from '../services/ticketRenderer'
import { getBusinessByGuildId } from '../services/businessResolver'
import { getDiscordIdForUserId, getOrCreateUserByDiscordId } from '../services/userResolver'
import { resolveTicketAccessByChannel, type TicketAccess } from '../services/permissions'
import { log } from '../services/logger'
import { postTicketStatus } from '../services/ticketStatus'

export const data = new SlashCommandBuilder()
  .setName('tickets')
  .setDescription('Ticket controls')
  .addSubcommand((sc) => sc.setName('settings').setDescription('View/edit ticket settings (sudo)'))
  .addSubcommand((sc) => sc.setName('claim').setDescription('Claim the current ticket'))
  .addSubcommand((sc) => sc.setName('unclaim').setDescription('Release the current ticket back to the open pool'))
  .addSubcommand((sc) =>
    sc
      .setName('assign')
      .setDescription('Assign the current ticket to a staff member')
      .addUserOption((opt) => opt.setName('user').setDescription('Staff member to assign').setRequired(true)),
  )
  .addSubcommand((sc) => sc.setName('close').setDescription('Close the current ticket'))
  .addSubcommand((sc) =>
    sc
      .setName('add')
      .setDescription('Add a member to the current ticket (staff)')
      .addUserOption((opt) => opt.setName('user').setDescription('Member to add').setRequired(true)),
  )
  .addSubcommand((sc) =>
    sc
      .setName('remove')
      .setDescription('Remove a member from the current ticket (staff)')
      .addUserOption((opt) => opt.setName('user').setDescription('Member to remove').setRequired(true)),
  )
  .addSubcommand((sc) =>
    sc
      .setName('rename')
      .setDescription('Rename the current ticket channel (staff)')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('New channel name (will be slugified, max 90 chars)')
          .setRequired(true)
          .setMaxLength(90),
      ),
  )
  .addSubcommand((sc) => sc.setName('list').setDescription('List open tickets (staff)'))
  .addSubcommand((sc) =>
    sc
      .setName('delete')
      .setDescription('Delete the current ticket channel (admin only; ticket must be closed)'),
  )
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Server-only command.', ephemeral: true })
    return
  }
  const sub = interaction.options.getSubcommand(true)
  if (sub === 'settings') return await openSettings(interaction)
  if (sub === 'claim') return await claimHere(interaction)
  if (sub === 'unclaim') return await unclaimHere(interaction)
  if (sub === 'assign') return await assignHere(interaction)
  if (sub === 'close') return await closeHere(interaction)
  if (sub === 'add') return await addMember(interaction)
  if (sub === 'remove') return await removeMember(interaction)
  if (sub === 'rename') return await renameTicket(interaction)
  if (sub === 'list') return await listTickets(interaction)
  if (sub === 'delete') return await deleteHere(interaction)
}

// Shared shape for ticket-scoped commands. Looks up the business + ticket by
// channel id and the caller's per-category access. Replies ephemerally on any
// failure and returns null so the handler can early-out.
async function loadCtx(
  interaction: ChatInputCommandInteraction,
): Promise<
  | {
      member: GuildMember
      business: NonNullable<Awaited<ReturnType<typeof getBusinessByGuildId>>>
      ticket: Ticket
      access: TicketAccess
    }
  | null
> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const business = await getBusinessByGuildId(interaction.guild!.id)
  if (!business) {
    await interaction.reply({
      content:
        'This server is not configured as a team — ask an admin to create one at https://tickets.euphoric.fm/admin.',
      ephemeral: true,
    })
    return null
  }
  const res = await resolveTicketAccessByChannel(member, business, interaction.channelId)
  if (!res) {
    await interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true })
    return null
  }
  return { member, business, ticket: res.ticket, access: res.access }
}

async function openSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo only.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const [catId, staffIds, panelCats] = await Promise.all([
    getCategoryId(interaction.guild!.id),
    getStaffRoleIds(interaction.guild!.id),
    getPanelCategories(interaction.guild!.id),
  ])

  const lines = [
    '## ⚙️ Ticket Settings',
    `**Fallback tickets category:** ${catId ? `<#${catId}> (\`${catId}\`)` : '_(not set)_'}`,
    `**Staff roles:** ${staffIds.length ? staffIds.map((id) => `<@&${id}>`).join(' ') : '_(none — only opener can see ticket)_'}`,
    `**Panel categories:** ${panelCats.length} configured`,
    '',
    '_Transcript + log channel settings now live on the web (or are temporarily disabled). Edit business-wide settings at https://tickets.euphoric.fm/admin._',
  ]
  const catJsonPreview =
    '```json\n' +
    JSON.stringify(panelCats, null, 2).slice(0, 700) +
    (JSON.stringify(panelCats).length > 700 ? '\n…' : '') +
    '\n```'

  const container = new ContainerBuilder()
    .setAccentColor(0xa855f7)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Panel categories JSON\n' + catJsonPreview))

  const editBtn = new ButtonBuilder()
    .setCustomId('tk:settings:edit')
    .setLabel('Edit settings')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('✏️')

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(editBtn)

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  } as any)
}

async function claimHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canClaim) {
    await interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true })
    return
  }

  const result = await claimTicket({ ticket: ctx.ticket, claimer: ctx.member })
  if (!result.ok) {
    await interaction.reply({ content: result.reason, ephemeral: true })
    return
  }
  await interaction.reply({ content: `✋ Claimed by <@${ctx.member.id}>.`, allowedMentions: { parse: [] } })
}

async function unclaimHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  const { ticket, member, access } = ctx
  if (ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true })
    return
  }

  // Staff can unclaim anyone; the current assignee can always unclaim themselves.
  const callerUserId = await getOrCreateUserByDiscordId(member.id, {
    name: member.user.globalName ?? member.user.username,
    image: member.user.displayAvatarURL(),
  })
  const isAssignee = ticket.assigneeUserId === callerUserId
  if (!access.isStaff && !isAssignee) {
    await interaction.reply({ content: 'Only staff or the current assignee can unclaim this ticket.', ephemeral: true })
    return
  }

  await db
    .update(tickets)
    .set({ status: 'open', assigneeUserId: null, lastActivityAt: new Date() })
    .where(eq(tickets.id, ticket.id))

  const channel = interaction.channel as TextChannel | null
  if (channel) await postTicketStatus(channel, `Ticket unclaimed by <@${member.id}>`)

  await interaction.reply({ content: '🔓 Unclaimed — ticket is back in the open pool.', allowedMentions: { parse: [] } })
}

async function assignHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canClaim) {
    await interaction.reply({ content: 'Only staff can assign tickets.', ephemeral: true })
    return
  }
  const { ticket } = ctx
  if (ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true })
    return
  }

  const target = interaction.options.getUser('user', true)
  // Best-effort fetch as a guild member so we get the display avatar etc.
  const targetMember = await interaction.guild!.members.fetch(target.id).catch(() => null)
  const targetUserId = await getOrCreateUserByDiscordId(target.id, {
    name: targetMember?.user.globalName ?? targetMember?.user.username ?? target.username,
    image: targetMember?.user.displayAvatarURL() ?? target.displayAvatarURL(),
  })

  await db
    .update(tickets)
    .set({ status: 'claimed', assigneeUserId: targetUserId, lastActivityAt: new Date() })
    .where(eq(tickets.id, ticket.id))

  const channel = interaction.channel as TextChannel | null
  if (channel) await postTicketStatus(channel, `Ticket assigned to <@${target.id}> by <@${ctx.member.id}>`)

  await interaction.reply({
    content: `🪪 Assigned to <@${target.id}>.`,
    allowedMentions: { users: [target.id] },
  })
}

async function closeHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canClose) {
    await interaction.reply({ content: 'Only the opener or staff can close this ticket.', ephemeral: true })
    return
  }

  await interaction.reply({
    ...(buildCloseConfirm(ctx.ticket.id) as any),
  })
}

async function addMember(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canManageMembers) {
    await interaction.reply({ content: 'Only staff can add members to a ticket.', ephemeral: true })
    return
  }
  const { ticket, member } = ctx
  if (ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true })
    return
  }

  const target = interaction.options.getUser('user', true)
  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.reply({ content: 'Channel context missing.', ephemeral: true })
    return
  }

  await channel.permissionOverwrites.edit(target.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  })

  await postTicketStatus(channel, `<@${target.id}> was added to the ticket by <@${member.id}>`)

  await interaction.reply({ content: `➕ <@${target.id}> added to this ticket.`, allowedMentions: { users: [target.id] } })

  void logTicketEvent({
    guild: interaction.guild!,
    kind: 'add',
    ticketId: ticket.id,
    fields: {
      Member: `<@${target.id}>`,
      By: `<@${member.id}>`,
      Channel: `<#${channel.id}>`,
    },
  })
}

async function removeMember(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canManageMembers) {
    await interaction.reply({ content: 'Only staff can remove members from a ticket.', ephemeral: true })
    return
  }
  const { ticket, member } = ctx
  if (ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true })
    return
  }

  const target = interaction.options.getUser('user', true)
  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)
  if (target.id === openerDiscordId) {
    await interaction.reply({ content: 'Cannot remove the ticket opener — close the ticket instead.', ephemeral: true })
    return
  }

  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.reply({ content: 'Channel context missing.', ephemeral: true })
    return
  }

  await channel.permissionOverwrites.delete(target.id, `Removed from ticket #${ticket.id} by ${member.user.tag}`)

  await postTicketStatus(channel, `<@${target.id}> was removed from the ticket by <@${member.id}>`)

  await interaction.reply({ content: `➖ <@${target.id}> removed from this ticket.`, allowedMentions: { parse: [] } })

  void logTicketEvent({
    guild: interaction.guild!,
    kind: 'remove',
    ticketId: ticket.id,
    fields: {
      Member: `<@${target.id}>`,
      By: `<@${member.id}>`,
      Channel: `<#${channel.id}>`,
    },
  })
}

async function listTickets(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const staffRoles = await getStaffRoleIds(interaction.guild!.id)
  const isStaff = staffRoles.some((id) => member.roles.cache.has(id))
  if (!isStaff && !isSudoUser(member)) {
    await interaction.reply({ content: 'Only staff can list tickets.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const business = await getBusinessByGuildId(interaction.guild!.id)
  if (!business) {
    await interaction.editReply(
      'This server is not configured as a team — create one at https://tickets.euphoric.fm/admin.',
    )
    return
  }

  const rows = await db
    .select({
      id: tickets.id,
      categoryId: tickets.categoryId,
      discordChannelId: tickets.discordChannelId,
      openerUserId: tickets.openerUserId,
      assigneeUserId: tickets.assigneeUserId,
      openedAt: tickets.openedAt,
      status: tickets.status,
      categoryKey: ticketCategories.key,
    })
    .from(tickets)
    .leftJoin(ticketCategories, eq(ticketCategories.id, tickets.categoryId))
    .where(and(eq(tickets.businessId, business.id), ne(tickets.status, 'closed')))
    .orderBy(asc(tickets.openedAt))

  if (rows.length === 0) {
    await interaction.editReply('No open tickets. 🎉')
    return
  }

  const MAX_ROWS = 25
  const shown = rows.slice(0, MAX_ROWS)
  // Resolve all opener / assignee Discord IDs in parallel to keep latency
  // bounded — each lookup is cached so the cost is mostly one round-trip
  // the first time staff hits /tickets list.
  const lines = await Promise.all(
    shown.map(async (t) => {
      const opened = Math.floor(t.openedAt.getTime() / 1000)
      const [openerDid, assigneeDid] = await Promise.all([
        getDiscordIdForUserId(t.openerUserId),
        t.assigneeUserId ? getDiscordIdForUserId(t.assigneeUserId) : Promise.resolve(null),
      ])
      const claim = assigneeDid ? `claimed by <@${assigneeDid}>` : '_unclaimed_'
      const channelRef = t.discordChannelId ? `<#${t.discordChannelId}>` : '_(no channel)_'
      const opener = openerDid ? `<@${openerDid}>` : '_(unknown)_'
      const cat = t.categoryKey ?? '_(no category)_'
      return `**#${t.id}** \`${cat}\` · ${channelRef} · ${opener} · ${claim} · <t:${opened}:R>`
    }),
  )
  const overflow = rows.length > MAX_ROWS ? `\n_…and ${rows.length - MAX_ROWS} more._` : ''

  const container = new ContainerBuilder()
    .setAccentColor(0xa855f7)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎫 Open tickets — ${rows.length}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n') + overflow))

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  } as any)
}

async function renameTicket(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canManageMembers) {
    await interaction.reply({ content: 'Only staff can rename tickets.', ephemeral: true })
    return
  }
  const { ticket, member } = ctx
  if (ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', ephemeral: true })
    return
  }

  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.reply({ content: 'Channel context missing.', ephemeral: true })
    return
  }

  const rawName = interaction.options.getString('name', true)
  const slug = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)
  if (!slug) {
    await interaction.reply({ content: 'Name produced an empty slug — pick something with letters or digits.', ephemeral: true })
    return
  }
  const finalName = `ticket-${ticket.id}-${slug}`.slice(0, 100)
  const previousName = channel.name

  await interaction.deferReply()
  await channel.setName(finalName, `Renamed by ${member.user.tag}`)
  await postTicketStatus(channel, `Channel renamed to \`#${finalName}\` by <@${member.id}>`)
  await interaction.editReply({ content: `✏️ Renamed from \`#${previousName}\` to \`#${finalName}\`.`, allowedMentions: { parse: [] } })

  void logTicketEvent({
    guild: interaction.guild!,
    kind: 'rename',
    ticketId: ticket.id,
    fields: {
      'Previous name': `\`#${previousName}\``,
      'New name': `\`#${finalName}\``,
      By: `<@${member.id}>`,
      Channel: `<#${channel.id}>`,
    },
  })
}

// P2: admin-only hard-delete of a closed ticket's Discord channel. Mirrors
// the web's "Delete channel" button. Refuses on still-open tickets so the
// transcript path runs once via close → delete-after-close.
async function deleteHere(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await loadCtx(interaction)
  if (!ctx) return
  if (!ctx.access.canDelete) {
    await interaction.reply({ content: 'Only admins can delete a ticket channel.', ephemeral: true })
    return
  }
  if (ctx.ticket.status !== 'closed') {
    await interaction.reply({
      content: 'Close this ticket first — `/tickets close` — then re-run `/tickets delete` to remove the channel.',
      ephemeral: true,
    })
    return
  }

  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.reply({ content: 'Channel context missing.', ephemeral: true })
    return
  }

  await interaction
    .reply({ content: `🗑️ Deleting channel for ticket #${ctx.ticket.id}…`, ephemeral: true })
    .catch(() => {})

  // Null the discord_* columns so /admin/errors + the web don't keep
  // re-checking a channel that's already gone. Match the bot scheduled
  // cleanup pattern from v0.5.0.
  await db
    .update(tickets)
    .set({
      discordChannelId: null,
      discordWebhookId: null,
      discordWebhookUrl: null,
      discordInternalThreadId: null,
    })
    .where(eq(tickets.id, ctx.ticket.id))

  await channel
    .delete(`Ticket #${ctx.ticket.id} hard-deleted by ${ctx.member.user.tag}`)
    .catch((err) => log.warn('Channel delete failed', { ticketId: ctx.ticket.id, err: String(err) }))
}

export async function executeCloseConfirm(opts: {
  interaction: import('discord.js').ButtonInteraction
  ticketId: number
}): Promise<void> {
  const { interaction, ticketId } = opts
  if (!interaction.inGuild() || !interaction.guild) return
  await interaction.deferUpdate()

  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  const ticket = rows[0]
  if (!ticket) {
    await interaction.editReply({ content: 'Ticket not found.', components: [] })
    return
  }
  const channel = interaction.channel as TextChannel | null
  if (!channel) {
    await interaction.editReply({ content: 'Channel context missing.', components: [] })
    return
  }
  const closer = await interaction.guild.members.fetch(interaction.user.id)

  const result = await closeTicket({
    guild: interaction.guild,
    channel,
    ticket,
    closer,
  })
  if (!result.ok) {
    await interaction.editReply({ content: result.reason, components: [] })
    return
  }
}
