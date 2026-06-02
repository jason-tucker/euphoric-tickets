import 'dotenv/config'
import { env } from './config/env'
import { client } from './bot/client'
import { registerReadyEvent } from './bot/events/ready'
import { registerInteractionCreate } from './bot/events/interactionCreate'
import { registerMessageCreate } from './bot/events/messageCreate'
import { registerChannelCreate } from './bot/events/channelCreate'
import { registerChannelDelete } from './bot/events/channelDelete'
import { registerThreadCreate } from './bot/events/threadCreate'
import { startHealthPush, stopHealthPush } from './bot/healthPush'
import { startScheduledCleanup, stopScheduledCleanup } from './bot/scheduledCleanup'
import { startInternalHttp } from './bot/internalHttp'
import { ensureLeadership, releaseLeadership } from './bot/leader'
import { closeDb } from './db/client'
import { log } from './services/logger'

registerReadyEvent(client)
registerInteractionCreate(client)
registerMessageCreate(client)
registerChannelCreate(client)
registerChannelDelete(client)
registerThreadCreate(client)

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) })
})

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { err: String(err) })
})

let shuttingDown = false
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`Received ${signal} — shutting down`)
  stopHealthPush()
  stopScheduledCleanup()
  try { await client.destroy() } catch (err) { log.warn('client.destroy failed', { err: String(err) }) }
  try { await releaseLeadership() } catch (err) { log.warn('releaseLeadership failed', { err: String(err) }) }
  try { await closeDb() } catch (err) { log.warn('closeDb failed', { err: String(err) }) }
  const code = signal === 'SIGTERM' ? 143 : 0
  setTimeout(() => process.exit(code), 2_000).unref()
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT') })

// P18: become the single leader before connecting to the Discord gateway.
// On a single-VPS deploy this returns immediately; on multi-VPS, followers
// block here until the current leader's process dies.
ensureLeadership()
  .then(() => client.login(env.DISCORD_BOT_TOKEN))
  .then(() => {
    startHealthPush()
    startScheduledCleanup(client)
    startInternalHttp(client)
  })
  .catch((err) => {
    log.error('client.login failed', { err: String(err) })
  })
