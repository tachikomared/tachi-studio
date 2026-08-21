import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from '../services/terminal-service'

export function registerTerminalIpc(win: BrowserWindow) {
  ipcMain.handle('terminal:create', (_e, p: unknown) => {
    const { id } = z.object({ id: z.string() }).parse(p)
    createTerminal(win, id)
  })
  ipcMain.handle('terminal:write', (_e, p: unknown) => {
    const { id, data } = z.object({ id: z.string(), data: z.string() }).parse(p)
    writeTerminal(id, data)
  })
  ipcMain.handle('terminal:resize', (_e, p: unknown) => {
    const { id, cols, rows } = z.object({ id: z.string(), cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).parse(p)
    resizeTerminal(id, cols, rows)
  })
  ipcMain.handle('terminal:kill', (_e, p: unknown) => {
    const { id } = z.object({ id: z.string() }).parse(p)
    killTerminal(id)
  })
}
