// apps/desktop/electron/services/tray-service.ts
//
// System tray icon and menu. Creates the tray icon on app.whenReady and
// keeps a reference to the main window for show/hide toggling.

import { Tray, Menu, app, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

function getIconPath(): string {
  // In production the build/ directory is bundled as extraResources or sits
  // beside the app. During dev (electron-vite) process.resourcesPath still
  // points to the Electron resources dir, but the project root is accessible
  // via __dirname navigation. We keep it simple: one .ico on Windows, .png elsewhere.
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '../../..')

  if (process.platform === 'win32') {
    // Build directory has icon.ico when the builder runs; fall back to .png.
    const icoPath = join(resourcesDir, 'build', 'icon.ico')
    const pngPath = join(resourcesDir, 'build', 'icon.png')
    // require('fs') is available in the main process.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { existsSync } = require('fs') as typeof import('fs')
      if (existsSync(icoPath)) return icoPath
    } catch { /* ignore */ }
    return pngPath
  }
  return join(resourcesDir, 'build', 'icon.png')
}

export function createTray(win: BrowserWindow): void {
  if (tray) return

  let icon
  try {
    icon = nativeImage.createFromPath(getIconPath())
    // Resize for tray — system tray icons should be 16x16 (Win) or 22x22 (Linux/macOS)
    if (!icon.isEmpty()) {
      const size = process.platform === 'darwin' ? 22 : 16
      icon = icon.resize({ width: size, height: size })
    }
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Tachi Studio')

  const buildMenu = () =>
    Menu.buildFromTemplate([
      {
        label: 'Show Tachi Studio',
        click: () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
          }
        },
      },
      { type: 'separator' },
      {
        label: 'New Chat',
        click: () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
            win.webContents.send('tray:new-chat')
          }
        },
      },
      {
        label: 'Open Agent',
        click: () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
            win.webContents.send('tray:open-agent')
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ])

  tray.setContextMenu(buildMenu())

  // Left-click (single click) toggles show/hide on Windows/Linux.
  // macOS uses right-click / context menu by default; single-click also handled.
  tray.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isVisible()) {
      win.hide()
    } else {
      win.show()
      win.focus()
    }
  })
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
