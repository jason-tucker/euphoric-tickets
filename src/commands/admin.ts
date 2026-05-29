import {
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
} from 'discord.js'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { businesses, users } from '../db/schema'
import { isSudoUser } from '../services/sudoService'
import { getOrCreateUserByDiscordId } from '../services/userResolver'
import { invalidateBusinessCache } from '../services/businessResolver'

// Phase A0a + A0b — Discord-side parity for the web's /admin surface.
// Sudo only.
export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Sudo-only system administration')
  .addSubcommandGroup((g) =>
    g
      .setName('sudo')
      .setDescription('Manage sudo flag on user rows')
      .addSubcommand((sc) =>
        sc
          .setName('grant')
          .setDescription('Grant the sudo flag (treated as owner everywhere)')
          .addUserOption((opt) => opt.setName('user').setDescription('Target user').setRequired(true)),
      )
      .addSubcommand((sc) =>
        sc
          .setName('revoke')
          .setDescription('Revoke the sudo flag')
          .addUserOption((opt) => opt.setName('user').setDescription('Target user').setRequired(true)),
      )
      .addSubcommand((sc) => sc.setName('list').setDescription('List every sudo user')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('business')
      .setDescription('Manage business rows')
      .addSubcommand((sc) =>
        sc
          .setName('create')
          .setDescription('Create a host or client business')
          .addStringOption((opt) =>
            opt.setName('slug').setDescription('URL slug (lowercase, hyphens)').setRequired(true).setMaxLength(40),
          )
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Display name').setRequired(true).setMaxLength(80),
          )
          .addStringOption((opt) =>
            opt.setName('guild_id').setDescription('Discord guild snowflake').setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('kind')
              .setDescription('host (operator) or client (visitor org)')
              .setRequired(false)
              .addChoices({ name: 'host', value: 'host' }, { name: 'client', value: 'client' }),
          )
          .addStringOption((opt) =>
            opt.setName('parent_host_slug').setDescription('Required when kind=client').setRequired(false),
          ),
      )
      .addSubcommand((sc) => sc.setName('list').setDescription('List every business (hosts and clients)'))
      .addSubcommand((sc) =>
        sc
          .setName('delete')
          .setDescription('Delete a business by slug (irreversible — drops categories + tickets)')
          .addStringOption((opt) =>
            opt.setName('slug').setDescription('Business slug to delete').setRequired(true),
          ),
      ),
  )
  .setDMPermission(false)
  .setDefaultMemberPermissions(0)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Server-only command.', ephemeral: true })
    return
  }
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudoUser(member)) {
    await interaction.reply({ content: 'Sudo required.', ephemeral: true })
    return
  }

  const group = interaction.options.getSubcommandGroup(true)
  const sub = interaction.options.getSubcommand(true)
  if (group === 'sudo') {
    if (sub === 'grant') return await sudoGrant(interaction)
    if (sub === 'revoke') return await sudoRevoke(interaction)
    if (sub === 'list') return await sudoList(interaction)
  }
  if (group === 'business') {
    if (sub === 'create') return await businessCreate(interaction)
    if (sub === 'list') return await businessList(interaction)
    if (sub === 'delete') return await businessDelete(interaction)
  }
}

async function sudoGrant(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('user', true)
  const userId = await getOrCreateUserByDiscordId(target.id, {
    name: target.globalName ?? target.username,
    image: target.displayAvatarURL(),
  })
  await db.update(users).set({ isSudo: true }).where(eq(users.id, userId))
  await interaction.reply({
    content: `✓ Granted sudo to <@${target.id}> (user \`${userId}\`).`,
    allowedMentions: { users: [target.id] },
    ephemeral: true,
  })
}

async function sudoRevoke(interaction: ChatInputCommandInteraction): Promise<void> {
  const target = interaction.options.getUser('user', true)
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.discordId, target.id))
    .limit(1)
  if (!row) {
    await interaction.reply({ content: `<@${target.id}> isn't in the user table.`, ephemeral: true })
    return
  }
  await db.update(users).set({ isSudo: false }).where(eq(users.id, row.id))
  await interaction.reply({
    content: `✓ Revoked sudo from <@${target.id}>.`,
    allowedMentions: { users: [target.id] },
    ephemeral: true,
  })
}

