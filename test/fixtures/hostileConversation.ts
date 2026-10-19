import { ChannelType, Client, SnowflakeUtil, type Message, type TextChannel } from 'discord.js'

const idAt = (ms: number) => SnowflakeUtil.generate({ timestamp: ms, increment: 0n }).toString()

// Participant-controlled strings that try to break out of the library's inline
// profiles <script> (display names, nicknames, a hoisted role name, a webhook
// username, an avatar hash) or out of the escaped message content.
export const HOSTILE_NAMES = {
  closeScript: '</script><script>alert(1)//',
  upperCase: '</SCRIPT ><script>alert(2)//',
  comment: '<!--<script>alert(3)//',
  imgOnerror: '</script ><img src=x onerror=alert(4)>',
  quotes: `A "q" <b> & 'x'`,
  attrBreak: '" onmouseover="alert(5)',
  webhook: '</script><iframe srcdoc="<script>parent.alert(11)</script>"></iframe>',
}
export const HOSTILE_ROLE_NAME = '</script><svg onload=alert(6)>'
export const HOSTILE_AVATAR_HASH = 'abc"><script>alert(7)</script>'
export const HOSTILE_CONTENT = [
  '<script>alert(8)</script>',
  '</script><img src=x onerror=alert(9)>',
  '[click](javascript:alert(10)) and <a href="javascript:alert(12)">x</a>',
]

// Fictional conversation built from real discord.js structures (an
// unconnected Client's caches — no token, gateway or REST), like
// sampleConversation, but every participant has a hostile name.
export function hostileConversation(): { client: Client; channel: TextChannel; messages: Message[] } {
  const client = new Client({ intents: [] })
  const guildId = '400000000000000001'
  const channelId = '400000000000000002'
  const roleId = '400000000000000003'
  const colors = (c: number) => ({ primary_color: c, secondary_color: null, tertiary_color: null })
  const guild = (client.guilds as any)._add({
    id: guildId,
    name: 'Hostile "Server" <x>',
    icon: null,
    roles: [
      { id: guildId, name: '@everyone', permissions: '0', position: 0, color: 0, colors: colors(0) },
      { id: roleId, name: HOSTILE_ROLE_NAME, permissions: '0', position: 1, color: 0x3498db, colors: colors(0x3498db), hoist: true },
    ],
    channels: [],
    members: [],
  })
  const channel = (client.channels as any)._add(
    { id: channelId, type: ChannelType.GuildText, name: 'ticket-9-hostile', guild_id: guildId, topic: null, position: 0 },
    guild,
  ) as TextChannel

  const user = (n: number, globalName: string | null, avatar: string | null = null) => ({
    id: `4000000000000001${String(n).padStart(2, '0')}`,
    username: `user_${n}`,
    global_name: globalName,
    discriminator: '0',
    avatar,
  })
  const users = [
    user(1, HOSTILE_NAMES.closeScript),
    user(2, HOSTILE_NAMES.upperCase),
    user(3, HOSTILE_NAMES.comment),
    user(4, HOSTILE_NAMES.imgOnerror, HOSTILE_AVATAR_HASH),
    user(5, HOSTILE_NAMES.quotes),
    user(6, 'plain'), // nickname below
  ]
  for (const u of users) {
    guild.members._add({
      user: u,
      nick: u === users[5] ? HOSTILE_NAMES.attrBreak : null,
      roles: u === users[0] ? [roleId] : [],
      joined_at: '2026-10-18T09:00:00.000Z',
    })
  }
  const webhookAuthor = { id: '400000000000000199', username: HOSTILE_NAMES.webhook, discriminator: '0000', avatar: null, bot: true }

  const t0 = Date.parse('2026-10-18T09:00:00Z')
  const base = (author: object, i: number, content: string, extra: object = {}) => ({
    id: idAt(t0 + i * 1000),
    channel_id: channelId,
    guild_id: guildId,
    author,
    timestamp: new Date(t0 + i * 1000).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    content,
    ...extra,
  })
  const raw: object[] = users.map((u, i) => base(u, i, `hello from ${i}`))
  HOSTILE_CONTENT.forEach((c, i) => raw.push(base(users[i], 10 + i, c)))
  raw.push(base(webhookAuthor, 20, 'via webhook', { webhook_id: '400000000000000098' }))
  // A reply to the first message (whose author has no custom avatar).
  const first = raw[0] as { id: string }
  raw.push(base(users[4], 21, 'replying', { type: 19, message_reference: { message_id: first.id, channel_id: channelId, guild_id: guildId } }))
  const messages = raw.map((m) => (channel.messages as any)._add(m) as Message)
  return { client, channel, messages }
}
