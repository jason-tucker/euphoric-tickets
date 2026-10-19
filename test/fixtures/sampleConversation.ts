import { ChannelType, Client, SnowflakeUtil, type Message, type TextChannel } from 'discord.js'

// discord.js derives createdAt from the snowflake, so message ids encode the time.
// (sequence pinned to 0 so the same time always yields the same id).
const idAt = (iso: string) => SnowflakeUtil.generate({ timestamp: Date.parse(iso), increment: 0n }).toString()

// A small, entirely fictional ticket conversation built from REAL discord.js
// structures (an unconnected Client's caches — no token, no gateway, no REST)
// so the Discord-style transcript renderer sees genuine Message objects:
// a mention, a reply, an embed and an attachment.
export function sampleConversation(): { client: Client; channel: TextChannel; messages: Message[] } {
  const client = new Client({ intents: [] })
  const guildId = '300000000000000001'
  const channelId = '300000000000000002'
  const guild = (client.guilds as any)._add({
    id: guildId,
    name: 'Sample Server',
    icon: null,
    roles: [{ id: guildId, name: '@everyone', permissions: '0', position: 0, color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null } }],
    channels: [],
    members: [],
  })
  const channel = (client.channels as any)._add(
    { id: channelId, type: ChannelType.GuildText, name: 'ticket-7-sample-user', guild_id: guildId, topic: null, position: 0 },
    guild,
  ) as TextChannel

  const opener = { id: '300000000000000010', username: 'sample_user', global_name: 'Sample User', discriminator: '0', avatar: null }
  const staff = { id: '300000000000000011', username: 'helper_staff', global_name: 'Helper', discriminator: '0', avatar: null }
  const bot = { id: '300000000000000012', username: 'EuphoricTickets', discriminator: '0', avatar: null, bot: true }
  for (const user of [opener, staff, bot]) guild.members._add({ user, roles: [], joined_at: '2026-10-18T09:00:00.000Z' })

  const base = (author: object, ts: string) => ({
    id: idAt(ts),
    channel_id: channelId,
    guild_id: guildId,
    author,
    timestamp: ts,
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [] as object[],
    mention_roles: [],
    attachments: [] as object[],
    embeds: [] as object[],
    pinned: false,
    type: 0,
  })

  const firstId = idAt('2026-10-18T09:01:30.000Z')
  const raw = [
    {
      ...base(bot, '2026-10-18T09:00:00.000Z'),
      content: '',
      embeds: [
        {
          title: 'Ticket #7 — Support',
          description: 'Thanks for opening a ticket! A staff member will be with you shortly.',
          color: 0xa855f7,
          fields: [{ name: 'Subject', value: 'Cannot log in', inline: true }],
          footer: { text: 'Euphoric Tickets' },
        },
      ],
    },
    {
      ...base(opener, '2026-10-18T09:01:30.000Z'),
      content: `Hi <@${staff.id}>, I can't log in since this morning. Screenshot attached.`,
      mentions: [staff],
      attachments: [
        {
          id: '300000000000000200',
          filename: 'login-error.png',
          size: 48213,
          url: 'https://cdn.discordapp.com/attachments/300000000000000002/300000000000000200/login-error.png',
          proxy_url: 'https://media.discordapp.net/attachments/300000000000000002/300000000000000200/login-error.png',
          content_type: 'image/png',
          width: 640,
          height: 360,
        },
      ],
    },
    {
      ...base(staff, '2026-10-18T09:03:05.000Z'),
      content: 'Thanks — I reset your session. Can you try again? **Clear your cache** first.',
      type: 19,
      message_reference: { message_id: firstId, channel_id: channelId, guild_id: guildId },
    },
    {
      ...base(opener, '2026-10-18T09:05:42.000Z'),
      content: 'That worked, thank you! 🎉',
    },
  ]
  const messages = raw.map((m) => (channel.messages as any)._add(m) as Message)
  return { client, channel, messages }
}
