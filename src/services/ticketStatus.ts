import { MessageFlags, type TextChannel } from 'discord.js'
import { log } from './logger'

// Posts a small, silent subtext status line into a ticket channel for
// lifecycle events (claim/unclaim/assign/add/remove/rename/etc.).
//
//   `-# `  → Discord renders the line as grey subtext (footer-sized).
//   SuppressNotifications → makes it a "@silent" message (no ping/badge).
//   allowedMentions parse:[] → <@id> renders as the member's name but
//                              NEVER fires a notification.
//
// IMPORTANT: never call this for internal-note activity. Internal notes are
// private to the staff thread; nothing about them goes to the ticket channel.
//
// Best-effort: a failed status post must never break the action it describes.
export async function postTicketStatus(channel: TextChannel, text: string): Promise<void> {
  await channel
    .send({
      content: `-# ${text}`,
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    })
    .catch((err) => log.warn('postTicketStatus failed', { err: String(err) }))
}
