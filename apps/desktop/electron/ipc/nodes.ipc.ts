// apps/desktop/electron/ipc/nodes.ipc.ts
//
// IPC handlers for the Nodes canvas:
//   nodes:save-flow   — write flow JSON to <storage root>/Flows/<name>.tachi-flow.json
//   nodes:list-flows  — list saved flows in that directory
//   nodes:load-flow   — read a saved flow by filename
//   nodes:list-revisions / read-revision / restore-revision — the .history
//                       snapshots every save leaves behind (A1 below)
//
// Sandbox: all paths are confined to the user-visible flows dir
// (storageDir('flows')) plus the legacy <userData>/nodes dir kept for
// read-compat with flows saved before the storage-root change. New writes
// always land in the storage root. No path traversal is possible because
// we join only the sanitized basename (no slashes allowed through
// sanitizeFlowName / the basename strip in load/delete/rename).

import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, copyFileSync, statSync } from 'fs'
import { join } from 'path'
import { storageDir, legacyDir, writeStorageFile } from '../services/storage-root'
import { getApiServerHandle, isLocalApiServerEnabled } from '../services/sidecar-manager'
import { loadSecretRecord, saveSecretRecord } from '../services/util/token-store'
import {
  armWebhook,
  disarmWebhook,
  forgetWebhook,
  isWebhookSource,
  listArmedWebhooks,
  onWebhookAlert,
  recentWebhookAlerts,
  rotateWebhookToken,
  revealWebhookToken,
  setWebhookTokenStore,
  webhookUrl,
  type WebhookSource,
} from '../services/webhook-hooks'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip everything that isn't alphanumeric, hyphen, or underscore.
 * Returns 'flow-<timestamp>' when the result is empty.
 */
function sanitizeFlowName(name: string): string {
  const ts = Date.now()
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9\-_]/g, '-')
    .replace(/-{2,}/g, '-')   // collapse double-dash runs
    .replace(/^-+|-+$/g, '')  // trim leading/trailing dashes
    .slice(0, 80)
  return sanitized || `flow-${ts}`
}

/** Where NEW flows are written: <storage root>/Flows (mkdir'd by storageDir). */
function nodesDir(): string {
  return storageDir('flows')
}

/** Legacy <userData>/nodes dir — read-only compat for flows saved before the
 *  storage-root change. Never created; never written to. */
function legacyNodesDir(): string {
  return legacyDir('flows')
}

/**
 * Resolve a sanitized flow filename to the directory that actually holds it:
 * the new flows dir wins, then the legacy dir. Returns null when neither has
 * the file.
 */
function findFlowFile(safe: string): string | null {
  for (const dir of [nodesDir(), legacyNodesDir()]) {
    const dest = join(dir, safe)
    if (dest.startsWith(dir) && existsSync(dest)) return dest
  }
  return null
}

/**
 * Read one saved flow's JSON by basename, applying the SAME sandbox as
 * nodes:load-flow (bare basename, `.tachi-flow.json` only, new dir then legacy).
 * Exported for main-process callers with no renderer in the loop — today the
 * scheduler, which runs a saved flow on a timer.
 */
