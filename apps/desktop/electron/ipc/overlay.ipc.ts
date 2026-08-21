// apps/desktop/electron/ipc/overlay.ipc.ts
//
// Re-export the overlay IPC + global-shortcut wiring from overlay-service.
// The actual handler implementations live in services/overlay-service.ts
// because they need access to the overlay BrowserWindow lifecycle. This
// file exists so the IPC layer surface follows the same convention as
// other ipc/*.ts modules.

import type { BrowserWindow } from 'electron'
import { registerOverlayShortcut as register } from '../services/overlay-service'

export function registerOverlayIpc(mainWindow: BrowserWindow): void {
  register(mainWindow)
}
