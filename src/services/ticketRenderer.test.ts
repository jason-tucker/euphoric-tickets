import { describe, expect, it } from 'vitest'
import { ButtonStyle, ComponentType } from 'discord.js'
import { buildCloseConfirm, buildPanelMessage, buildTicketWelcome, renderFirstMessage } from './ticketRenderer'

type ButtonJson = {
  type: number
  custom_id?: string
  label?: string
  style: number
  disabled?: boolean
  url?: string
}

function rowButtons(message: { components: unknown[] }): ButtonJson[] {
  const row = (message.components[1] as { toJSON: () => { components: ButtonJson[] } }).toJSON()
  return row.components
}

describe('renderFirstMessage', () => {
  it('substitutes every placeholder, including repeats', () => {
    const out = renderFirstMessage('Hi {{user}}! Ticket {{ticketId}} ({{category}}): {{subject}}. Thanks {{user}}.', {
      userId: '42',
      ticketId: 7,
      subject: 'Broken panel',
      category: 'Support',
    })
    expect(out).toBe('Hi <@42>! Ticket 7 (Support): Broken panel. Thanks <@42>.')
  })

  it('leaves templates without placeholders untouched', () => {
    expect(renderFirstMessage('plain text', { userId: '1', ticketId: 1, subject: '', category: '' })).toBe('plain text')
  })
})

describe('buildPanelMessage', () => {
  it('renders one tk:open button per category with the panel customId convention', () => {
    const msg = buildPanelMessage([
      { key: 'support', label: 'Support', emoji: '🎫' },
      { key: 'billing', label: 'Billing' },
    ])
    const buttons = rowButtons(msg)
    expect(buttons.map((b) => b.custom_id)).toEqual(['tk:open:support', 'tk:open:billing'])
    expect(buttons.every((b) => b.type === ComponentType.Button)).toBe(true)
  })

  it("caps at Discord's 5-buttons-per-row limit", () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, label: `L${i}` }))
    expect(rowButtons(buildPanelMessage(cats))).toHaveLength(5)
  })

  it("truncates labels to Discord's 80-char button limit", () => {
    const msg = buildPanelMessage([{ key: 'long', label: 'x'.repeat(100) }])
    expect(rowButtons(msg)[0]?.label).toHaveLength(80)
  })
})

describe('buildTicketWelcome', () => {
  const base = {
    ticketId: 12,
    openerId: '100000000000000001',
    categoryLabel: 'Support',
    staffRoleIds: [],
    claimerId: null,
  }

  it('unclaimed card has an enabled Claim button and the tk: customIds', () => {
    const buttons = rowButtons(buildTicketWelcome(base))
    expect(buttons.map((b) => b.custom_id)).toEqual(['tk:claim:12', 'tk:close:12', 'tk:changecat:12'])
    expect(buttons[0]).toMatchObject({ label: 'Claim', style: ButtonStyle.Success })
    expect(buttons[0]?.disabled).not.toBe(true)
  })

  it('claimed card disables the Claim button and relabels it', () => {
    const buttons = rowButtons(buildTicketWelcome({ ...base, claimerId: '200000000000000002' }))
    expect(buttons[0]).toMatchObject({ label: 'Claimed', style: ButtonStyle.Secondary, disabled: true })
  })

  it('adds an "Open in web" link button only when a webUrl is given', () => {
    expect(rowButtons(buildTicketWelcome(base))).toHaveLength(3)
    const withWeb = rowButtons(buildTicketWelcome({ ...base, webUrl: 'https://tickets.example/b/t/12' }))
    expect(withWeb).toHaveLength(4)
    expect(withWeb[3]).toMatchObject({ style: ButtonStyle.Link, url: 'https://tickets.example/b/t/12' })
  })
})

describe('buildCloseConfirm', () => {
  it('confirm/cancel buttons carry the close_confirm/close_cancel customIds', () => {
    const buttons = rowButtons(buildCloseConfirm(33))
    expect(buttons.map((b) => b.custom_id)).toEqual(['tk:close_confirm:33', 'tk:close_cancel:33'])
    expect(buttons[0]?.style).toBe(ButtonStyle.Danger)
  })
})