export function readSavedFlowJson(filename: string): { ok: true; json: string } | { ok: false; error: string } {
  try {
    const safe = String(filename ?? '').replace(/[/\\]/g, '')
    if (!safe.endsWith('.tachi-flow.json')) return { ok: false as const, error: 'Not a .tachi-flow.json file' }
    const dest = findFlowFile(safe)
    if (!dest) return { ok: false as const, error: 'Flow not found' }
    return { ok: true as const, json: readFileSync(dest, 'utf8') }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── One-time orphan repair (boot-time) ──────────────────────────────────────
//
// nodes:delete-flow (below) removes a flow from BOTH the storage-root dir
// (current writes) and the legacy userData\nodes dir, tolerating either one
// being already missing. An earlier build's delete path did not do this
// reliably, and because nodes:list-flows reads the storage root directly (the
// PRIMARY location for new saves, not merely a migration target), a flow file
// left behind there "resurrects" a flow the user already deleted, forever.
//
// This repairs the ONE known casualty (live evidence, 2026-07-25: "Brainstorm
// and decide" was rail-deleted, row gone, but the Documents copy remained) by
// EXACT filename, gated on the exact orphan signature (no userData/legacy
// counterpart) — so it can never remove a flow the user later (re)creates
// under the same sanitized name. It also runs at most ONCE per install (a
// marker file in userData — app-internal, never the user-visible storage
// root), so even a same-named flow saved after this fix ships is never at
// risk on a later boot.
//
// A broader "any storage-root-only file is an orphan" heuristic was
// considered and rejected: EVERY currently-saved flow lives ONLY in the
// storage root now (legacy is read-only compat), so "no userData
// counterpart" alone would flag every live flow, not just the orphan.
const KNOWN_ORPHAN_FLOW_NAMES = ['Brainstorm-and-decide.tachi-flow.json']

function orphanRepairMarkerPath(): string {
  return join(app.getPath('userData'), 'nodes-orphan-repair.json')
}

/** Exported for tests. Safe to call every boot — a no-op once the marker exists. */
export function repairKnownOrphanFlows(): void {
  const marker = orphanRepairMarkerPath()
  if (existsSync(marker)) return
  try {
    const dir = nodesDir()
    const legacy = legacyNodesDir()
    for (const name of KNOWN_ORPHAN_FLOW_NAMES) {
      const storagePath = join(dir, name)
      const legacyPath = join(legacy, name)
      if (existsSync(storagePath) && !existsSync(legacyPath)) {
        try { rmSync(storagePath) } catch { /* best-effort — never block boot on this */ }
      }
    }
  } catch {
    /* best-effort — never block app boot on this */
  } finally {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true }) // normally already exists (electron creates it at 'ready')
      writeFileSync(marker, JSON.stringify({ ranAt: new Date().toISOString() }), 'utf8')
    } catch { /* best-effort */ }
  }
}

// ── Revisions (.history) — A1, NODES-RESEARCH-2026-07-26 ─────────────────────
//
// Every nodes:save-flow also drops a snapshot at
//   <storage root>/Flows/.history/<flow base name>/<epoch ms>.json
// so a bad edit is recoverable: undo/redo lives only in the renderer store
// (nodes.store's undoStack) and dies with the tab, while a save OVERWRITES.
//
// Two caps keep the folder honest — at most MAX_REVISIONS_PER_FLOW files AND
// at most MAX_REVISION_BYTES_PER_FLOW bytes per flow, oldest pruned first (the
// newest is never pruned, even when it alone blows the byte budget). A save
// whose bytes are identical to the newest snapshot writes nothing, so idle
// autosaves can't churn the ring.
//
// The dot-prefixed folder deliberately sits INSIDE the user-visible Flows dir:
// nodes:list-flows only ever looks at `*.tachi-flow.json`, so it stays
// invisible to the app while remaining a plain folder of plain JSON the user
// can raid by hand.

const HISTORY_DIR              = '.history'
const HISTORY_VERSION_MARKER   = '.app-version.json'
const MAX_REVISIONS_PER_FLOW   = 20
const MAX_REVISION_BYTES_PER_FLOW = 5 * 1024 * 1024

/**
 * The `<base>` of a flow filename, whitelisted to the exact sanitizeFlowName
 * charset so a history path can never escape the .history root. Returns null
 * for anything that isn't a usable flow filename (fail-closed: no snapshots
 * rather than a guessed folder).
 */
function historyKey(filename: unknown): string | null {
  const safe = String(filename ?? '').replace(/[/\\]/g, '')
  if (!safe.endsWith('.tachi-flow.json')) return null
  const base = safe.slice(0, -'.tachi-flow.json'.length)
  return /^[A-Za-z0-9\-_]+$/.test(base) ? base : null
}

/** Non-recursive mkdir on purpose (storage-root.ts's CFA note) — the parent
 *  Flows dir is already created by storageDir('flows'). */
function ensureDirShallow(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir)
}

function historyRoot(): string { return join(nodesDir(), HISTORY_DIR) }
function historyDir(key: string): string { return join(historyRoot(), key) }

/** Snapshots of one flow, newest first. */
function listSnapshots(key: string): Array<{ ts: number; path: string }> {
  const dir = historyDir(key)
  if (!existsSync(dir)) return []
  const out: Array<{ ts: number; path: string }> = []
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f)
    if (m) out.push({ ts: Number(m[1]), path: join(dir, f) })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

