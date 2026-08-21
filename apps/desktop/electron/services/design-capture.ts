// apps/desktop/electron/services/design-capture.ts
//
// Design tab → Export PNG / PDF of a generated page. FREE — the app is already
// Chromium, so we render the (self-contained) design HTML in a hidden, isolated
// BrowserWindow and use capturePage() / printToPDF(); no managed Chromium needed.
//
// The window is sandboxed + nodeIntegration-off (the HTML is model-generated /
// untrusted), loaded from a throwaway temp file. For PNG we force any unfired
// scroll-reveal content visible and size the window to the full document height so
// the capture is the WHOLE page, not just the fold. For PDF we emit ONE page sized
// to the content (no awkward A4 pagination of a landing page).

import { app, BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const MAX_PX = 16_384 // GPU/texture safety cap on the captured height

async function renderInWindow<T>(html: string, width: number, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(app.getPath('temp'), 'tachi-capture-'))
  const file = join(dir, 'page.html')
  writeFileSync(file, html, 'utf8')
  // paintWhenInitiallyHidden (default true) lets capturePage work without ever showing.
  const win = new BrowserWindow({
    width, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  try {
    await win.loadFile(file)
    // Give fonts a bounded chance to load for fidelity, but NEVER hang on a slow
    // CDN: race document.fonts.ready against a timeout, then stop any still-pending
    // loads so a stuck font/image request can't stall capturePage()/CDP capture.
    await win.webContents.executeJavaScript(
      `Promise.race([document.fonts.ready.then(()=>1), new Promise(r=>setTimeout(()=>r(0),4000))])`,
    ).catch(() => {})
    try { win.webContents.stop() } catch { /* */ }
    await new Promise(r => setTimeout(r, 200))
    return await fn(win)
  } finally {
    try { if (!win.isDestroyed()) win.destroy() } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  }
}

// Reveal-proofing for capture: scroll-reveal sections (opacity:0 until an
// IntersectionObserver fires) never reveal in a headless one-shot. So we scroll the
// whole page (firing observers → reveals animate to their final state), then inject an
// opacity/visibility safety net for anything still hidden, and return the full height.
// Async IIFE — Electron's executeJavaScript awaits the returned promise.
const FORCE_VISIBLE_JS = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const step = Math.max(200, Math.round(window.innerHeight * 0.8))
  for (let y = 0; y <= document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await sleep(60) }
  window.scrollTo(0, document.documentElement.scrollHeight); await sleep(150)
  window.scrollTo(0, 0); await sleep(60)
  const s = document.createElement('style')
  s.textContent = '*,*::before,*::after{opacity:1 !important;visibility:visible !important;}'
  document.head.appendChild(s)
  await sleep(150)
  return document.documentElement.scrollHeight
})()`

/**
 * Render the design HTML to a full-page PNG buffer. Uses the CDP
 * Page.captureScreenshot with captureBeyondViewport — webContents.capturePage()
 * only paints the on-screen portion, so a page taller than the physical display
 * comes out black below the fold. CDP captures the entire content height instead.
 */
export async function captureDesignPng(html: string, opts: { width?: number; scale?: number } = {}): Promise<Buffer> {
  const width = opts.width ?? 1280
  const scale = opts.scale ?? 1
  return renderInWindow(html, width, async (win) => {
    const h = Number(await win.webContents.executeJavaScript(FORCE_VISIBLE_JS)) || 900
    const height = Math.max(1, Math.min(Math.ceil(h), MAX_PX))
    const dbg = win.webContents.debugger
    let attached = false
    try {
      dbg.attach('1.3'); attached = true
      const result = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale },
      }) as { data: string }
      return Buffer.from(result.data, 'base64')
    } finally {
      if (attached) { try { dbg.detach() } catch { /* */ } }
    }
  })
}

/** Render the design HTML to a single-page PDF buffer sized to its content. */
export async function captureDesignPdf(html: string, opts: { width?: number } = {}): Promise<Buffer> {
  const width = opts.width ?? 1280
  return renderInWindow(html, width, async (win) => {
    const h = Number(await win.webContents.executeJavaScript(FORCE_VISIBLE_JS)) || 900
    const px2microns = (px: number) => Math.round((px / 96) * 25_400) // 96 CSS dpi → microns
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: { width: px2microns(width), height: px2microns(Math.max(1, Math.min(Math.ceil(h), MAX_PX))) },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  })
}
