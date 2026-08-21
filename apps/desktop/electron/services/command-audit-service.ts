import { BrowserWindow } from 'electron'
import { AgentCommandEvent } from '@tachi/core'
import { randomUUID } from 'crypto'

let winRef: BrowserWindow | null = null

export function initCommandAudit(win: BrowserWindow) { winRef = win }

export function emitCommandEvent(partial: Omit<AgentCommandEvent, 'id'> & { id?: string }) {
  const event: AgentCommandEvent = { ...partial, id: partial.id ?? randomUUID() }
  if (winRef && !winRef.isDestroyed()) winRef.webContents.send('commands:event', event)
  return event
}
