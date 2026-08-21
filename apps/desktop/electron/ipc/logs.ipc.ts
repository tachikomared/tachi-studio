import { BrowserWindow } from 'electron'
import { initLogService } from '../services/log-service'

export function registerLogsIpc(win: BrowserWindow) {
  initLogService(win)
}
