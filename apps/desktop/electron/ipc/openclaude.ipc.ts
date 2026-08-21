import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { installOpenClaude, isOpenClaudeInstalled } from '../services/openclaude-installer'
import { startOpenClaude, stopOpenClaude } from '../services/sidecar-manager'

export function registerOpenClaudeIpc(win: BrowserWindow): void {
  ipcMain.handle('openclaude:check-installed', () => ({
    installed: isOpenClaudeInstalled(),
  }))

  // installOpenClaude() emits the { step: 'error' } progress event itself, so
  // every caller (this handler AND the agent first-run path) reports failures
  // identically — see the catch in openclaude-installer.ts.
  ipcMain.handle('openclaude:install', async () => {
    await installOpenClaude(win)
  })

  ipcMain.handle('openclaude:start', async () => {
    await startOpenClaude()
  })

  ipcMain.handle('openclaude:stop', () => {
    stopOpenClaude()
  })
}