function fileSize(path: string): number {
  try {
    const s = statSync(path) as { size?: number }
    return typeof s.size === 'number' ? s.size : 0
  } catch {
    return 0
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/**
 * Content fingerprint used by the identical-save check: the flow with its
 * `savedAt` stamp dropped and every key sorted. Without this, NOTHING would
 * ever dedupe — serializeFlow stamps a fresh ISO timestamp on every save, so
 * merely switching flows back and forth would burn revision slots. The key sort
 * no longer papers over disagreeing producers (since 59c658a every renderer
 * write goes through stableFlowJson, which sorts) — it stays because a
 * hand-edited or legacy file arriving here can be keyed in any order and must
 * still dedupe against its stable-sorted rewrite. Non-JSON falls back to the
 * raw bytes.
 */
function flowFingerprint(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json
    const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
    delete rest['savedAt']
    return JSON.stringify(sortKeysDeep(rest))
  } catch {
    return json
  }
}

/** Drop oldest snapshots until BOTH caps hold again. The newest always stays. */
function pruneSnapshots(key: string): void {
  const snaps = listSnapshots(key) // newest first
  let bytes = 0
  for (let i = 0; i < snaps.length; i++) {
    bytes += fileSize(snaps[i]!.path)
    const overCount = i + 1 > MAX_REVISIONS_PER_FLOW
    const overBytes = i > 0 && bytes > MAX_REVISION_BYTES_PER_FLOW
    if (!overCount && !overBytes) continue
    for (let j = i; j < snaps.length; j++) {
      try { rmSync(snaps[j]!.path) } catch { /* best-effort — a locked file just survives a round */ }
    }
    return
  }
}

/**
 * Write `json` as the newest snapshot of `key`. No-op when it is byte-identical
 * to the current newest (a save that changed nothing must not burn a slot).
 * Best-effort by contract: a caller must never fail its own write because the
 * history write failed. Exported for tests.
 */
export function writeFlowSnapshot(key: string, json: string): void {
  ensureDirShallow(historyRoot())
  const dir = historyDir(key)
  ensureDirShallow(dir)
  const newest = listSnapshots(key)[0]
  if (newest) {
    try {
      const prev = readFileSync(newest.path, 'utf8')
      if (prev === json || flowFingerprint(prev) === flowFingerprint(json)) return
    } catch { /* unreadable newest → just write a fresh one */ }
  }
  // Two saves inside the same millisecond must not collide.
  let ts = Date.now()
  while (existsSync(join(dir, `${ts}.json`))) ts++
  writeFileSync(join(dir, `${ts}.json`), json, 'utf8')
  pruneSnapshots(key)
}

/**
 * The Langflow defence ("the upgrade ate my flows" — #9510 / #3066): the first
 * run after app.getVersion() changes snapshots EVERY saved flow before anything
 * else can touch it, so a migration or format change is always recoverable.
 * Runs once per version (a marker file next to the snapshots) and is a no-op
 * afterwards. Exported for tests. Never throws — history must not block boot.
 */
export function snapshotFlowsOnVersionChange(): void {
  try {
    let version = ''
    try { version = app.getVersion() } catch { return }
    const marker = join(historyRoot(), HISTORY_VERSION_MARKER)
    let seen = ''
    try {
      seen = (JSON.parse(readFileSync(marker, 'utf8')) as { version?: string }).version ?? ''
    } catch { /* first run / unreadable marker → treat as a change */ }
    if (seen === version) return

    const dir = nodesDir()
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter(f => f.endsWith('.tachi-flow.json'))) {
        const key = historyKey(f)
        if (!key) continue
        try { writeFlowSnapshot(key, readFileSync(join(dir, f), 'utf8')) } catch { /* per-flow: keep going */ }
      }
    }
    ensureDirShallow(historyRoot())
    writeFileSync(marker, JSON.stringify({ version, at: new Date().toISOString() }), 'utf8')
  } catch {
    /* best-effort — never block app boot on history */
  }
}

// ── Webhook triggers (BATCH35 lane B) ────────────────────────────────────────
//
// The canvas's TradingView-webhook node arms an inbound hook on the local API
// server (openai-api-server.ts). The registry + all the security lives in
// services/webhook-hooks.ts (pure); this seam only supplies the two things it
// deliberately does not own: encrypted persistence for the per-hook secrets, and
// the push channel back to the canvas.
//
// It hangs off registerNodesIpc rather than its own module so nothing new lands
// on main.ts's static import graph (R8b) — nodes.ipc is already there.

