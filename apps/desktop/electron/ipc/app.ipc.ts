import { ipcMain, app, dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { join, isAbsolute } from 'path'
import { rmSync, existsSync, writeFileSync, mkdirSync, statfsSync } from 'fs'
import { loadSettings, saveSettings } from '../services/settings-store'
import { resolveAppRepoPath, looksLikeAppRepo } from '../services/app-repo'
import { getStorageRoot, defaultStorageRoot, invalidateStorageRootCache, ensureStorageRoot } from '../services/storage-root'
import { recordPreviousModelRoot, invalidateUsageCache, invalidateModelTargetProbe } from '../services/model-storage'
import { deleteAllKeys } from '../services/keychain'
import { DEFAULT_SETTINGS } from '@tachi/core'
import { cpus, totalmem, freemem, platform, arch, release, hostname, networkInterfaces } from 'os'

export interface SystemInfo {
  platform:        string
  arch:            string
  osRelease:       string
  hostname:        string
  cpuModel:        string
  cpuCount:        number
  totalMemMB:      number
  freeMemMB:       number
  appMemMB:        number
  appUptimeSec:    number
  nodeVersion:     string
  chromeVersion:   string
  electronVersion: string
  appVersion:      string
  userDataPath:    string
  diskFreeGB:      number | null
  diskTotalGB:     number | null
  ipv4:            string | null
}

function getSystemInfo(): SystemInfo {
  const proc = process as unknown as { versions: Record<string, string> }
  const cpuList = cpus()
  const mem = process.memoryUsage()
  const userData = app.getPath('userData')

  let diskFreeGB:  number | null = null
  let diskTotalGB: number | null = null
  try {
    const s = statfsSync(userData) as unknown as { bsize: number; bavail: number; blocks: number }
    diskFreeGB  = +(s.bsize * s.bavail / 1024 / 1024 / 1024).toFixed(1)
    diskTotalGB = +(s.bsize * s.blocks / 1024 / 1024 / 1024).toFixed(1)
  } catch { /* statfsSync may be unavailable on older Node */ }

  let ipv4: string | null = null
  try {
    const ifaces = networkInterfaces()
    for (const list of Object.values(ifaces)) {
      if (!list) continue
      for (const i of list) {
        if (i.family === 'IPv4' && !i.internal) { ipv4 = i.address; break }
      }
      if (ipv4) break
    }
  } catch { /* best effort */ }

  return {
    platform:        platform(),
    arch:            arch(),
    osRelease:       release(),
    hostname:        hostname(),
    cpuModel:        cpuList[0]?.model.trim() ?? 'unknown',
    cpuCount:        cpuList.length,
    totalMemMB:      Math.round(totalmem() / 1024 / 1024),
    freeMemMB:       Math.round(freemem()  / 1024 / 1024),
    appMemMB:        Math.round(mem.rss    / 1024 / 1024),
    appUptimeSec:    Math.round(process.uptime()),
    nodeVersion:     proc.versions.node     ?? '?',
    chromeVersion:   proc.versions.chrome   ?? '?',
    electronVersion: proc.versions.electron ?? '?',
    appVersion:      app.getVersion(),
    userDataPath:    userData,
    diskFreeGB,
    diskTotalGB,
    ipv4,
  }
}

/**
 * Everything that must happen the moment `settings.storageRoot` changes.
 *
 * ORDER IS LOAD-BEARING: the storage-root cache is dropped FIRST so
 * `getStorageRoot()` already reports the NEW root, and only then is the old one
 * recorded — otherwise `recordPreviousModelRoot` would compare the old root
 * against itself and discard it.
 *
 * Why the history matters: model weights are found by convention
 * (`<root>/Models/<engine>/<id>`) and no record anywhere stores where a given
 * weight lives. Without remembering the previous root, changing this setting
 * makes every already-relocated weight read as "not installed" while still
 * occupying the disk — a 7.7 GB GGUF silently becomes an orphan the UI cannot
 * even show you. With it, those files stay resolvable AND become ordinary
 * migration sources, so the dashboard can offer to bring them to the new root.
 */
function afterStorageRootChanged(oldRoot: string): void {
  invalidateStorageRootCache()
  recordPreviousModelRoot(oldRoot)
  invalidateModelTargetProbe()
  invalidateUsageCache()
}

export function registerAppIpc(win: BrowserWindow): void {
  /** Returns the userData directory path — used by "Open data folder" in Advanced settings. */
  ipcMain.handle('app:get-data-path', () => app.getPath('userData'))

  // ── User-visible storage root (Documents\Tachi Studio by default) ──────────
  // Where the app saves USER CONTENT: media, designs, renders, flows. Normal
  // users find their files here instead of digging through %APPDATA%.

  // storage:info — current root, whether it's the default, and the default.
  ipcMain.handle('storage:info', () => ({
    root: getStorageRoot(),
    defaultRoot: defaultStorageRoot(),
    exists: existsSync(getStorageRoot()),
  }))

  // storage:choose — native folder picker; persists the choice. Returns the
  // new root, or null if the user cancelled.
  ipcMain.handle('storage:choose', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose where Tachi Studio saves your files',
      defaultPath: getStorageRoot(),
      properties: ['openDirectory', 'createDirectory'],
    })
    const picked = res.filePaths[0]
    if (res.canceled || !picked || !isAbsolute(picked)) return { ok: true as const, root: null }
    const oldRoot = getStorageRoot()
    saveSettings({ storageRoot: picked })
    afterStorageRootChanged(oldRoot)
    return { ok: true as const, root: getStorageRoot() }
  })

  // storage:open — reveal the storage root in Explorer/Finder (creates it
  // first so the user never lands on an error dialog).
  ipcMain.handle('storage:open', async () => {
    // ensureStorageRoot: creates the root FINITELY (node's recursive mkdir can
    // spin at 100% CPU inside a Controlled-Folder-Access-protected Documents —
    // storage-root.ts's boot-freeze note) and heals to the fallback root when
    // the current one is no longer writable, so OPEN FOLDER always lands the
    // user where their files actually are.
    const root = ensureStorageRoot()
    const err = await shell.openPath(root)
    return err ? { ok: false as const, error: err } : { ok: true as const }
  })

  // storage:reset — back to the default Documents\Tachi Studio.
  ipcMain.handle('storage:reset', () => {
    const oldRoot = getStorageRoot()
    saveSettings({ storageRoot: '' })
    afterStorageRootChanged(oldRoot)
    return { ok: true as const, root: getStorageRoot() }
  })

  /** Returns live system info — CPU/RAM/disk/versions for the Studio dashboard. */
  ipcMain.handle('system:info', () => getSystemInfo())

  // ── TACHIAPP: the app's own source checkout ────────────────────────────────
  // The self-improvement chat never asks the user to pick a folder, so main
  // answers "where is this app's source?" for it (services/app-repo.ts).

  /** Resolve the app repo: saved setting → dev walk-up → known installs → null. */
  ipcMain.handle('app:resolve-app-repo', () => {
    try {
      return resolveAppRepoPath({
        settingPath: loadSettings().appRepoPath,
        appPath: app.getAppPath(),
        extraStartDirs: [process.cwd()],
        home: app.getPath('home'),
      })
    } catch {
      return null
    }
  })

  /**
   * One-time LOCATE APP SOURCE pick. Validates the folder actually IS this
   * repo (AGENTS.md + apps/desktop) before storing it, so a mis-pick fails
   * loudly here instead of producing an agent that edits the wrong tree.
   */
  ipcMain.handle('app:choose-app-repo', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Locate the Tachi Studio source folder',
      properties: ['openDirectory'],
    })
    const picked = res.filePaths[0]
    if (res.canceled || !picked || !isAbsolute(picked)) {
      return { ok: false as const, cancelled: true as const }
    }
    if (!looksLikeAppRepo(picked)) {
      return {
        ok: false as const,
        error: `That folder is not the Tachi Studio source (expected AGENTS.md and apps/desktop inside): ${picked}`,
      }
    }
    saveSettings({ appRepoPath: picked })
    return { ok: true as const, path: picked }
  })

  /** Clears onboardingComplete so the setup wizard shows on next launch. */
  ipcMain.handle('app:reset-onboarding', () => {
    saveSettings({ onboardingComplete: false })
  })

  /** Opens Electron DevTools — only useful during development. */
  ipcMain.handle('app:open-devtools', () => {
    if (!win.isDestroyed() && !app.isPackaged) win.webContents.openDevTools()
  })

  /**
   * Delete all user data: keychain entries, settings file, sidecar log files,
   * MCP servers config, Aeon repo clone. Renderer should clear localStorage
   * after this resolves.
   */
  ipcMain.handle('app:delete-all-data', () => {
    const userData = app.getPath('userData')
    try { deleteAllKeys() } catch { /* best-effort */ }

    const filesToDelete = [
      join(userData, 'tachi-settings.json'),
      join(userData, 'tachi-keys.enc.json'),
      join(userData, 'conversations.json'),
      join(userData, 'memory.json'),
      join(userData, 'openclaude.log'),
      join(userData, 'freellmapi.log'),
      // Legacy: the Goose harness was removed from the product. Its log is
      // still deleted here so an upgraded install doesn't leave the file behind.
      join(userData, 'goose.log'),
      join(userData, 'freeclaudecode.log'),
      join(userData, 'mcp-servers.json'),
    ]
    for (const f of filesToDelete) {
      try { if (existsSync(f)) rmSync(f, { force: true }) } catch { /* best-effort */ }
    }

    const aeonDir = join(userData, 'aeon-repo')
    try { if (existsSync(aeonDir)) rmSync(aeonDir, { recursive: true, force: true }) } catch { /* best-effort */ }

    try {
      mkdirSync(userData, { recursive: true })
      writeFileSync(
        join(userData, 'tachi-settings.json'),
        JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: false }, null, 2),
        'utf8',
      )
    } catch { /* best-effort */ }
  })
}
