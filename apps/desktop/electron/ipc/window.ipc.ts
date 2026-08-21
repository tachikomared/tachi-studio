// apps/desktop/electron/ipc/window.ipc.ts
//
// Custom window controls. We render our own minimize / maximize / close
// buttons in the renderer (brutalist style) so we can ditch the Windows
// titleBarOverlay which (a) doesn't match the app's visual language and
// (b) overlaps page content because the overlay floats on top of the
// renderer surface rather than reserving space below it.

import { ipcMain, BrowserWindow } from 'electron'
import type { BrowserWindow as BW } from 'electron'

export function registerWindowIpc(win: BW, transparent = false): void {
  ipcMain.handle('window:minimize', () => {
    if (!win.isDestroyed()) win.minimize()
  })

  ipcMain.handle('window:maximize-toggle', () => {
    if (win.isDestroyed()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle('window:close', () => {
    if (!win.isDestroyed()) win.close()
  })

  // `transparent` reflects how the window was constructed (see the CRAB
  // overflow flag in main.ts). It never changes at runtime, so it rides on
  // the seed read only; the push channel below carries just `maximized`.
  ipcMain.handle('window:get-state', () => {
    if (win.isDestroyed()) return { maximized: false, transparent }
    return { maximized: win.isMaximized(), transparent }
  })

  // Push state changes so the renderer can swap the maximize/restore icon.
  const broadcast = (maximized: boolean) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
        w.webContents.send('window:state-changed', { maximized })
      }
    }
  }
  win.on('maximize',   () => broadcast(true))
  win.on('unmaximize', () => broadcast(false))
}
