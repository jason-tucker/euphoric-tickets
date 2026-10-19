import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { ChannelType, MessageFlags } from 'discord.js'
import { db } from '../src/db/client'
import { businesses, ticketPanels } from '../src/db/schema'
import type { Business } from '../src/db/schema'
import { buildPanelEditPayload, buildPanelMessage } from '../src/services/ticketRenderer'
import { handlePanelPost, postTeamPanel } from '../src/services/panelService'
import { createInternalServer } from '../src/bot/internalHttp'
import { execute as executePanel } from '../src/commands/panel'
import { BOT_ID, componentsJson, fakeClient, seedTeam, type FakeGuild, type FakeMember, type FakeTextChannel } from './fakes'
import { stubFetch } from './helpers'

beforeEach(() => {
  stubFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const CATS = [{ key: 'support', label: 'Support', emoji: '🎫', description: null }] as any
const LEGACY = { content: 'old', embeds: [{ title: 'Contact us', description: 'Click below' }] }

async function team(
  name: string,
  opts: Parameters<typeof seedTeam>[0] = {},
  channelType: ChannelType.GuildText | ChannelType.GuildAnnouncement = ChannelType.GuildText,
) {
  const t = await seedTeam({ category: { key: 'support', label: 'Support' }, ...opts })
  const [business] = await db.update(businesses).set({ name }).where(eq(businesses.id, t.business.id)).returning()
  const channel = await t.guild.channels.create({ name: 'contact', type: channelType })
  return { ...t, business, channel }
}

async function panelRow(messageId: string) {
  const [row] = await db.select().from(ticketPanels).where(eq(ticketPanels.messageId, messageId))
  return row
}

describe('panel heading names the team', () => {
  it('renders `## 🎫 Open a Ticket · <team>` with markdown escaped, and no suffix without a name', () => {
    expect(componentsJson(buildPanelMessage(CATS, 'Serenade Supply Co') as any)).toContain('## 🎫 Open a Ticket · Serenade Supply Co')
    const escaped = componentsJson(buildPanelMessage(CATS, 'Euphoric_FM *live*') as any)
    expect(escaped).toContain(JSON.stringify('## 🎫 Open a Ticket · Euphoric\\_FM \\*live\\*').slice(1, -1))
    const plain = componentsJson(buildPanelMessage(CATS) as any)
    expect(plain).toContain('"## 🎫 Open a Ticket"')
  })

  it('the edit payload clears legacy content/embeds/attachments and sets IS_COMPONENTS_V2', () => {
    const p = buildPanelEditPayload(CATS, 'EuphoricFM')
    expect(p.content).toBeNull()
    expect(p.embeds).toEqual([])
    expect(p.attachments).toEqual([])
    expect(p.flags).toBe(MessageFlags.IsComponentsV2)
    expect(componentsJson(p as any)).toContain('tk:open:support')
    expect(componentsJson(p as any)).toContain('Open a Ticket · EuphoricFM')
  })
})

describe('postTeamPanel', () => {
  it('new post: sends the team-named panel and inserts the ticket_panels row', async () => {
    const t = await team('EuphoricFM')
    const out = await postTeamPanel({ channel: t.channel as any, business: t.business, botUserId: BOT_ID, postedBy: '200000000000000099' })
    expect(out).toMatchObject({ ok: true, adopted: false, channelId: t.channel.id, categories: ['support'] })
    expect(componentsJson(t.channel.sent[0])).toContain('Open a Ticket · EuphoricFM')
    const row = await panelRow((out as any).messageId)
    expect(row).toMatchObject({ businessId: t.business.id, guildId: t.guild.id, channelId: t.channel.id, postedByDiscordId: '200000000000000099' })
  })

  it('adopts a bot-authored legacy message: edited in place (legacy fields cleared) and the row is upserted', async () => {
    const other = await team('Euphoric')
    const t = await team('EuphoricFM', { guild: other.guild })
    const legacy = t.channel.addMessage(BOT_ID, LEGACY)
    // A stale row for the same message (another team) is taken over, not duplicated.
    await db.insert(ticketPanels).values({
      businessId: other.business.id,
      guildId: t.guild.id,
      channelId: 'stale-channel',
      messageId: legacy.id,
      postedByDiscordId: 'someone',
    })
    const out = await postTeamPanel({ channel: t.channel as any, business: t.business, botUserId: BOT_ID, postedBy: BOT_ID, messageId: legacy.id })
    expect(out).toMatchObject({ ok: true, adopted: true, messageId: legacy.id })
    expect(t.channel.sent).toHaveLength(0)
    expect(legacy.edits).toHaveLength(1)
    expect(legacy.edits[0]).toMatchObject({ content: null, embeds: [], attachments: [], flags: MessageFlags.IsComponentsV2 })
    expect(componentsJson(legacy.edits[0])).toContain('Open a Ticket · EuphoricFM')
    const rows = await db.select().from(ticketPanels).where(eq(ticketPanels.messageId, legacy.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ businessId: t.business.id, channelId: t.channel.id, postedByDiscordId: BOT_ID })
  })

  it('refuses a message authored by someone else, and a missing message; nothing is edited or stored', async () => {
    const t = await team('EuphoricFM')
    const foreign = t.channel.addMessage('300000000000000001', LEGACY)
    const out = await postTeamPanel({ channel: t.channel as any, business: t.business, botUserId: BOT_ID, postedBy: BOT_ID, messageId: foreign.id })
    expect(out).toMatchObject({ ok: false, status: 403, error: 'not_bot_message' })
    expect(foreign.edits).toHaveLength(0)
    expect(await panelRow(foreign.id)).toBeUndefined()
    const missing = await postTeamPanel({ channel: t.channel as any, business: t.business, botUserId: BOT_ID, postedBy: BOT_ID, messageId: '300000000000000002' })
    expect(missing).toMatchObject({ ok: false, status: 404, error: 'message_not_found' })
  })

  it('refuses a team with zero public categories', async () => {
    const t = await team('Staff Only', { category: { key: 'internal', label: 'Internal', staffOnly: true } })
    const out = await postTeamPanel({ channel: t.channel as any, business: t.business, botUserId: BOT_ID, postedBy: BOT_ID })
    expect(out).toMatchObject({ ok: false, status: 409, error: 'no_categories' })
    expect(t.channel.sent).toHaveLength(0)
  })
})

describe('/panel post message_id + /panel refresh', () => {
  function slash(guild: FakeGuild, channel: FakeTextChannel, member: FakeMember, sub: string, strings: Record<string, string | null>) {
    return {
      inGuild: () => true,
      guild,
      guildId: guild.id,
      channelId: channel.id,
      channel,
      user: { id: member.id },
      client: fakeClient(guild),
      options: { getSubcommand: () => sub, getString: (n: string) => strings[n] ?? null },
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
    }
  }

  it('adopts a bot message on a multi-team server, refuses a foreign one, and refresh keeps the team name', async () => {
    const first = await team('Euphoric')
    const t = await team('Serenade Supply Co', { guild: first.guild })
    const mod = t.guild.addMember({ username: 'mod', manageGuild: true })
    const legacy = t.channel.addMessage(BOT_ID, LEGACY)

    const i = slash(t.guild, t.channel, mod, 'post', { team: t.business.slug, message_id: legacy.id })
    await executePanel(i as any)
    expect(i.editReply).toHaveBeenCalledWith(`✓ Turned message \`${legacy.id}\` in <#${t.channel.id}> into the **Serenade Supply Co** panel.`)
    expect((await panelRow(legacy.id)).businessId).toBe(t.business.id)

    const foreign = t.channel.addMessage(mod.id, LEGACY)
    const no = slash(t.guild, t.channel, mod, 'post', { team: t.business.slug, message_id: foreign.id })
    await executePanel(no as any)
    expect(no.editReply).toHaveBeenCalledWith(expect.stringContaining('was not sent by this bot'))
    expect(foreign.edits).toHaveLength(0)

    const r = slash(t.guild, t.channel, mod, 'refresh', { message_id: legacy.id })
    await executePanel(r as any)
    expect(legacy.edits).toHaveLength(2)
    expect(legacy.edits[1]).toMatchObject({ content: null, embeds: [], attachments: [] })
    expect(componentsJson(legacy.edits[1])).toContain('Open a Ticket · Serenade Supply Co')
  })

  it('refresh of an older panel without a stored team uses the guild default team name', async () => {
    const t = await team('Euphoric')
    const mod = t.guild.addMember({ username: 'mod', manageGuild: true })
    const msg = t.channel.addMessage(BOT_ID)
    await db.insert(ticketPanels).values({ businessId: null, guildId: t.guild.id, channelId: t.channel.id, messageId: msg.id, postedByDiscordId: mod.id })
    const r = slash(t.guild, t.channel, mod, 'refresh', { message_id: msg.id })
    await executePanel(r as any)
    expect(componentsJson(msg.edits[0])).toContain('Open a Ticket · Euphoric')
  })
})

describe('POST /api/internal/panel/post', () => {
  const body = (t: { guild: FakeGuild; channel: FakeTextChannel; business: Business }, extra: Record<string, unknown> = {}) => ({
    guildId: t.guild.id,
    channelId: t.channel.id,
    business: t.business.slug,
    ...extra,
  })

  it('requires the internal token; with it, posts a new panel (201) by slug', async () => {
    const t = await team('EuphoricFM')
    const server = createInternalServer(fakeClient(t.guild))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/panel/post`
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body(t)) })
    try {
      expect((await post({})).status).toBe(401)
      expect((await post({ 'x-internal-token': 'x'.repeat(process.env.INTERNAL_TOKEN!.length) })).status).toBe(401)
      const res = await post({ 'x-internal-token': process.env.INTERNAL_TOKEN! })
      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json).toMatchObject({ ok: true, channelId: t.channel.id, business: t.business.slug, categories: ['support'], adopted: false })
      expect((await panelRow(json.messageId)).postedByDiscordId).toBe(BOT_ID)
      expect(componentsJson(t.channel.sent[0])).toContain('Open a Ticket · EuphoricFM')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('adopts a bot message by business id with postedBy (200), refuses a foreign author', async () => {
    const t = await team('EuphoricFM')
    const legacy = t.channel.addMessage(BOT_ID, LEGACY)
    const res = await handlePanelPost(fakeClient(t.guild), body(t, { business: t.business.id, messageId: legacy.id, postedBy: '200000000000000077' }))
    expect(res).toEqual({
      status: 200,
      body: { ok: true, messageId: legacy.id, channelId: t.channel.id, business: t.business.slug, categories: ['support'], adopted: true },
    })
    expect(legacy.edits[0]).toMatchObject({ content: null, embeds: [], flags: MessageFlags.IsComponentsV2 })
    expect((await panelRow(legacy.id)).postedByDiscordId).toBe('200000000000000077')

    const foreign = t.channel.addMessage('300000000000000001', LEGACY)
    const no = await handlePanelPost(fakeClient(t.guild), body(t, { messageId: foreign.id }))
    expect(no.status).toBe(403)
    expect(no.body).toMatchObject({ ok: false, error: 'not_bot_message' })
  })

  it('400 validation, 404 unknown team / channel, 403 team of another guild, 409 zero categories', async () => {
    const t = await team('EuphoricFM')
    const client = fakeClient(t.guild)
    for (const bad of [null, [], {}, body(t, { guildId: 'nope' }), body(t, { business: '' }), body(t, { messageId: 'abc' }), body(t, { postedBy: 12 })]) {
      const r = await handlePanelPost(client, bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.body).toMatchObject({ ok: false, error: 'validation' })
      expect(typeof r.body.message).toBe('string')
    }
    expect((await handlePanelPost(client, body(t, { business: 'no-such-team' }))).body).toMatchObject({ error: 'business_not_found' })
    expect((await handlePanelPost(client, body(t, { channelId: '300000000000000123' }))).status).toBe(404)
    const catId = t.guild.addCategory()
    expect((await handlePanelPost(client, body(t, { channelId: catId }))).body).toMatchObject({ error: 'channel_not_found' })

    const elsewhere = await team('Serenade Supply Co')
    const mismatch = await handlePanelPost(client, body(t, { business: elsewhere.business.slug }))
    expect(mismatch.status).toBe(403)
    expect(mismatch.body).toMatchObject({ ok: false, error: 'business_guild_mismatch' })

    const staffOnly = await team('Staff Only', { guild: t.guild, category: { key: 'internal', label: 'Internal', staffOnly: true } })
    const none = await handlePanelPost(client, body(t, { business: staffOnly.business.slug }))
    expect(none.status).toBe(409)
    expect(none.body).toMatchObject({ ok: false, error: 'no_categories' })
    expect(t.channel.sent).toHaveLength(0)
  })
})

// v0.10.2: #contact on the live server is an announcement channel (type 5).
describe('panels in announcement channels', () => {
  const body = (t: { guild: FakeGuild; channel: FakeTextChannel; business: Business }, extra: Record<string, unknown> = {}) => ({
    guildId: t.guild.id,
    channelId: t.channel.id,
    business: t.business.slug,
    ...extra,
  })

  it('the route posts a new panel and adopts a bot message in an announcement channel', async () => {
    const t = await team('EuphoricFM', {}, ChannelType.GuildAnnouncement)
    const client = fakeClient(t.guild)
    const created = await handlePanelPost(client, body(t))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ ok: true, channelId: t.channel.id, adopted: false })
    expect(componentsJson(t.channel.sent[0])).toContain('Open a Ticket · EuphoricFM')

    const legacy = t.channel.addMessage(BOT_ID, LEGACY)
    const adopted = await handlePanelPost(client, body(t, { messageId: legacy.id }))
    expect(adopted.status).toBe(200)
    expect(adopted.body).toMatchObject({ ok: true, messageId: legacy.id, adopted: true })
    expect(legacy.edits[0]).toMatchObject({ content: null, embeds: [], flags: MessageFlags.IsComponentsV2 })
    expect((await panelRow(legacy.id)).channelId).toBe(t.channel.id)
  })

  it('/panel post (adopt) and /panel refresh work in an announcement channel', async () => {
    const t = await team('Serenade Supply Co', {}, ChannelType.GuildAnnouncement)
    const mod = t.guild.addMember({ username: 'mod', manageGuild: true })
    const legacy = t.channel.addMessage(BOT_ID, LEGACY)
    const base = {
      inGuild: () => true,
      guild: t.guild,
      guildId: t.guild.id,
      channelId: t.channel.id,
      channel: t.channel,
      user: { id: mod.id },
      client: fakeClient(t.guild),
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
    }
    const post = { ...base, options: { getSubcommand: () => 'post', getString: (n: string) => (n === 'message_id' ? legacy.id : null) } }
    await executePanel(post as any)
    expect(post.reply).not.toHaveBeenCalled()
    expect(post.editReply).toHaveBeenCalledWith(expect.stringContaining('into the **Serenade Supply Co** panel'))

    const fresh = { ...base, options: { getSubcommand: () => 'post', getString: () => null } }
    await executePanel(fresh as any)
    expect(componentsJson(t.channel.sent[0])).toContain('Open a Ticket · Serenade Supply Co')

    const refresh = { ...base, editReply: vi.fn(async () => {}), options: { getSubcommand: () => 'refresh', getString: (n: string) => (n === 'message_id' ? legacy.id : null) } }
    await executePanel(refresh as any)
    expect(refresh.editReply).toHaveBeenCalledWith(expect.stringContaining('✓ Refreshed panel'))
    expect(legacy.edits).toHaveLength(2)
  })

  it('voice / forum / category channels are still refused (404); another guild\'s channel is 404, not 503', async () => {
    const t = await team('EuphoricFM')
    const client = fakeClient(t.guild)
    for (const type of [ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildCategory, ChannelType.GuildStageVoice]) {
      const id = t.guild.addChannelOfType(type)
      const r = await handlePanelPost(client, body(t, { channelId: id }))
      expect(r.status, `type ${type}`).toBe(404)
      expect(r.body).toMatchObject({ ok: false, error: 'channel_not_found' })
    }
    const other = await team('Elsewhere')
    const cross = await handlePanelPost(client, body(t, { channelId: other.channel.id }))
    expect(cross.status).toBe(404)
    expect(cross.body).toMatchObject({ ok: false, error: 'channel_not_found' })
    expect(other.channel.sent).toHaveLength(0)
  })

  it('/panel post refuses a non-panel channel type', async () => {
    const t = await team('EuphoricFM')
    const mod = t.guild.addMember({ username: 'mod', manageGuild: true })
    const voice = { id: t.guild.addChannelOfType(ChannelType.GuildVoice), type: ChannelType.GuildVoice }
    const i = {
      inGuild: () => true,
      guild: t.guild,
      guildId: t.guild.id,
      channelId: voice.id,
      channel: voice,
      user: { id: mod.id },
      client: fakeClient(t.guild),
      options: { getSubcommand: () => 'post', getString: () => null },
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {}),
    }
    await executePanel(i as any)
    expect(i.reply).toHaveBeenCalledWith({ content: 'Run this in a text or announcement channel.', ephemeral: true })
  })
})
