// apps/desktop/electron/services/overlay-service.ts
//
// Region-capture overlay service. Registers a global shortcut
// (Cmd/Ctrl+Shift+Space) that opens a frameless full-screen "marquee" window
// over the primary display. The renderer draws a selection rectangle; on
// mouseup it invokes IPC 'overlay:capture-region', which screenshots the
// primary display via desktopCapturer, crops the region, and pushes the
// resulting PNG data URL back to the main window via 'overlay:capture-done'.
//
// All state is module-local — only one overlay window can exist at a time.

import {
  BrowserWindow,
  ipcMain,
  screen,
  desktopCapturer,
  nativeImage,
} from 'electron'
import { join } from 'path'
import { z } from 'zod'

let overlayWindow: BrowserWindow | null = null
let mainWindowRef:  BrowserWindow | null = null

const RegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
})

function closeOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
  }
  overlayWindow = null
}

function openOverlay(): void {
  // Bail out if one is already open — second shortcut press becomes a cancel.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    closeOverlay()
    return
  }

  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  // Float above everything (incl. fullscreen apps on macOS) while active.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env.ELECTRON_RENDERER_URL) {
    overlayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#overlay`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }

  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show()
      overlayWindow.focus()
    }
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

/**
 * Returns the primary display's screen source ID — the renderer uses it with
 * `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`
 * which is the only reliable Windows capture path (desktopCapturer.thumbnail
 * returns all-black on Hi-DPI + composited overlays).
 */
async function getPrimarySourceId(): Promise<string> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },  // we only need the ID, not the thumbnail
  })
  if (sources.length === 0) throw new Error('No screen sources available')
  const primaryId = String(display.id)
  const source =
    sources.find(s => (s as unknown as { display_id?: string }).display_id === primaryId)
    ?? sources[0]
  return source.id
}

/**
 * Legacy thumbnail-based capture (fallback). Kept around for non-Windows
 * platforms where it still works fine.
 */
export async function captureRegion(
  rect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const display     = screen.getPrimaryDisplay()
  const { width: dispW, height: dispH } = display.size
  const scaleFactor = display.scaleFactor || 1
  const pxW = Math.round(dispW * scaleFactor)
  const pxH = Math.round(dispH * scaleFactor)

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.hide() } catch { /* non-fatal */ }
    // Longer wait — DWM compositor on Windows needs ~200-300ms to repaint.
    await new Promise<void>(resolve => setTimeout(resolve, 250))
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: pxW, height: pxH },
  })
  if (sources.length === 0) throw new Error('No screen sources available')

  const primaryId = String(display.id)
  const source =
    sources.find(s => (s as unknown as { display_id?: string }).display_id === primaryId)
    ?? sources[0]

  const image = source.thumbnail
  const imgSize  = image.getSize()
  const imgW     = imgSize.width
  const imgH     = imgSize.height
  if (image.isEmpty() || imgW === 0 || imgH === 0) {
    throw new Error('THUMBNAIL_BLACK')  // signal renderer to fall back to getUserMedia path
  }
  const sx = imgW / dispW
  const sy = imgH / dispH

  const cx = Math.max(0, Math.min(Math.round(rect.x * sx), imgW - 1))
  const cy = Math.max(0, Math.min(Math.round(rect.y * sy), imgH - 1))
  const cw = Math.max(1, Math.min(Math.round(rect.w * sx), imgW - cx))
  const ch = Math.max(1, Math.min(Math.round(rect.h * sy), imgH - cy))

  const cropped = image.crop({ x: cx, y: cy, width: cw, height: ch })
  if (cropped.isEmpty()) throw new Error('THUMBNAIL_BLACK')
  return cropped.toDataURL()
}

function registerOverlayIpc(): void {
  ipcMain.handle('overlay:capture-region', async (_event, payload: unknown) => {
    const rect = RegionSchema.parse(payload)
    const dataUrl = await captureRegion(rect)
    closeOverlay()
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.focus()
      mainWindowRef.webContents.send('overlay:capture-done', { dataUrl })
    }
    return { dataUrl }
  })

  // Renderer-side capture: returns the primary-display source ID so the
  // overlay renderer can call navigator.mediaDevices.getUserMedia with
  // chromeMediaSource='desktop', chromeMediaSourceId=<id>. This avoids the
  // black-thumbnail bug entirely.
  ipcMain.handle('overlay:get-source-id', async () => {
    // Hide overlay first + wait for compositor.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try { overlayWindow.hide() } catch { /* non-fatal */ }
      await new Promise<void>(r => setTimeout(r, 250))
    }
    const sourceId = await getPrimarySourceId()
    const display  = screen.getPrimaryDisplay()
    return {
      sourceId,
      displaySize: display.size,
      scaleFactor: display.scaleFactor || 1,
    }
  })

  // Renderer reports the final cropped data URL — we fan it out to the main window.
  ipcMain.handle('overlay:capture-done', (_event, payload: unknown) => {
    const { dataUrl } = z.object({ dataUrl: z.string().min(10) }).parse(payload)
    closeOverlay()
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.focus()
      mainWindowRef.webContents.send('overlay:capture-done', { dataUrl })
    }
  })

  ipcMain.handle('overlay:cancel', () => {
    closeOverlay()
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.focus()
    }
  })
}

/**
 * Wire up overlay IPC handlers and subscribe to the centralised
 * 'hotkey:fired' event from hotkey-manager. The actual globalShortcut
 * registration is now owned by hotkey-manager (overlay-capture action).
 *
 * Call from main.ts after the main window is created.
 */
export function registerOverlayShortcut(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  registerOverlayIpc()

  // Listen for the 'overlay-capture' hotkey fired by hotkey-manager.
  ipcMain.on('hotkey:fired-internal', (_event, payload: { id: string }) => {
    if (payload.id === 'overlay-capture') {
      openOverlay()
    }
  })
}
