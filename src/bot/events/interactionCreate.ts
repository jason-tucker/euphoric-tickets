import type { Client, Interaction } from 'discord.js'
import { execute as executePanel, data as panelData } from '../../commands/panel'
import { execute as executeTickets, executeCloseConfirm, data as ticketsData } from '../../commands/tickets'
import { execute as executeAdmin, data as adminData } from '../../commands/admin'
import { handleTicketOpen } from '../../interactions/buttons/ticketOpen'
import { handleTicketClaim } from '../../interactions/buttons/ticketClaim'
import {
  handleTicketClose,
  handleTicketCloseCancel,
  handleTicketCloseConfirm,
} from '../../interactions/buttons/ticketClose'
import { handleSettingsButton } from '../../interactions/buttons/settingsButton'
import { handleSettingsModalSubmit } from '../../interactions/modals/settingsModal'
import { log } from '../../services/logger'

export function registerInteractionCreate(client: Client): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === panelData.name) return await executePanel(interaction)
        if (interaction.commandName === ticketsData.name) return await executeTickets(interaction)
        if (interaction.commandName === adminData.name) return await executeAdmin(interaction)
        return
      }

      if (interaction.isButton()) {
        const id = interaction.customId
        if (id.startsWith('tk:open:')) return await handleTicketOpen(interaction)
        if (id.startsWith('tk:claim:')) return await handleTicketClaim(interaction)
        if (id.startsWith('tk:close_confirm:')) {
          const ticketId = Number(id.slice('tk:close_confirm:'.length))
          return await executeCloseConfirm({ interaction, ticketId })
        }
        if (id.startsWith('tk:close_cancel:')) return await handleTicketCloseCancel(interaction)
        if (id.startsWith('tk:close:')) return await handleTicketClose(interaction)
        if (id.startsWith('tk:settings:')) return await handleSettingsButton(interaction)
        return
      }

      if (interaction.isModalSubmit()) {
        const id = interaction.customId
        if (id.startsWith('tk:settings_modal:')) return await handleSettingsModalSubmit(interaction)
        return
      }
    } catch (err) {
      log.error('Interaction handler threw', { err: String(err), customId: 'customId' in interaction ? interaction.customId : undefined })
      try {
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: 'Something went wrong.', ephemeral: true })
          } else {
            await interaction.reply({ content: 'Something went wrong.', ephemeral: true })
          }
        }
      } catch {}
    }
  })
}
