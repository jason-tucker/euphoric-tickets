import 'dotenv/config'
import { env } from './config/env'
import { client } from './bot/client'
import { registerReadyEvent } from './bot/events/ready'
import { registerInteractionCreate } from './bot/events/interactionCreate'
import { startHealthPush, stopHealthPush } from './bot/healthPush'
import { closeDb } from './db/client'
import { log } from './services/logger'

registerReadyEvent(client)
registerInteractionCreate(client)

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
  try { await client.destroy() } catch (err) { log.warn('client.destroy failed', { err: String(err) }) }
  try { await closeDb() } catch (err) { log.warn('closeDb failed', { err: String(err) }) }
  const code = signal === 'SIGTERM' ? 143 : 0
  setTimeout(() => process.exit(code), 2_000).unref()
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT') })

client
  .login(env.DISCORD_BOT_TOKEN)
  .then(() => {
    startHealthPush()
  })
  .catch((err) => {
    log.error('client.login failed', { err: String(err) })
  })
