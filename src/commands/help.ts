import {
  ChatInputCommandInteraction,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { env } from '../config/env'
import { db } from '../db/client'
import { ticketCategories } from '../db/schema/ticketCategories'
import { getBusinessByGuildId } from '../services/businessResolver'
import { isAdminForBusiness, isStaffForCategory } from '../services/permissions'
import { isSudoUser } from '../services/sudoService'

const ACCENT = 0xa855f7

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('How Euphoric Tickets works + the commands available to you')
  .setDMPermission(false)

// `/help` — context-aware. Resolves the caller's tier in this server and shows
// the relevant commands + a short "how it works" + a link to the full web docs.
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Run `/help` inside a server.', ephemeral: true })
    return
  }

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const business = await getBusinessByGuildId(interaction.guild.id)

  const sudo = isSudoUser(member)
  const admin = !!business && isAdminForBusiness(member, business)
  // "staff anywhere" — true if the member holds a staff role on ANY of this
  // team's categories.
  let staff = admin
  if (!staff && business) {
    const cats = await db
      .select({ staffRoleIds: ticketCategories.staffRoleIds })
      .from(ticketCategories)
      .where(eq(ticketCategories.businessId, business.id))
    staff = cats.some((c) => isStaffForCategory(member, business, c))
  }

  const tier = sudo ? 'Sudo' : admin ? 'Admin' : staff ? 'Staff' : 'Member'

  const webUrl = env.WEB_BASE_URL
  const helpUrl = `${webUrl}/help`

  // ---- How it works -------------------------------------------------------
  const intro = [
    '## 🎫 Euphoric Tickets — Help',
    `You are **${tier}** in this server.` +
      (business ? '' : '\n_(This server isn’t set up as a team yet — ask an admin.)_'),
    '',
    '**How it works.** Open a ticket from the panel button (or on the web). The bot makes you a private channel with staff. ' +
      'Talk here in Discord **or** on the web — messages sync both ways, live. Closing a ticket saves a transcript and DMs it to you.',
  ].join('\n')

  // ---- Everyone -----------------------------------------------------------
  const everyone = [
    '### Everyone',
    '• **Open a ticket** — click a button on the ticket panel, or use the web.',
    '• **Reply** — just type in your ticket channel. Staff see it instantly.',
    `• **Close** — press **Close** on the welcome card, or \`/tickets close\`.`,
    '• **Web** — view all your tickets, get notifications, and reply from anywhere: ' + webUrl,
  ].join('\n')

  const blocks: TextDisplayBuilder[] = [
    new TextDisplayBuilder().setContent(intro),
    new TextDisplayBuilder().setContent(everyone),
  ]

  // ---- Staff --------------------------------------------------------------
  if (staff) {
    blocks.push(
      new TextDisplayBuilder().setContent(
        [
          '### Staff',
          '• `/tickets claim` / `/tickets unclaim` — take or release a ticket.',
          '• `/tickets assign <user>` — assign it to a teammate.',
          '• `/tickets add <user>` / `/tickets remove <user>` — manage who’s in the channel.',
          '• `/tickets rename <name>` — rename the channel (keeps the ticket number).',
          '• `/tickets list` — every open ticket in this server.',
          '• `/tickets close` — close + transcript.',
          '• Add **internal notes** (staff-only) from the web ticket page.',
        ].join('\n'),
      ),
    )
  }

  // ---- Admin --------------------------------------------------------------
  if (admin) {
    blocks.push(
      new TextDisplayBuilder().setContent(
        [
          '### Admin',
          '• `/tickets category <key>` — move a ticket to another category (also the 🗂️ button).',
          '• `/tickets convert [category] [subject] [opener]` — turn the current channel into a ticket + import its recent history.',
          '• `/tickets delete` — permanently delete a **closed** ticket’s channel.',
          '• **Settings** — categories, allow-to-open roles, staff roles, custom first-message templates, and Discord category mappings live on the web: ' +
            `${webUrl}`,
        ].join('\n'),
      ),
    )
  }

  // ---- Sudo ---------------------------------------------------------------
  if (sudo) {
    blocks.push(
      new TextDisplayBuilder().setContent(
        [
          '### Sudo',
          '• `/panel post` / `/panel refresh` — post or re-render the ticket panel.',
          '• `/tickets settings` — quick in-Discord config.',
          '• `/admin sudo grant|revoke|list` — manage sudo users.',
          '• `/admin business create|list|delete` — manage teams from Discord.',
          `• Web admin: \`/admin\` (teams), \`/admin/bot\` (health), \`/admin/errors\` (logs) at ${webUrl}.`,
        ].join('\n'),
      ),
    )
  }

  blocks.push(
    new TextDisplayBuilder().setContent(
      `📖 **Full guide with screenshots & step-by-steps:** ${helpUrl}`,
    ),
  )

  // Assemble the container with separators between sections.
  const container = new ContainerBuilder().setAccentColor(ACCENT)
  blocks.forEach((b, i) => {
    if (i > 0) container.addSeparatorComponents(sep())
    container.addTextDisplayComponents(b)
  })

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    ephemeral: true,
    allowedMentions: { parse: [] },
  } as never)
}