async function sudoList(interaction: ChatInputCommandInteraction): Promise<void> {
  const rows = await db
    .select({ id: users.id, name: users.name, discordId: users.discordId })
    .from(users)
    .where(eq(users.isSudo, true))
    .orderBy(desc(users.createdAt))
    .limit(25)

  const body =
    rows.length === 0
      ? '_No sudo users._'
      : rows.map((r) => `· <@${r.discordId}> (${r.name ?? '?'}) — \`${r.id.slice(0, 8)}\``).join('\n')

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Sudo users'),
    new TextDisplayBuilder().setContent(body),
  )
  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] },
  } as any)
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
const SNOWFLAKE_RE = /^\d{17,20}$/

async function businessCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const slug = interaction.options.getString('slug', true).trim().toLowerCase()
  const name = interaction.options.getString('name', true).trim()
  const guildId = interaction.options.getString('guild_id', true).trim()
  const kind = (interaction.options.getString('kind') ?? 'host') as 'host' | 'client'
  const parentHostSlug = interaction.options.getString('parent_host_slug')?.trim()

  if (!SLUG_RE.test(slug)) {
    await interaction.reply({
      content: 'Bad slug — lowercase letters / digits / hyphens; no leading or trailing hyphen.',
      ephemeral: true,
    })
    return
  }
  if (!SNOWFLAKE_RE.test(guildId)) {
    await interaction.reply({ content: 'Bad guild id — must be a 17–20 digit snowflake.', ephemeral: true })
    return
  }

  let parentBusinessId: string | null = null
  if (kind === 'client') {
    if (!parentHostSlug) {
      await interaction.reply({
        content: 'Client kind requires a parent_host_slug.',
        ephemeral: true,
      })
      return
    }
    const [parent] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(eq(businesses.slug, parentHostSlug), eq(businesses.kind, 'host')))
      .limit(1)
    if (!parent) {
      await interaction.reply({ content: `No host found with slug \`${parentHostSlug}\`.`, ephemeral: true })
      return
    }
    parentBusinessId = parent.id
  }

  try {
    await db.insert(businesses).values({
      slug,
      name,
      discordGuildId: guildId,
      kind,
      parentBusinessId,
    })
  } catch (err) {
    await interaction.reply({ content: `DB insert failed: ${String(err).slice(0, 200)}`, ephemeral: true })
    return
  }
  invalidateBusinessCache(guildId)
  await interaction.reply({
    content: `✓ Created **${kind}** business \`${slug}\` (${name}) tied to guild \`${guildId}\`.`,
    ephemeral: true,
  })
}

async function businessList(interaction: ChatInputCommandInteraction): Promise<void> {
  const rows = await db
    .select({
      id: businesses.id,
      slug: businesses.slug,
      name: businesses.name,
      kind: businesses.kind,
      guildId: businesses.discordGuildId,
    })
    .from(businesses)
    .orderBy(desc(businesses.createdAt))
    .limit(50)

  const hosts = rows.filter((r) => r.kind === 'host')
  const clients = rows.filter((r) => r.kind === 'client')

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Businesses'),
    new TextDisplayBuilder().setContent(
      `### Hosts (${hosts.length})\n` +
        (hosts.length
          ? hosts.map((h) => `· \`${h.slug}\` — ${h.name} · guild \`${h.guildId}\``).join('\n')
          : '_none_'),
    ),
    new TextDisplayBuilder().setContent(
      `### Clients (${clients.length})\n` +
        (clients.length
          ? clients.map((c) => `· \`${c.slug}\` — ${c.name} · guild \`${c.guildId}\``).join('\n')
          : '_none_'),
    ),
  )
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false))
  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
    allowedMentions: { parse: [] },
  } as any)
}

async function businessDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  const slug = interaction.options.getString('slug', true).trim().toLowerCase()
  const [row] = await db
    .select({ id: businesses.id, guildId: businesses.discordGuildId, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1)
  if (!row) {
    await interaction.reply({ content: `No business with slug \`${slug}\`.`, ephemeral: true })
    return
  }
  await db.delete(businesses).where(eq(businesses.id, row.id))
  invalidateBusinessCache(row.guildId)
  await interaction.reply({
    content: `✓ Deleted business \`${slug}\` (${row.name}). Cascade dropped its categories and tickets.`,
    ephemeral: true,
  })
}