const WEBHOOK_SECRETS_BASENAME = 'webhook-hooks'

/** Where a hook URL points. Null when the API server is off/not listening. */
function apiServerOrigin(): { origin: string | null; running: boolean; enabled: boolean } {
  try {
    const handle = getApiServerHandle()
    return {
      origin: handle ? `http://127.0.0.1:${handle.port}` : null,
      running: !!handle,
      enabled: isLocalApiServerEnabled(),
    }
  } catch {
    return { origin: null, running: false, enabled: false }
  }
}

function broadcastWebhookAlert(payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    try { w.webContents.send('webhooks:alert', payload) } catch { /* window gone */ }
  }
}

function registerWebhookIpc(): void {
  setWebhookTokenStore({
    load: () => loadSecretRecord(WEBHOOK_SECRETS_BASENAME),
    save: (tokens) => saveSecretRecord(WEBHOOK_SECRETS_BASENAME, tokens),
  })
  onWebhookAlert(broadcastWebhookAlert)

  const asSource = (v: unknown): WebhookSource | null => (isWebhookSource(v) ? v : null)

  const describe = (hookId: string, source: WebhookSource) => {
    const token = revealWebhookToken(hookId)
    const { origin, running, enabled } = apiServerOrigin()
    return {
      hookId,
      source,
      token,
      // No server → no URL. The node renders an honest "server off" state rather
      // than a copyable address that answers nothing.
      url: origin && token ? webhookUrl(origin, source, hookId, token) : null,
      serverRunning: running,
      serverEnabled: enabled,
    }
  }

  // webhooks:status — is the local API server up, and what is armed right now?
  ipcMain.handle('webhooks:status', () => {
    const { origin, running, enabled } = apiServerOrigin()
    return { serverRunning: running, serverEnabled: enabled, origin, hooks: listArmedWebhooks() }
  })

  // webhooks:arm — bring a hook's route on the air. Re-arming an id keeps its
  // secret, so the URL already pasted into an alert survives a canvas reload.
  ipcMain.handle('webhooks:arm', (_event, payload: unknown) => {
    const { hookId, source } = (payload ?? {}) as { hookId?: unknown; source?: unknown }
    const src = asSource(source)
    if (!src) return { ok: false as const, code: 'bad-source', error: 'unknown webhook source' }
    if (typeof hookId !== 'string') return { ok: false as const, code: 'bad-hook-id', error: 'hookId must be a string' }
    const armed = armWebhook(hookId, src)
    if (!armed.ok) return { ok: false as const, code: armed.code, error: armed.message }
    return { ok: true as const, ...describe(hookId, src) }
  })

  // webhooks:disarm — take the route off the air (the secret is kept for re-arm).
  ipcMain.handle('webhooks:disarm', (_event, payload: unknown) => {
    const { hookId } = (payload ?? {}) as { hookId?: unknown }
    if (typeof hookId !== 'string') return { ok: false as const, error: 'hookId must be a string' }
    return { ok: true as const, wasArmed: disarmWebhook(hookId) }
  })

  // webhooks:forget — disarm AND drop the stored secret (next arm = new URL).
  ipcMain.handle('webhooks:forget', (_event, payload: unknown) => {
    const { hookId } = (payload ?? {}) as { hookId?: unknown }
    if (typeof hookId !== 'string') return { ok: false as const, error: 'hookId must be a string' }
    forgetWebhook(hookId)
    return { ok: true as const }
  })

  // webhooks:rotate — new secret, same armed hook. The old URL stops working.
  ipcMain.handle('webhooks:rotate', (_event, payload: unknown) => {
    const { hookId, source } = (payload ?? {}) as { hookId?: unknown; source?: unknown }
    const src = asSource(source)
    if (!src) return { ok: false as const, error: 'unknown webhook source' }
    if (typeof hookId !== 'string') return { ok: false as const, error: 'hookId must be a string' }
    if (!rotateWebhookToken(hookId)) return { ok: false as const, error: 'that webhook is not armed' }
    return { ok: true as const, ...describe(hookId, src) }
  })

  // webhooks:recent — the alerts this hook has accepted since arming (newest
  // first, ring-buffered). Lets a re-opened canvas show what it missed.
  ipcMain.handle('webhooks:recent', (_event, payload: unknown) => {
    const { hookId } = (payload ?? {}) as { hookId?: unknown }
    if (typeof hookId !== 'string') return { alerts: [] }
    return { alerts: recentWebhookAlerts(hookId) }
  })
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerNodesIpc(): void {
  repairKnownOrphanFlows()
  snapshotFlowsOnVersionChange()
  registerWebhookIpc()

  // nodes:save-ref-image
  // Persist a Reference-Image node's picked image to DISK instead of inlining
  // base64 into the flow graph (multi-MB graphs made every canvas persist tick
  // stringify megabytes). Files land under <storage root>/Media/refs — inside
  // the tachi-media:// protocol's serve roots, so the returned url renders in
  // an <img>. (Refs saved under the legacy <userData>/media/refs keep working
  // via the protocol's legacy-root check.)
  // Payload: { dataUrl: string, fileName?: string }
  // Returns: { ok: true; path: string; url: string } | { ok: false; error: string }
  ipcMain.handle('nodes:save-ref-image', (_event, { dataUrl, fileName }: { dataUrl: string; fileName?: string }) => {
    try {
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '')
      if (!m) return { ok: false as const, error: 'not a supported base64 image data URL' }
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
      const buf = Buffer.from(m[2]!, 'base64')
      if (buf.length === 0)                 return { ok: false as const, error: 'empty image' }
      if (buf.length > 25 * 1024 * 1024)    return { ok: false as const, error: 'image too large (25 MB max)' }
      const base = sanitizeFlowName((fileName ?? 'ref').replace(/\.[^.]+$/, '')).slice(0, 60)
      // Same re-probe-and-retry contract as save-flow (LANE J).
      const dest = writeStorageFile('media', join('refs', `${Date.now()}-${base}.${ext}`), buf)
      return { ok: true as const, path: dest, url: `tachi-media://artifact/${encodeURIComponent(dest)}` }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:save-flow
  // Payload: { flowName: string, json: string }
  // Returns: { ok: true; path: string } | { ok: false; error: string }
  ipcMain.handle('nodes:save-flow', (_event, { flowName, json }: { flowName: string; json: string }) => {
    try {
      const safe = sanitizeFlowName(flowName)
      const file = `${safe}.tachi-flow.json`
      // writeStorageFile, not a bare writeFileSync: when the cached storage root
      // has gone unwritable mid-session (Defender Controlled Folder Access on
      // Documents — LANE J) it re-probes the fallback chain once and retries, so
      // the save lands somewhere real instead of surfacing a raw ENOENT. `dest`
      // is therefore the path actually written, which may be under a NEW root —
      // everything below (snapshots, list) re-reads nodesDir() and follows.
      const dest = writeStorageFile('flows', file, json)
      // A1: leave a revision snapshot behind. Best-effort — a full disk or a
      // locked .history folder must never fail the save the user asked for.
      try { writeFlowSnapshot(safe, json) } catch { /* history is a bonus, not a precondition */ }
      return { ok: true as const, path: dest, filename: file }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:list-flows
  // Returns: { ok: true; flows: Array<{ filename: string; name: string; savedAt: string }> }
  ipcMain.handle('nodes:list-flows', () => {
    try {
      const dir    = nodesDir()
      const legacy = legacyNodesDir()

      // One-time lazy migration: COPY (not move — safe) any legacy flow the
      // new dir doesn't have yet. Idempotent; a failed copy just leaves the
      // file listed from its legacy location below.
      if (existsSync(legacy)) {
        for (const f of readdirSync(legacy).filter(f => f.endsWith('.tachi-flow.json'))) {
          try {
            const dest = join(dir, f)
            if (!existsSync(dest)) copyFileSync(join(legacy, f), dest)
          } catch { /* per-file: keep migrating the rest */ }
        }
      }

      // List the new dir, then any legacy-only leftovers (dedupe by filename,
      // new dir wins).
      const entries: Array<{ filename: string; dir: string }> = []
      const seen = new Set<string>()
      for (const d of [dir, legacy]) {
        if (!existsSync(d)) continue
        for (const f of readdirSync(d).filter(f => f.endsWith('.tachi-flow.json'))) {
          if (seen.has(f)) continue
          seen.add(f)
          entries.push({ filename: f, dir: d })
        }
      }
      const flows = entries.map(({ filename, dir: flowDir }) => {
        try {
          const raw = JSON.parse(readFileSync(join(flowDir, filename), 'utf8')) as {
            name?: string; savedAt?: string
          }
          return {
            filename,
            name:    typeof raw.name    === 'string' ? raw.name    : filename.replace('.tachi-flow.json', ''),
            savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
          }
        } catch {
          return { filename, name: filename.replace('.tachi-flow.json', ''), savedAt: '' }
        }
      })
      return { ok: true as const, flows }
    } catch (err) {
      // Surface I/O failures instead of pretending the directory is empty.
      // Callers that just want the list can ignore `error`; smarter renderers
      // can show "couldn't list flows: <reason>".
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), flows: [] }
    }
  })

  // nodes:load-flow
  // Payload: { filename: string }
  // Returns: { ok: true; json: string } | { ok: false; error: string }
  ipcMain.handle('nodes:load-flow', (_event, { filename }: { filename: string }) => {
    try {
      // Safety: strip any path components — only the bare basename is allowed.
      const safe = filename.replace(/[/\\]/g, '')
      if (!safe.endsWith('.tachi-flow.json')) {
        return { ok: false as const, error: 'Not a .tachi-flow.json file' }
      }
      // New flows dir first, then the legacy userData dir (read-compat).
      const dest = findFlowFile(safe)
      if (!dest) return { ok: false as const, error: 'Flow not found' }
      const json = readFileSync(dest, 'utf8')
      return { ok: true as const, json }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:delete-flow
  // Payload: { filename: string }
  // Returns: { ok: true } | { ok: false; error: string }
  ipcMain.handle('nodes:delete-flow', (_event, { filename }: { filename: string }) => {
    try {
      // Same sandbox guard as load-flow: bare basename only, must resolve inside
      // a flows dir. Remove from BOTH dirs — leaving a legacy copy behind would
      // resurrect the flow on the next list-flows migration pass.
      const safe = filename.replace(/[/\\]/g, '')
      if (!safe.endsWith('.tachi-flow.json')) return { ok: false as const, error: 'Not a .tachi-flow.json file' }
      for (const dir of [nodesDir(), legacyNodesDir()]) {
        const dest = join(dir, safe)
        if (!dest.startsWith(dir)) return { ok: false as const, error: 'Access denied' }
        if (existsSync(dest)) rmSync(dest)
      }
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:rename-flow
  // Payload: { filename: string, newName: string }
  // Rewrites the flow's on-disk `name`, saves it under a freshly-sanitized
  // filename, and removes the old file (unless the sanitized name is unchanged).
  // Returns: { ok: true; filename; name } | { ok: false; error }
  ipcMain.handle('nodes:rename-flow', (_event, { filename, newName }: { filename: string; newName: string }) => {
    try {
      const safe = filename.replace(/[/\\]/g, '')
      if (!safe.endsWith('.tachi-flow.json')) return { ok: false as const, error: 'Not a .tachi-flow.json file' }
      // Source may live in either dir (new wins); the renamed file always
      // lands in the new flows dir.
      const src = findFlowFile(safe)
      if (!src) return { ok: false as const, error: 'Flow not found' }

      const cleanName = (typeof newName === 'string' ? newName : '').trim()
      if (!cleanName) return { ok: false as const, error: 'New name is empty.' }
      const newSafe = sanitizeFlowName(cleanName)
      const newFile = `${newSafe}.tachi-flow.json`

      // Update the embedded name so the list label matches the new title.
      let json: string
      try {
        const parsed = JSON.parse(readFileSync(src, 'utf8')) as Record<string, unknown>
        parsed.name = cleanName
        json = JSON.stringify(parsed)
      } catch {
        json = readFileSync(src, 'utf8') // unparseable — copy verbatim
      }
      // writeStorageFile, same LANE J contract as save-flow: a cached root that
      // went unwritable (CFA on Documents) re-probes once and the rename lands
      // under the healed root — `dest` is the path ACTUALLY written, which the
      // old-file cleanup below compares against.
      const dest = writeStorageFile('flows', newFile, json)
      // Drop the OLD filename from both dirs (unless it IS the destination) —
      // a surviving legacy copy would resurrect it on the next list-flows
      // migration pass.
      for (const dir of [nodesDir(), legacyNodesDir()]) {
        const old = join(dir, safe)
        if (old !== dest && old.startsWith(dir) && existsSync(old)) {
          try { rmSync(old) } catch { /* best-effort cleanup */ }
        }
      }
      return { ok: true as const, filename: newFile, name: cleanName }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:list-revisions
  // Payload: { filename: string }
  // Returns: { ok: true; revisions: Array<{ ts: number; savedAt: string; size: number }> }
  //          — newest first. The change-count vs the CURRENT flow is computed
  //          in the renderer (pages/nodes/flowDiff.ts) off the revision JSON,
  //          so main stays a dumb file store that never needs the flow schema.
  ipcMain.handle('nodes:list-revisions', (_event, { filename }: { filename: string }) => {
    try {
      const key = historyKey(filename)
      if (!key) return { ok: false as const, error: 'Not a .tachi-flow.json file', revisions: [] }
      const revisions = listSnapshots(key).map(s => ({
        ts: s.ts, savedAt: new Date(s.ts).toISOString(), size: fileSize(s.path),
      }))
      return { ok: true as const, revisions }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), revisions: [] }
    }
  })

  // nodes:read-revision
  // Payload: { filename: string, ts: number }
  // Returns: { ok: true; json: string } | { ok: false; error: string }
  ipcMain.handle('nodes:read-revision', (_event, { filename, ts }: { filename: string; ts: number }) => {
    try {
      const key = historyKey(filename)
      if (!key) return { ok: false as const, error: 'Not a .tachi-flow.json file' }
      const n = Number(ts)
      // Numeric-only filename — no traversal is expressible.
      if (!Number.isInteger(n) || n <= 0) return { ok: false as const, error: 'Bad revision timestamp' }
      const src = join(historyDir(key), `${n}.json`)
      if (!existsSync(src)) return { ok: false as const, error: 'Revision not found' }
      return { ok: true as const, json: readFileSync(src, 'utf8') }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:restore-revision
  // Payload: { filename: string, ts: number }
  // Writes the revision back as the CURRENT flow file — after snapshotting the
  // state it replaces, so a restore is itself undoable from the same drawer.
  // Returns: { ok: true; json: string } | { ok: false; error: string }
  ipcMain.handle('nodes:restore-revision', (_event, { filename, ts }: { filename: string; ts: number }) => {
    try {
      const key = historyKey(filename)
      if (!key) return { ok: false as const, error: 'Not a .tachi-flow.json file' }
      const n = Number(ts)
      if (!Number.isInteger(n) || n <= 0) return { ok: false as const, error: 'Bad revision timestamp' }
      const src = join(historyDir(key), `${n}.json`)
      if (!existsSync(src)) return { ok: false as const, error: 'Revision not found' }
      const json = readFileSync(src, 'utf8')

      // Undo-ability first: capture what we are about to overwrite (the current
      // file may live in the legacy dir — the restored copy always lands in the
      // new flows dir, which findFlowFile prefers from here on).
      const current = findFlowFile(`${key}.tachi-flow.json`)
      if (current) {
        try { writeFlowSnapshot(key, readFileSync(current, 'utf8')) } catch { /* best-effort */ }
      }
      // writeStorageFile, same LANE J contract as save-flow: the restore must
      // not die with a raw ENOENT when the cached root turned unwritable.
      writeStorageFile('flows', `${key}.tachi-flow.json`, json)
      return { ok: true as const, json }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // nodes:paths-exist
  // Read-only existence probe for the self-healing flow-doctor (NODES-RESEARCH
  // #4): given the absolute folder paths a loaded flow references, report which
  // ones are directories that exist on THIS machine. No writes, no traversal,
  // no listing — just a stat per path the user already put in their own flow.
  // Payload: { paths: string[] }
  // Returns: { existing: Record<string, boolean> }  (path -> is an existing dir)
  ipcMain.handle('nodes:paths-exist', (_event, payload: unknown) => {
    const existing: Record<string, boolean> = {}
    const paths = (payload as { paths?: unknown } | null | undefined)?.paths
    if (!Array.isArray(paths)) return { existing }
    for (const p of paths) {
      if (typeof p !== 'string' || p.trim() === '') continue
      try {
        existing[p] = existsSync(p) && statSync(p).isDirectory()
      } catch {
        existing[p] = false
      }
    }
    return { existing }
  })
}
