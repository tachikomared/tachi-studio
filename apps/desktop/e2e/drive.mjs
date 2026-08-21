// apps/desktop/e2e/drive.mjs
//
// Playwright _electron driver: launches the BUILT app (out/) as a real Electron
// window and drives the renderer — screenshots each tab, captures renderer
// console + main stdout. Run: `node e2e/drive.mjs` from apps/desktop (build
// first: `pnpm build`). Screenshots land in e2e/shots/.
//
// Read-only tour by default — it never sends a transaction. Set DRIVE_CHAT=1 to
// also send one cheap "2+2" chat (spends a trivial amount of the active key) to
// prove smart routing end-to-end via the [smart-router] stdout line.

import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const appDir = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]e2e$/, '')
const shots = join(appDir, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const log = (...a) => console.log('[drive]', ...a)
const consoleErrors = []
const routerLines = []

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: appDir,
})

// Capture main-process stdout (smart-router logs live here).
app.process().stdout?.on('data', (d) => {
  const s = d.toString()
  if (/\[smart-router\]|\[surplus-router\]/.test(s)) routerLines.push(s.trim())
})

const win = await app.firstWindow()
win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500) // let the renderer settle
log('title:', await win.title())
await win.screenshot({ path: join(shots, '00-boot.png') })

// Tour the sidebar tabs by visible text; screenshot each. Best-effort — a
// missing tab is logged, not fatal.
const tabs = ['CHAT', 'NODES', 'CATALOG', 'MEDIA', 'AEON']
for (const tab of tabs) {
  try {
    const loc = win.locator(`text=${tab}`).first()
    await loc.click({ timeout: 4000 })
    await win.waitForTimeout(1500)
    await win.screenshot({ path: join(shots, `tab-${tab.toLowerCase()}.png`) })
    log('screenshot tab:', tab)
  } catch (e) {
    log('tab skipped:', tab, '-', e.message.split('\n')[0])
  }
}

// Settings (gear / Customize entry).
for (const entry of ['Customize', 'Settings', 'settings']) {
  try {
    await win.locator(`text=${entry}`).first().click({ timeout: 3000 })
    await win.waitForTimeout(1500)
    await win.screenshot({ path: join(shots, 'settings.png') })
    log('screenshot: settings via', entry)
    break
  } catch { /* try next */ }
}

// Optional: prove smart routing end-to-end through the UI (spends a tiny amount).
if (process.env.DRIVE_CHAT === '1') {
  try {
    await win.locator('text=CHAT').first().click({ timeout: 4000 })
    await win.waitForTimeout(1000)
    const box = win.locator('textarea, [contenteditable="true"]').first()
    await box.click({ timeout: 4000 })
    await box.fill('2 + 2?')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(6000)
    await win.screenshot({ path: join(shots, 'chat-2plus2.png') })
    log('sent test chat')
  } catch (e) {
    log('chat drive failed:', e.message.split('\n')[0])
  }
}

await app.close()

console.log('\n=== DRIVE SUMMARY ===')
console.log('renderer console errors:', consoleErrors.length)
consoleErrors.slice(0, 15).forEach((e) => console.log('  ERR', e))
console.log('smart-router log lines:', routerLines.length)
routerLines.forEach((l) => console.log('  ', l))
console.log('screenshots in:', shots)
