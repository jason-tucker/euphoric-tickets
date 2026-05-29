import type { GuildMember } from 'discord.js'
import { env } from '../config/env'

export function isSudoUser(member: GuildMember): boolean {
  if (env.sudoUserIds.includes(member.id)) return true
  if (env.sudoRoleIds.length === 0) return false
  return env.sudoRoleIds.some((id) => member.roles.cache.has(id))
}
