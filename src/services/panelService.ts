import type { Client, TextChannel } from 'discord.js'
import { eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client'
import { businesses, type Business } from '../db/schema/businesses'
import { ticketPanels } from '../db/schema/ticketPanels'
import { getPanelCategories } from './settingsService'
import { buildPanelEditPayload, buildPanelMessage } from './ticketRenderer'
import { lookupTextChannel, type RouteResult } from './integrationTickets'
import { log } from './logger'

// v0.10.1 — posting a team's ticket panel, shared by `/panel post` and the
// internal `POST /api/internal/panel/post` route. Panels are one team per
// message: the ticket_panels row (message_id unique) maps the message to its
// team, which is what `tk:open:<key>` resolves against.

export type PanelPostError = {
  ok: false
  status: number
  error: 'no_categories' | 'message_not_found' | 'not_bot_message' | 'discord_error'
  message: string
}
export type PanelPostResult =
  | { ok: true; messageId: string; channelId: string; business: Business; categories: string[]; adopted: boolean }
  | PanelPostError

export async function postTeamPanel(opts: {
  channel: TextChannel
  business: Business
  botUserId: string
  postedBy: string
  // Adopt this existing message (in `channel`, authored by the bot) instead of
  // sending a new one — e.g. converting a legacy classic-embed message in place.
  messageId?: string | null
}): Promise<PanelPostResult> {
  const { channel, business, botUserId, postedBy, messageId } = opts
  const fail = (status: number, error: PanelPostError['error'], message: string): PanelPostError => ({
    ok: false,
    status,
    error,
    message,
  })

  const categories = await getPanelCategories(channel.guild.id, business)
  if (categories.length === 0) {
    return fail(409, 'no_categories', `Team **${business.name}** has no public categories to put on a panel.`)
  }

  let panelMessageId: string
  if (messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null)
    if (!message) return fail(404, 'message_not_found', `Message \`${messageId}\` was not found in <#${channel.id}>.`)
    if (message.author.id !== botUserId) {
      return fail(403, 'not_bot_message', `Message \`${messageId}\` was not sent by this bot, so it can't be turned into a panel.`)
    }
    try {
      await message.edit(buildPanelEditPayload(categories, business.name) as any)
    } catch (err) {
      log.warn('panel adopt: edit failed', { messageId, err: String(err) })
      return fail(502, 'discord_error', `Discord refused the edit: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    }
    panelMessageId = message.id
  } else {
    try {
      const sent = await channel.send(buildPanelMessage(categories, business.name) as any)
      panelMessageId = sent.id
    } catch (err) {
      log.warn('panel post: send failed', { channelId: channel.id, err: String(err) })
      return fail(502, 'discord_error', `Discord refused the post: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    }
  }

  await db
    .insert(ticketPanels)
    .values({
      businessId: business.id,
      guildId: channel.guild.id,
      channelId: channel.id,
      messageId: panelMessageId,
      postedByDiscordId: postedBy,
    })
    .onConflictDoUpdate({
      target: ticketPanels.messageId,
      set: { businessId: business.id, guildId: channel.guild.id, channelId: channel.id, postedByDiscordId: postedBy },
    })

  return {
    ok: true,
    messageId: panelMessageId,
    channelId: channel.id,
    business,
    categories: categories.map((c) => c.key),
    adopted: Boolean(messageId),
  }
}

// ───────────── POST /api/internal/panel/post ─────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake')

export const panelPostBody = z.object({
  guildId: snowflake,
  channelId: snowflake,
  // Team slug or businesses.id (uuid).
  business: z.string().trim().min(1).max(100),
  messageId: snowflake.nullish(),
  postedBy: snowflake.nullish(),
})

const routeErr = (status: number, error: string, message: string): RouteResult => ({
  status,
  body: { ok: false, error, message },
})

export async function handlePanelPost(client: Client, raw: unknown): Promise<RouteResult> {
  const parsed = panelPostBody.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return routeErr(400, 'validation', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid body')
  }
  const body = parsed.data

  const [business] = await db
    .select()
    .from(businesses)
    .where(UUID_RE.test(body.business) ? or(eq(businesses.id, body.business), eq(businesses.slug, body.business)) : eq(businesses.slug, body.business))
    .limit(1)
  if (!business) return routeErr(404, 'business_not_found', `No team with slug or id \`${body.business}\`.`)
  if (business.discordGuildId !== body.guildId) {
    return routeErr(403, 'business_guild_mismatch', `Team \`${business.slug}\` does not belong to guild ${body.guildId}.`)
  }

  const guild = client.guilds.cache.get(body.guildId)
  if (!guild) return routeErr(503, 'guild_unavailable', `The bot is not in guild ${body.guildId} (or it is unavailable).`)
  const found = await lookupTextChannel(guild, body.channelId)
  if (found.kind === 'gone') return routeErr(404, 'channel_not_found', `Channel ${body.channelId} is not a text channel in that guild.`)
  if (found.kind === 'error') return routeErr(503, 'guild_unavailable', 'Channel lookup failed; retry.')

  const botUserId = client.user!.id
  const out = await postTeamPanel({
    channel: found.channel,
    business,
    botUserId,
    postedBy: body.postedBy ?? botUserId,
    messageId: body.messageId,
  })
  if (!out.ok) return routeErr(out.status, out.error, out.message.replace(/\*\*/g, ''))
  return {
    status: out.adopted ? 200 : 201,
    body: {
      ok: true,
      messageId: out.messageId,
      channelId: out.channelId,
      business: out.business.slug,
      categories: out.categories,
      adopted: out.adopted,
    },
  }
}
