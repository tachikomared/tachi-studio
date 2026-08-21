import { BrowserWindow } from 'electron'
import { initCommandAudit } from '../services/command-audit-service'

export function registerCommandsIpc(win: BrowserWindow) {
  initCommandAudit(win)
}
