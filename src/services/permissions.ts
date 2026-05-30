// Lantern P2 — three-tier permission helpers used by every slash-command
// handler in src/commands/tickets.ts and by openTicket() in ticketService.ts.
//
// Tiers (strongest → weakest):
//   1. owner / admin / sudo — in businesses.admin_role_ids, OR guild
//      ADMINISTRATOR, OR isSudoUser(). Only tier allowed to delete Discord
//      channels and edit settings.
//   2. staff (per-category)   — has any role in ticket_categories.staff_role_ids
//      of the ticket's category. When the column is empty, falls back to the
//      business-wide admin set so existing behavior is preserved.
//   3. opener                 — discord_id matches the ticket.opener_user_id's
//      Discord identity. Can see + reply + close their own ticket.
//   4. member                 — in the guild, no extra perms.

import { PermissionFlagsBits, type GuildMember } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { ticketCategories, type TicketCategory } from '../db/schema/ticketCategories'
import { tickets, type Ticket } from '../db/schema/tickets'
import { type Business } from '../db/schema/businesses'
import { isSudoUser } from './sudoService'
import { getDiscordIdForUserId } from './userResolver'

export function parseCsv(input: string | null | undefined): string[] {
  if (!input) return []
  return input.split(',').map((s) => s.trim()).filter(Boolean)
}

// Resolves the effective staff-role list for a ticket: per-category override
// when set, otherwise the business-wide admins. P1 ships the columns; this
// helper is where the "category wins, else business" rule lives.
export function staffRoleIdsForCategory(
  business: Business,
  category: Pick<TicketCategory, 'staffRoleIds'> | null | undefined,
): string[] {
  const perCategory = parseCsv(category?.staffRoleIds)
  if (perCategory.length > 0) return perCategory
  return parseCsv(business.adminRoleIds)
}

// True if the member counts as admin/manager of this business. Guild
// ADMINISTRATOR overrides everything (matches the web's deriveLevel).
export function isAdminForBusiness(member: GuildMember, business: Business): boolean {
  if (isSudoUser(member)) return true
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true
  const adminRoleIds = parseCsv(business.adminRoleIds)
  return adminRoleIds.some((id) => member.roles.cache.has(id))
}

// True if the member can act as staff on this ticket's category. Always
// true for admins (they're the strict superset).
export function isStaffForCategory(
  member: GuildMember,
  business: Business,
  category: Pick<TicketCategory, 'staffRoleIds'> | null | undefined,
): boolean {
  if (isAdminForBusiness(member, business)) return true
  const staffIds = staffRoleIdsForCategory(business, category)
  return staffIds.some((id) => member.roles.cache.has(id))
}

// Panel-button gate. Empty allow_role_ids = anyone in the guild may open;
// non-empty = require at least one matching role. Admins always pass.
export function canOpenCategory(
  member: GuildMember,
  business: Business,
  category: Pick<TicketCategory, 'allowRoleIds'>,
): boolean {
  if (isAdminForBusiness(member, business)) return true
  const allow = parseCsv(category.allowRoleIds)
  if (allow.length === 0) return true
  return allow.some((id) => member.roles.cache.has(id))
}

// Per-ticket access shape used by command handlers. canDelete is the only
// admin-locked action; everything else is staff-or-above.
export type TicketAccess = {
  isAdmin: boolean
  isStaff: boolean
  isOpener: boolean
  canClaim: boolean
  canClose: boolean
  canReply: boolean
  canManageMembers: boolean
  canChangeCategory: boolean
  canDelete: boolean
  category: TicketCategory | null
}

// Loads the ticket's category row (or null if uncategorised) and the
// member's effective rights against it. Single DB round-trip.
export async function resolveTicketAccess(
  member: GuildMember,
  business: Business,
  ticket: Pick<Ticket, 'categoryId' | 'openerUserId'>,
): Promise<TicketAccess> {
  const [category] = ticket.categoryId
    ? await db.select().from(ticketCategories).where(eq(ticketCategories.id, ticket.categoryId)).limit(1)
    : [null as TicketCategory | null]

  const isAdmin = isAdminForBusiness(member, business)
  const isStaff = isAdmin || isStaffForCategory(member, business, category)

  const openerDiscordId = await getDiscordIdForUserId(ticket.openerUserId)
  const isOpener = openerDiscordId === member.id

  return {
    isAdmin,
    isStaff,
    isOpener,
    canClaim: isStaff,
    canClose: isStaff || isOpener,
    canReply: isStaff || isOpener,
    canManageMembers: isStaff,
    canChangeCategory: isAdmin,
    canDelete: isAdmin,
    category,
  }
}

// Convenience for places that have only a discord channel id and need the
// ticket row alongside its access decision.
export async function resolveTicketAccessByChannel(
  member: GuildMember,
  business: Business,
  channelId: string,
): Promise<{ ticket: Ticket; access: TicketAccess } | null> {
  const [t] = await db.select().from(tickets).where(eq(tickets.discordChannelId, channelId)).limit(1)
  if (!t) return null
  const access = await resolveTicketAccess(member, business, t)
  return { ticket: t, access }
}
