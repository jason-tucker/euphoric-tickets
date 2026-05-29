import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Client,
} from 'discord.js'
import { env } from '../../config/env'
import { log } from '../../services/logger'

const SUPPRESS_NOTIFICATIONS = 1 << 12

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}

export function registerReadyEvent(client: Client): void {
  client.once('clientReady', async (c) => {
    log.info(`Logged in as ${c.user.tag}`)

    if (env.BOT_OWNER_ID) {
      const owner = await c.users.fetch(env.BOT_OWNER_ID).catch(() => null)
      if (owner) {
        let version = '?'
        try {
          const pkg = await import('../../../package.json' as any)
          version = (pkg as any).version ?? '?'
        } catch {}
        const sha = (process.env.GIT_SHA ?? process.env.SOURCE_COMMIT ?? '').slice(0, 7) || 'unset'
        const nowSec = Math.floor(Date.now() / 1000)

        const guildLines = [...c.guilds.cache.values()]
          .map((g) => `• ${g.name} (\`${g.id}\`)`)
          .join('\n') || '_(not a member of any guild)_'

        const container = new ContainerBuilder()
          .setAccentColor(0xa855f7)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎫 Euphoric Tickets is up'))
          .addSeparatorComponents(sep())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**${c.user.tag}** · booted <t:${nowSec}:R>\n` +
            `**Version** \`${version}\` · **Build** \`${sha}\``
          ))
          .addSeparatorComponents(sep())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `### 🏠 Guilds\n${guildLines}`
          ))
          .addSeparatorComponents(sep())
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '_Sudo: `/panel post` to drop a panel · `/tickets settings` to configure._'
          ))

        await owner.send({
          flags: (MessageFlags.IsComponentsV2 as number) | SUPPRESS_NOTIFICATIONS,
          components: [container],
        } as any).catch(() => {})
      }
    }
  })
}
