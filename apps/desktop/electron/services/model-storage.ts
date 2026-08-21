// apps/desktop/electron/services/model-storage.ts
//
// Model-weight STORAGE DASHBOARD + RELOCATION (USER-PAINS T5+T6).
//
// Local inference engines park multi-GB weights under %APPDATA% (userData)
// today, which lives on C: for most users — the exact pain Ollama users hit
// (2-100 GB silently eating the system drive). This service:
//
//   1. WALKS every engine's weight dir and reports per-engine disk usage
//      (sizes cached 30 s so the Settings panel is cheap to poll).
//   2. RELOCATES weights to `<storage root>/Models/<engine>/`: atomic renames
//      when both roots share a volume, copy-verify-delete when they do not
//      (never a delete before a verified copy; abort-safe and resumable).
//   3. Resolves reads NEW-location-first with a LEGACY fallback, mirroring the
//      design-audio dual-root pattern in storage-root.ts — so an engine keeps
//      working whether or not its weights have been moved.
//   4. Targets NEW downloads at `<storage root>/Models/<engine>/` (LANE U).
//
// LANE U (2026-07-27) — "у меня на C места нет". This module used to send NEW
// downloads to the LEGACY userData dir on the theory that a `.part` file must
// stay on the same device as its final path. The constraint is real (the
// landing `renameSync` throws EXDEV across devices) but it does NOT say
// "everything in userData" — it says ".part NEXT TO its final file". So the
// pair moved together: `partPathFor(finalPath)` (util/model-storage.ts) puts
// the partial in the destination directory, and a new download now writes
// straight to the storage root. Before this, a 2.5-7.7 GB catalog download
// filled the C: drive and the dashboard relocation then needed that space
// TWICE (source + destination) to get it off C: again.
//
// Files already on disk NEVER move on their own: an existing legacy weight
// keeps resolving to legacy, an already-relocated one keeps resolving to the
// root, and only the explicit dashboard relocation changes where a file lives.
//
// FAIL-CLOSED: the destination must pass the writability probe, and a
// CROSS-VOLUME move must additionally find `payload * 1.1` free before the
// first byte is copied. A same-volume move duplicates nothing and so is not
// gated on free space at all.
//
// HONESTY (the "какого хуя оно на диске Ц" lane): the default storage root is
// `Documents\Tachi Studio`, which on a stock Windows install is the SAME DRIVE
// as %APPDATA%. Relocating there moves gigabytes from C: to C: and frees
// nothing, so `moveChangesDrive()` is reported to the dashboard and the UI says
// so before the user starts, rather than offering a move that cannot help.
//
// This module is the single source of truth for BOTH the legacy userData dirs
// and the new storage-root dirs; the installers import `resolveModelPath` /
// `resolveModelDir` / `listEngineItemIds` from here (one-way — this module
// never imports an installer, so there is no cycle).

import { app, type BrowserWindow } from 'electron'
import { join, dirname, extname, isAbsolute } from 'path'
import {
  existsSync, statSync, readdirSync, mkdirSync, copyFileSync, renameSync,
  rmSync, writeFileSync, statfsSync,
} from 'fs'
import { getStorageRoot } from './storage-root'
import { loadSettings, saveSettings } from './settings-store'
import {
  MODEL_ENGINES, MODEL_ENGINE_IDS, planMigration, requiredFreeBytes, isPartFileName,
  type ModelEngineId,
} from './util/model-storage'
// Read-only lookups into the sd.cpp registries (names + the adapter container
// layout). One-way edge: neither sd-cpp-models.ts nor user-sd-models.ts (which
// it re-exports through) imports this module, so there is no cycle — the same
// shape sd-cpp-installer.ts already has with THIS file, just reversed.
import {
  allSdModels, allSdAdapters, SD_ADAPTER_DIR, SD_SPEED_ADAPTERS, type SdAdapterKind,
} from './sd-cpp-models'

export { partPathFor, PART_SUFFIX } from './util/model-storage'

// ─── Roots ──────────────────────────────────────────────────────────────────

/** LEGACY userData dir where an engine's weights live today (pre-relocation).
 *  Defined here (not imported from the installers) so this module has no
 *  dependency on them — the installers depend on THIS one. */
export function engineLegacyBase(engine: ModelEngineId): string {
  const ud = app.getPath('userData')
  switch (engine) {
    case 'llama':   return join(ud, 'llama-cpp', 'models')
    case 'sd':      return join(ud, 'sd-cpp', 'models')
    case 'whisper': return join(ud, 'whisper-models')
    case 'piper':   return join(ud, 'piper', 'voices')
  }
}

/** Base of ALL relocated weights under the user-visible storage root. */
export function modelsRoot(): string {
  return join(getStorageRoot(), 'Models')
}

/** NEW storage-root dir for an engine's weights (relocation target). */
export function engineNewBase(engine: ModelEngineId): string {
  return join(modelsRoot(), MODEL_ENGINES[engine].subdir)
}

// ─── Previously-used roots (orphan rescue) ───────────────────────────────────
//
// A weight is located by CONVENTION — `<root>/Models/<engine>/<id>` — and NOT
// by an absolute path stored per model (the sd registry keeps ids, urls and
// file names; nothing anywhere records where a weight lives). That is what
// makes the dual-root resolver possible, but it also means the instant
// `storageRoot` changes, everything relocated under the OLD root falls out of
// every resolver at once: `listEngineItemIds` stops listing it, `isGgufModelDownloaded`
// says false, and a 7.7 GB model reads as "not installed" while still occupying
// the disk. Remembering the roots we have used keeps those weights RESOLVABLE,
// and makes them ordinary migration sources so the dashboard can offer to bring
// them to the current root.
//
// Reads are defensive: a corrupt/absent setting simply yields no history, which
// restores exactly the previous two-root behaviour.

/** Previous storage roots, newest first (never includes the current one). */
export function previousModelRoots(): string[] {
  let hist: unknown
  try { hist = (loadSettings() as { modelRootHistory?: unknown }).modelRootHistory } catch { return [] }
  if (!Array.isArray(hist)) return []
  const current = normRoot(getStorageRoot())
  const out: string[] = []
  for (const h of hist) {
    if (typeof h !== 'string' || !h.trim() || !isAbsolute(h.trim())) continue
    const v = h.trim()
    if (normRoot(v) === current) continue
    if (out.some(o => normRoot(o) === normRoot(v))) continue
    out.push(v)
  }
  return out
}

function normRoot(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * Record `oldRoot` as a previously-used storage root. Called by the settings
 * IPC immediately AFTER the root changes, so weights left behind under the old
 * root stay findable instead of silently reading as uninstalled.
 *
 * No-ops when the root did not really change or when the old location holds
 * nothing — history is for rescuing data, not for logging clicks.
 */
export function recordPreviousModelRoot(oldRoot: string): void {
  if (!oldRoot || !isAbsolute(oldRoot)) return
  if (normRoot(oldRoot) === normRoot(getStorageRoot())) return
  if (!existsSync(join(oldRoot, 'Models'))) return
  let prev: unknown
  try { prev = (loadSettings() as { modelRootHistory?: unknown }).modelRootHistory } catch { prev = [] }
  const existing = Array.isArray(prev) ? prev.filter((v): v is string => typeof v === 'string') : []
  const next = [oldRoot, ...existing.filter(v => normRoot(v) !== normRoot(oldRoot))].slice(0, 8)
  try { saveSettings({ modelRootHistory: next }) } catch { /* best-effort */ }
  invalidateUsageCache()
}

/**
 * Every base that is NOT the current target but may hold this engine's weights,
 * in search order: previously-used storage roots (newest first), then the
 * userData dir. Reads prefer the current target, then walk this list.
 */
export function engineFallbackBases(engine: ModelEngineId): string[] {
  const sub = MODEL_ENGINES[engine].subdir
  return [
    ...previousModelRoots().map(r => join(r, 'Models', sub)),
    engineLegacyBase(engine),
  ]
}

/** Current target first, then every fallback base — the full search order. */
function engineSearchBases(engine: ModelEngineId): string[] {
  return [engineNewBase(engine), ...engineFallbackBases(engine)]
}

// ─── New-download target probe (LANE U) ──────────────────────────────────────

/**
 * FINITE directory creation — segment-by-segment, NON-recursive mkdir. Node's
 * `mkdirSync({recursive:true})` can spin forever at 100 % CPU on Windows when
 * the walk hits an EPERM inside a Defender Controlled-Folder-Access folder
 * (the 2026-07-17 boot freeze; see the header of storage-root.ts). The storage
 * root itself is already probed by getStorageRoot(); this only has to add the
 * `Models/<engine>` levels underneath it, but it does so by the same safe rule.
 */
function ensureDirFinite(dir: string): boolean {
  try { if (existsSync(dir)) return statSync(dir).isDirectory() } catch { return false }
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return false
  let cur = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '\\' : (dir.startsWith('/') ? '/' + parts[0] : parts[0])
  for (let i = 1; i < parts.length; i++) {
    cur = join(cur, parts[i])
    try {
      if (!existsSync(cur)) mkdirSync(cur) // NON-recursive on purpose
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
  }
  try { return statSync(dir).isDirectory() } catch { return false }
}

// Verdict cache, keyed on the ROOT STRING. Keying it that way means the
// Settings picker changing the root (storage:choose / storage:reset, which
// clear storage-root's own cache) automatically re-probes here on the next
// call — no cross-module invalidation hook to forget.
let targetProbe: { root: string; usable: boolean } | null = null

/** Drop the cached probe verdict (tests; a manual re-check). */
export function invalidateModelTargetProbe(): void { targetProbe = null }

/**
 * Is `<storage root>/Models` usable as the DESTINATION of a NEW download?
 *
 * Same fail-closed rule the relocation preflight uses: the directory must be
 * creatable AND a probe file must actually write (Controlled Folder Access and
 * read-only mounts let `existsSync` say yes and then refuse every write). A
 * `false` sends new downloads back to the legacy userData dir, which is where
 * they landed before LANE U — degraded, but never broken.
 */
export function isModelRootWritable(): boolean {
  let root: string
  try { root = getStorageRoot() } catch { return false }
  if (targetProbe && targetProbe.root === root) return targetProbe.usable
  const usable = ensureWritable(join(root, 'Models'))
  targetProbe = { root, usable }
  return usable
}

// ─── Dual-root resolution (NEW first, legacy fallback) ─────────────────────────

/**
 * Resolve a weight PATH (join of `sub` parts under the engine base).
 *
 * Order:
 *   1. LONGEST-PREFIX anchoring — the full path decides first, then each
 *      shorter prefix (i.e. the item folder the file belongs to). Whichever
 *      root already holds something at that prefix wins, NEW root first. This
 *      is what keeps a multi-file item together: a piper voice whose
 *      `<id>.onnx.json` is already in legacy resolves its `<id>.onnx` to
 *      legacy too, instead of splitting one voice across two drives.
 *   2. Present in NEITHER root → this is a NEW download, and it targets the
 *      storage root whenever that root is writable (LANE U), falling back to
 *      the legacy userData dir when it is not.
 *
 * Nothing here MOVES a file: an existing weight always resolves to the root it
 * is actually stored in. Only the dashboard relocation moves bytes.
 */
export function resolveModelPath(engine: ModelEngineId, ...sub: string[]): string {
  const bases = engineSearchBases(engine) // current target, then every fallback
  for (let n = sub.length; n >= 1; n--) {
    const pre = sub.slice(0, n)
    for (const base of bases) {
      if (existsSync(join(base, ...pre))) return join(base, ...sub)
    }
  }
  return isModelRootWritable()
    ? join(engineNewBase(engine), ...sub)
    : join(engineLegacyBase(engine), ...sub)
}

/** Dir-item variant (sd component sets, piper voices): the `<id>` subdir,
 *  NEW-root first then legacy, defaulting to legacy when neither is present. */
export function resolveModelDir(engine: ModelEngineId, id: string): string {
  return resolveModelPath(engine, id)
}

/** Remove `sub` from BOTH roots (defensive: a mid-abort relocation can briefly
 *  leave a file in both). Returns ok unless a real (non-ENOENT) error occurs. */
export function removeResolved(engine: ModelEngineId, ...sub: string[]): { ok: boolean; error?: string } {
  invalidateUsageCache()
  // EVERY root we might have put it in — a remove that missed a previously-used
  // root would leave the bytes on disk while the UI claims the model is gone.
  const targets = engineSearchBases(engine).map(base => join(base, ...sub))
  for (const t of targets) {
    try {
      if (existsSync(t)) rmSync(t, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: true }
}

/** Item ids present in EITHER root (merged, de-duplicated). File engines apply
 *  the extension gate and strip it; dir engines list subdir names. */
export function listEngineItemIds(engine: ModelEngineId): string[] {
  const layout = MODEL_ENGINES[engine]
  const ids = new Set<string>()
  for (const base of engineSearchBases(engine)) {
    let names: string[]
    try { names = readdirSync(base) } catch { continue }
    for (const name of names) {
      const abs = join(base, name)
      let s: ReturnType<typeof statSync>
      try { s = statSync(abs) } catch { continue }
      if (layout.itemKind === 'file') {
        if (!s.isFile()) continue
        if (layout.ext && !name.toLowerCase().endsWith(layout.ext)) continue
        ids.add(layout.ext ? name.slice(0, -layout.ext.length) : name)
      } else {
        if (!s.isDirectory()) continue
        ids.add(name)
      }
    }
  }
  return [...ids].sort()
}

// ─── Sizing (recursive, cheap: stat only, never reads bytes) ──────────────────

function fileBytes(abs: string): number {
  try { return statSync(abs).size } catch { return 0 }
}

/** Recursive byte size of a directory (0 when missing). */
function dirBytes(abs: string): number {
  let total = 0
  const walk = (d: string): void => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      const p = join(d, name)
      let s: ReturnType<typeof statSync>
      try { s = statSync(p) } catch { continue }
      if (s.isFile()) total += s.size
      else if (s.isDirectory()) walk(p)
    }
  }
  if (existsSync(abs)) walk(abs)
  return total
}

// ─── sd.cpp: adapter containers + checkpoint dedup (footgun + honesty fix) ────
//
// listEngineItemIds('sd') returns RAW SUBDIRS of sd-cpp/models: most are one
// installed CHECKPOINT (named by its registry id, e.g. `civitai-812345`), but
// three of them ('loras'/'embeddings'/'vae', see SD_ADAPTER_DIR) are SHARED
// CONTAINERS the installer places every adapter of one kind into, because
// `--lora-model-dir`/`--embd-dir` take a directory the engine scans by file
// stem, not a single file (sd-cpp-installer.ts §ADAPTERS). Treating a
// container like an ordinary item was the footgun this lane exists to close: a
// row literally named "loras" carried a Remove that rmSync'd every LoRA on the
// machine in one click. And treating a checkpoint's dirBytes as the sum of its
// own files invented gigabytes that are not on the volume: curated rows
// deliberately hard-link shared components (t5xxl, autoencoders — see
// sd-cpp-installer's placeReusedComponent), so the same physical file was
// walked and charged once PER ROW that names it.
//
// The size fix mirrors catalog-service.ts's shared-bytes rule exactly
// (8f9ddc6): one stat per component keyed by `dev:ino` (the file's true
// identity — two names for one inode collapse to one key; the cross-volume
// COPY fallback produces two distinct inodes and is correctly charged twice,
// because it really is two copies), and a component counts toward sizeBytes
// only for the FIRST holder in listing order.

/** Container dir name ('loras'/'embeddings'/'vae') -> the adapter kind it
 *  holds. Membership test lives in ADAPTER_CONTAINER_IDS (a Set — safe against
 *  prototype keys); this map is only ever indexed with an id already confirmed
 *  a member. Derived from SD_ADAPTER_DIR (the installer's own source of truth)
 *  rather than duplicated literals, so a renamed container folder cannot drift
 *  the two out of sync. */
const ADAPTER_DIR_TO_KIND: Readonly<Record<string, SdAdapterKind>> = Object.fromEntries(
  (Object.entries(SD_ADAPTER_DIR) as Array<[SdAdapterKind, string]>).map(([kind, dir]) => [dir, kind]),
)
const ADAPTER_CONTAINER_IDS: ReadonlySet<string> = new Set(Object.values(SD_ADAPTER_DIR))

/** The file's registry stem — the part that names it in `<lora:stem:weight>`
 *  and on disk (adapterFilePath's inverse). */
function stemOf(fileName: string): string {
  const ext = extname(fileName)
  return ext ? fileName.slice(0, -ext.length) : fileName
}

/** A container file's human name: the user adapter registry first (a Civitai
 *  install, exactly like a checkpoint's), then the curated speed-pack table
 *  (those files are DELIBERATELY absent from the user registry — see
 *  sd-cpp-installer's installedAdapterDirs — so without this branch every
 *  speed-pack LoRA would show its raw hash-suffixed slug), then the stem
 *  itself: never worse than what the dashboard showed before this lane. */
function resolveAdapterFileName(kind: SdAdapterKind, stem: string): string {
  const registered = allSdAdapters().find(a => a.kind === kind && a.slug === stem)
  if (registered) return registered.name
  if (kind === 'lora') {
    for (const pack of SD_SPEED_ADAPTERS) {
      if (pack.files.some(f => f.slug === stem)) return pack.name
    }
  }
  return stem
}

/** A checkpoint's human name: curated ∪ user registry (allSdModels — the same
 *  merged lookup the Catalog/Media dropdowns use), falling back to the raw id
 *  so an orphaned or unregistered directory is still listed, just unnamed. */
function resolveCheckpointName(id: string): string {
  return allSdModels().find(m => m.id === id)?.name ?? id
}

/** Every FILE directly inside one container dir, merged across roots (the
 *  CURRENT target — `bases[0]` — wins a same-name collision, mirroring
 *  resolveModelPath). A `.part` is an in-flight download, never a listed
 *  adapter. Anything outside the current target counts as 'legacy': it still
 *  needs moving, whichever old root it happens to sit in. */
function listContainerFiles(
  bases: readonly string[], containerId: string,
): Array<{ name: string; bytes: number; location: 'root' | 'legacy' }> {
  const seen = new Map<string, { bytes: number; location: 'root' | 'legacy' }>()
  for (const [i, base] of bases.entries()) {
    const location: 'root' | 'legacy' = i === 0 ? 'root' : 'legacy'
    let names: string[]
    try { names = readdirSync(join(base, containerId)) } catch { continue }
    for (const name of names) {
      if (seen.has(name) || isPartFileName(name)) continue
      let s: ReturnType<typeof statSync>
      try { s = statSync(join(base, containerId, name)) } catch { continue }
      if (!s.isFile()) continue
      seen.set(name, { bytes: s.size, location })
    }
  }
  return [...seen.entries()].map(([name, v]) => ({ name, ...v }))
}

interface SdComponentStat { itemId: string; key: string; size: number }

/** One stat per component of every CHECKPOINT id (never a container — those
 *  are flat adapter files with no cross-item sharing to dedupe), keyed by the
 *  physical `dev:ino`. Recurses because a checkpoint is itself a directory of
 *  role-named files (model/vae/clip_l/t5xxl/...). */
function statCheckpointComponents(
  bases: readonly string[], ids: readonly string[],
): SdComponentStat[] {
  const out: SdComponentStat[] = []
  for (const id of ids) {
    const root = bases.map(b => join(b, id)).find(existsSync) ?? join(bases[0], id)
    const walk = (d: string): void => {
      let names: string[]
      try { names = readdirSync(d) } catch { return }
      for (const name of names) {
        const abs = join(d, name)
        let plain: ReturnType<typeof statSync>
        try { plain = statSync(abs) } catch { continue }
        if (plain.isDirectory()) { walk(abs); continue }
        if (!plain.isFile()) continue
        try {
          const st = statSync(abs, { bigint: true })
          out.push({ itemId: id, key: `${st.dev}:${st.ino}`, size: Number(st.size) })
        } catch { /* vanished between the two stats — skip, costs nothing */ }
      }
    }
    if (existsSync(root)) walk(root)
  }
  return out
}

/** The dedup + naming pass for the sd engine's checkpoint ids: sizeBytes
 *  charges each physical file to its FIRST holder only (Σ items == true disk
 *  usage), and sharedWith names the other installed checkpoints that keep the
 *  rest — the exact rule catalog-service.ts's listInstalledSdRows applies to
 *  the Installed tab (8f9ddc6), reused here for the Settings dashboard. */
function checkpointUsageItems(
  ids: readonly string[], bases: readonly string[],
): ModelUsageItem[] {
  const comps = statCheckpointComponents(bases, ids)
  const holders = new Map<string, string[]>()
  for (const c of comps) {
    const held = holders.get(c.key) ?? []
    if (!held.includes(c.itemId)) held.push(c.itemId)
    holders.set(c.key, held)
  }
  // An id with NO components on disk is an empty directory, not a model —
  // _doDownloadModel mkdirs before the first byte lands, so a cancelled/failed
  // download leaves a real-but-empty dir that used to render as a ghost
  // "0 B — REMOVE" row (checkpoint-A driver finding). The test is component
  // presence, NOT bytes===0: a row whose every component is hard-link-shared
  // legitimately charges 0 bytes here yet is fully installed.
  const hasAnyComponent = new Set(comps.map(c => c.itemId))
  return ids.filter(id => hasAnyComponent.has(id)).map(id => {
    let bytes = 0
    const sharedWith = new Set<string>()
    for (const c of comps) {
      if (c.itemId !== id) continue
      const held = holders.get(c.key) ?? [id]
      if (held[0] === id) bytes += c.size
      for (const other of held) if (other !== id) sharedWith.add(resolveCheckpointName(other))
    }
    const location: 'root' | 'legacy' = existsSync(join(bases[0], id)) ? 'root' : 'legacy'
    return {
      id, location, bytes,
      displayName: resolveCheckpointName(id),
      ...(sharedWith.size > 0 ? { sharedWith: [...sharedWith] } : {}),
    }
  })
}

/** One ModelUsageItem per non-empty adapter container, with the per-file list
 *  that replaces the old "Remove nukes every LoRA" single row. */
function containerUsageItems(
  containerIds: readonly string[], bases: readonly string[],
): ModelUsageItem[] {
  const out: ModelUsageItem[] = []
  for (const containerId of containerIds) {
    const kind = ADAPTER_DIR_TO_KIND[containerId]
    const files = listContainerFiles(bases, containerId)
    if (files.length === 0) continue // nothing installed of this kind — no row at all
    const containerFiles: ModelStorageFile[] = files.map(f => ({
      name: f.name,
      displayName: resolveAdapterFileName(kind, stemOf(f.name)),
      bytes: f.bytes,
      location: f.location,
    }))
    out.push({
      id: containerId,
      location: files.some(f => f.location === 'legacy') ? 'legacy' : 'root',
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      displayName: containerId,
      adapterKind: kind,
      containerFiles,
    })
  }
  return out
}

/** All files under `base` (recursive) with a base-relative path + size. Feeds
 *  the migration file list; ext-gated for flat-file engines so a stray file
 *  next to the weights is never moved. */
function walkEngineFiles(base: string, layout = MODEL_ENGINES.llama): MigrationSource[] {
  const out: MigrationSource[] = []
  const rec = (d: string, rel: string): void => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      const abs = join(d, name)
      const childRel = rel ? `${rel}/${name}` : name
      let s: ReturnType<typeof statSync>
      try { s = statSync(abs) } catch { continue }
      if (s.isFile()) {
        // A download in flight is not a weight — never relocate a `.part`
        // (dir-based engines have no extension gate to filter it out).
        if (isPartFileName(name)) continue
        if (layout.itemKind === 'file' && layout.ext && !name.toLowerCase().endsWith(layout.ext)) continue
        out.push({ relPath: childRel, bytes: s.size })
      } else if (s.isDirectory()) {
        rec(abs, childRel)
      }
    }
  }
  if (existsSync(base)) rec(base, '')
  return out
}

interface MigrationSource { relPath: string; bytes: number }

/**
 * Is `dst` already a COMPLETE stand-in for `src`?
 *
 * `existsSync(dst)` is NOT the same question, and using it was a data-loss bug:
 * a directory sitting at the destination path, a zero-byte stub, or a truncated
 * earlier attempt all pass `existsSync`, so the file was dropped from the copy
 * plan as "already moved" — and then the delete phase, which deletes every
 * source unconditionally, removed the only real copy. The move must satisfy
 * itself that a genuine file of the right size is there before the source is
 * allowed to die.
 */
function destSatisfies(src: string, dst: string): boolean {
  try {
    const d = statSync(dst)
    if (!d.isFile()) return false
    return d.size === statSync(src).size
  } catch { return false }
}

// ─── Usage report (30 s cache) ────────────────────────────────────────────────

/** One file inside an sd adapter container ('loras'/'embeddings'/'vae'). */
export interface ModelStorageFile {
  /** On-disk file name, including extension. */
  name: string
  /** Resolved human name (adapter registry / speed-pack lookup); falls back to
   *  the bare file stem when nothing recognizes it — never worse than the raw
   *  slug that used to be the only thing shown. */
  displayName: string
  bytes: number
  location: 'root' | 'legacy'
}

export interface ModelUsageItem {
  id: string
  /** 'root' = already under the storage root; 'legacy' = still in userData.
   *  For an sd adapter container this is 'legacy' when ANY file inside it
   *  still lives there — Move stays offered until every file has relocated. */
  location: 'root' | 'legacy'
  bytes: number
  /** Human-readable label. Falls back to `id` (unchanged behaviour) when
   *  nothing resolves it — a checkpoint's registry name, never the raw
   *  `civitai-<versionId>` id the dashboard used to print verbatim. */
  displayName: string
  /**
   * Present ONLY for the sd 'loras'/'embeddings'/'vae' shared container
   * directories. These are NOT one model: they are every installed adapter of
   * one kind sharing a directory the engine scans by file stem
   * (`--lora-model-dir`/`--embd-dir`, sd-cpp-installer.ts §ADAPTERS), and a
   * plain Remove on the container id used to `rmSync` the WHOLE directory —
   * one click deleted every LoRA on the machine. Its presence tells the
   * renderer to offer a per-file Remove instead.
   */
  adapterKind?: SdAdapterKind
  containerFiles?: ModelStorageFile[]
  /** Other installed sd item ids that hold a hard link to one of THIS item's
   *  on-disk components — the shared-bytes-rule honesty label (catalog-service
   *  landed the identical rule for the Installed tab in 8f9ddc6). Undefined
   *  when nothing is shared. */
  sharedWith?: string[]
}

export interface EngineUsage {
  engine: ModelEngineId
  label: string
  items: ModelUsageItem[]
  totalBytes: number
  /** True when this engine has any item still in the legacy userData location. */
  hasLegacy: boolean
}

export interface StorageUsage {
  engines: EngineUsage[]
  totalBytes: number
  /** Target of a relocation: `<storage root>/Models`. */
  modelsRoot: string
  /** userData path (where legacy weights and new downloads live). */
  userDataRoot: string
  /** Free / total bytes on the storage-root drive (for the low-disk gate UI). */
  storageFreeBytes: number | null
  storageTotalBytes: number | null
  /** True when ANY engine still has weights in the legacy location (move is useful). */
  canRelocate: boolean
  /**
   * True when `modelsRoot` is on a DIFFERENT physical volume than `userDataRoot`
   * — i.e. moving would genuinely free space on the drive the weights sit on
   * today. False means the storage root is on the SAME drive as app data (the
   * stock case: `Documents\Tachi Studio` is on C: exactly like `%APPDATA%`), so
   * a relocation shuffles gigabytes around one volume and frees nothing. The
   * dashboard says this out loud instead of offering a move that cannot help.
   */
  moveChangesDrive: boolean
  /** Free / total bytes on the drive holding the LEGACY (userData) weights —
   *  the drive the user is actually trying to rescue. Null when unprobeable. */
  legacyFreeBytes: number | null
  legacyTotalBytes: number | null
}

let usageCache: { at: number; value: StorageUsage } | null = null
const USAGE_TTL_MS = 30_000

export function invalidateUsageCache(): void { usageCache = null }

function itemBytes(engine: ModelEngineId, base: string, id: string): number {
  const layout = MODEL_ENGINES[engine]
  if (layout.itemKind === 'file') return fileBytes(join(base, `${id}${layout.ext ?? ''}`))
  return dirBytes(join(base, id))
}

function engineUsage(engine: ModelEngineId): EngineUsage {
  const layout = MODEL_ENGINES[engine]
  const bases = engineSearchBases(engine)
  const newBase = bases[0]
  const ids = listEngineItemIds(engine)

  let items: ModelUsageItem[]
  if (engine === 'sd') {
    // Split the raw subdir list into shared adapter containers vs actual
    // checkpoints — see the "adapter containers + checkpoint dedup" section
    // above for why neither can use the generic per-item path below.
    const containerIds = ids.filter(id => ADAPTER_CONTAINER_IDS.has(id))
    const checkpointIds = ids.filter(id => !ADAPTER_CONTAINER_IDS.has(id))
    items = [
      ...checkpointUsageItems(checkpointIds, bases),
      ...containerUsageItems(containerIds, bases),
    ]
  } else {
    items = ids.map(id => {
      const sub = layout.itemKind === 'file' ? `${id}${layout.ext ?? ''}` : id
      // The CURRENT target wins on a collision (mirrors resolveModelPath);
      // otherwise charge the item to the first fallback root that holds it.
      const holder = bases.find(b => existsSync(join(b, sub))) ?? newBase
      const location: 'root' | 'legacy' = holder === newBase ? 'root' : 'legacy'
      return { id, location, bytes: itemBytes(engine, holder, id), displayName: id }
    })
  }

  items.sort((a, b) => b.bytes - a.bytes)
  return {
    engine,
    label: layout.label,
    items,
    totalBytes: items.reduce((s, i) => s + i.bytes, 0),
    hasLegacy: items.some(i => i.location === 'legacy'),
  }
}

export function getStorageUsage(force = false): StorageUsage {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value
  const engines = MODEL_ENGINE_IDS.map(engineUsage)
  let storageFreeBytes: number | null = null
  let storageTotalBytes: number | null = null
  try {
    // statfs the storage root's drive (create nothing — just probe the parent
    // that already exists). getStorageRoot() always resolves to a live dir.
    const s = statfsSync(getStorageRoot()) as unknown as { bsize: number; bavail: number; blocks: number }
    storageFreeBytes  = s.bsize * s.bavail
    storageTotalBytes = s.bsize * s.blocks
  } catch { /* statfsSync unavailable — UI degrades to no disk bar */ }
  const userDataRoot = app.getPath('userData')
  let legacyFreeBytes: number | null = null
  let legacyTotalBytes: number | null = null
  try {
    const s = statfsSync(userDataRoot) as unknown as { bsize: number; bavail: number; blocks: number }
    legacyFreeBytes  = s.bsize * s.bavail
    legacyTotalBytes = s.bsize * s.blocks
  } catch { /* same degradation as above */ }
  const value: StorageUsage = {
    engines,
    totalBytes: engines.reduce((s, e) => s + e.totalBytes, 0),
    modelsRoot: modelsRoot(),
    userDataRoot,
    storageFreeBytes,
    storageTotalBytes,
    canRelocate: engines.some(e => e.hasLegacy),
    moveChangesDrive: moveChangesDrive(),
    legacyFreeBytes,
    legacyTotalBytes,
  }
  usageCache = { at: Date.now(), value }
  return value
}

// ─── Remove one model ─────────────────────────────────────────────────────────

/**
 * Remove one item. `id` is normally a top-level item id (a checkpoint, a
 * whole adapter container). An id of the form `<container>/<file>` targets
 * ONE file inside an sd adapter container instead of the shared directory —
 * the per-file Remove the dashboard now offers for 'loras'/'embeddings'/'vae'
 * so a click can no longer take out every LoRA at once. The renderer only
 * ever sends the bare container form from an explicit "delete all N files"
 * confirm, never from a stray click.
 */
export function removeModelItem(engine: ModelEngineId, id: string): { ok: boolean; error?: string } {
  const slashAt = id.indexOf('/')
  if (slashAt > 0) {
    return removeResolved(engine, id.slice(0, slashAt), id.slice(slashAt + 1))
  }
  const layout = MODEL_ENGINES[engine]
  const sub = layout.itemKind === 'file' ? `${id}${layout.ext ?? ''}` : id
  return removeResolved(engine, sub)
}

// ─── Relocation (copy-verify-delete, abort-safe, fail-closed) ──────────────────

export interface ModelMigrateProgress {
  engine: ModelEngineId
  phase: 'preflight' | 'copy' | 'delete' | 'done' | 'error' | 'aborted' | 'skip'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile?: string
  message?: string
  error?: string
}

export interface ModelMigrateResult {
  ok: boolean
  engine: ModelEngineId
  movedFiles: number
  movedBytes: number
  error?: string
  aborted?: boolean
  skipped?: boolean
}

// Per-engine abort flags + an in-flight guard the engine-start paths check.
const abortFlags = new Map<ModelEngineId, boolean>()
const migrating = new Set<ModelEngineId>()

/** True while THIS engine's weights are mid-relocation — its client should
 *  refuse to start so it never reads a half-moved file. */
export function isEngineMigrating(engine: ModelEngineId): boolean {
  return migrating.has(engine)
}

/** Request an in-flight relocation for `engine` to stop at the next file
 *  boundary (copy phase only — the delete phase runs to completion). */
export function abortModelMigration(engine: ModelEngineId): void {
  if (migrating.has(engine)) abortFlags.set(engine, true)
}

function pushMigrate(win: BrowserWindow | null, ev: ModelMigrateProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('model-storage:migrate-progress', ev)
}

/** Can we create + write a probe file inside `dir`? (CFA / read-only mounts
 *  silently block writes — existsSync alone lies.) Creates `dir` first, with
 *  the FINITE walker (node's recursive mkdir can spin under CFA). */
function ensureWritable(dir: string): boolean {
  if (!ensureDirFinite(dir)) return false
  const probe = join(dir, `.tachi-model-probe-${process.pid}`)
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch { return false }
}

function freeDiskBytes(dir: string): number {
  try {
    const s = statfsSync(dir) as unknown as { bsize: number; bavail: number }
    return s.bsize * s.bavail
  } catch { return Number.POSITIVE_INFINITY /* can't probe → don't block on disk */ }
}

/**
 * Are `srcDir` and `dstDir` on the SAME VOLUME?
 *
 * Answered by ATTEMPTING the operation we actually care about — `rename(2)` /
 * MoveFile throws EXDEV across devices — rather than comparing drive letters,
 * which lies on UNC shares, directory junctions, `subst` drives, bind mounts
 * and any volume mounted into a folder. Both dirs must already exist; a
 * zero-byte probe is created in `srcDir`, renamed into `dstDir`, and removed
 * from wherever it ended up.
 *
 * `false` on ANY failure — the caller then takes the copy-verify-delete path,
 * which is still correct within one volume, just slower. Never throws.
 */
export function sameVolume(srcDir: string, dstDir: string): boolean {
  if (!existsSync(srcDir) || !existsSync(dstDir)) return false
  const name = `.tachi-xdev-probe-${process.pid}`
  const probeSrc = join(srcDir, name)
  const probeDst = join(dstDir, name)
  try { writeFileSync(probeSrc, '') } catch { return false }
  try {
    renameSync(probeSrc, probeDst)
    return true
  } catch {
    return false
  } finally {
    try { rmSync(probeSrc, { force: true }) } catch { /* it moved — nothing here */ }
    try { rmSync(probeDst, { force: true }) } catch { /* it never landed */ }
  }
}

/**
 * Would relocating weights actually get them OFF the drive they are on today?
 *
 * The honest question behind the whole dashboard. `<storage root>` defaults to
 * `Documents\Tachi Studio`, which on a stock Windows install is the SAME DRIVE
 * as `%APPDATA%` — so "Move all to storage root" would copy tens of gigabytes
 * from C: to C:, need the payload free on C: to do it, and free exactly nothing
 * at the end. The dashboard uses this to say so BEFORE the user starts, instead
 * of offering a move that cannot help (and, for the user whose C: is nearly
 * full, cannot even complete).
 */
export function moveChangesDrive(): boolean {
  try {
    return !sameVolume(app.getPath('userData'), getStorageRoot())
  } catch { return false }
}

/**
 * Relocate one engine's weights from the legacy userData dir to
 * `<storage root>/Models/<engine>/`.
 *
 * TWO paths, chosen by probing (never by parsing drive letters):
 *   • SAME VOLUME  → one atomic `rename` per file. Instant, and it needs zero
 *     free space at the destination because nothing is duplicated.
 *   • CROSS VOLUME → copy to a `.migrating` temp beside the destination, verify
 *     byte size, atomically rename into place. Only after ALL files are verified
 *     are the sources deleted, so a source is never lost to an unverified copy.
 *     This path (and only this path) must clear the `payload * 1.1` disk gate.
 *
 * RESUMABLE: files already present at the destination are skipped, so a run
 * interrupted anywhere can simply be run again.
 *
 * ABORT-SAFE: cancelling undoes everything THIS run produced — copies are
 * deleted, renames are renamed BACK — so no item is left split across the two
 * roots and no source file is ever lost.
 */
export async function migrateEngine(engine: ModelEngineId, win: BrowserWindow | null): Promise<ModelMigrateResult> {
  if (migrating.has(engine)) {
    return { ok: false, engine, movedFiles: 0, movedBytes: 0, error: 'A relocation for this engine is already running.' }
  }
  migrating.add(engine)
  abortFlags.set(engine, false)
  invalidateUsageCache()
  try {
    const layout = MODEL_ENGINES[engine]
    const newBase = engineNewBase(engine)

    // Sources = every root that is NOT the current target: the userData dir AND
    // any previously-used storage root. Walked in search order, first holder of
    // a given relPath wins, so a file present in two old roots is moved once.
    const sourceBases = engineFallbackBases(engine)
    const originOf = new Map<string, string>() // relPath -> the base holding it
    const sources: MigrationSource[] = []
    for (const base of sourceBases) {
      for (const f of walkEngineFiles(base, layout)) {
        if (originOf.has(f.relPath)) continue
        originOf.set(f.relPath, base)
        sources.push(f)
      }
    }
    if (sources.length === 0) {
      pushMigrate(win, { engine, phase: 'skip', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, message: 'Nothing to move.' })
      return { ok: true, engine, movedFiles: 0, movedBytes: 0, skipped: true }
    }

    // Files still needing a copy. "Already there" means a real file of the same
    // size — never bare existence (see destSatisfies): anything less and this
    // resume check would hand the delete phase a source with no verified copy.
    const srcOf = (relPath: string): string =>
      join(originOf.get(relPath) ?? engineLegacyBase(engine), ...relPath.split('/'))
    const dstOf = (relPath: string): string => join(newBase, ...relPath.split('/'))
    const toCopy = sources.filter(f => !destSatisfies(srcOf(f.relPath), dstOf(f.relPath)))
    const plan = planMigration(toCopy)

    // ── Preflight (fail-closed) ──
    pushMigrate(win, { engine, phase: 'preflight', filesDone: 0, filesTotal: plan.fileCount, bytesDone: 0, bytesTotal: plan.totalBytes, message: 'Checking destination…' })
    if (!ensureWritable(newBase)) {
      const error = `Destination is not writable: ${newBase}. Pick a different Storage folder and try again.`
      pushMigrate(win, { engine, phase: 'error', filesDone: 0, filesTotal: plan.fileCount, bytesDone: 0, bytesTotal: plan.totalBytes, error })
      return { ok: false, engine, movedFiles: 0, movedBytes: 0, error }
    }
    // SAME-VOLUME move = pure renames: instant, and it needs NO free space at
    // the destination because not one byte is duplicated. Only a CROSS-volume
    // move has to copy, and only those bytes have to clear the disk gate.
    // Probed per SOURCE root (they can sit on different drives), by attempting a
    // rename rather than parsing drive letters — so the slow-but-correct path is
    // taken whenever we are not certain.
    const renameOkCache = new Map<string, boolean>()
    const canRenameFrom = (base: string): boolean => {
      let v = renameOkCache.get(base)
      if (v === undefined) { v = sameVolume(base, newBase); renameOkCache.set(base, v) }
      return v
    }
    const copyBytes = toCopy
      .filter(f => !canRenameFrom(originOf.get(f.relPath) ?? newBase))
      .reduce((s, f) => s + (f.bytes > 0 ? f.bytes : 0), 0)
    if (copyBytes > 0) {
      const need = requiredFreeBytes(copyBytes)
      const free = freeDiskBytes(newBase)
      if (free < need) {
        const error = `Not enough free space at the destination — need ~${Math.ceil(need / 1e9)} GB free, have ~${Math.floor(free / 1e9)} GB.`
        pushMigrate(win, { engine, phase: 'error', filesDone: 0, filesTotal: plan.fileCount, bytesDone: 0, bytesTotal: plan.totalBytes, error })
        return { ok: false, engine, movedFiles: 0, movedBytes: 0, error }
      }
    }

    // ── Copy phase (verified, atomic-rename per file, abort-checked) ──
    const copySteps = plan.steps.filter(s => s.kind === 'copy')
    const writtenThisRun: string[] = [] // COPIED dest paths — deleted on rollback
    // RENAMED files this run. A rename already consumed its source, so undoing
    // one means renaming it BACK, never deleting it — deleting here would
    // destroy the only copy of the data. Kept separate from writtenThisRun for
    // exactly that reason.
    const renamedThisRun: Array<{ src: string; dst: string }> = []
    const rollback = (): void => {
      for (const p of writtenThisRun) { try { rmSync(p, { force: true }) } catch { /* ignore */ } }
      for (const r of renamedThisRun) {
        try { mkdirSync(dirname(r.src), { recursive: true }); renameSync(r.dst, r.src) } catch { /* ignore */ }
      }
    }
    let filesDone = 0
    let bytesDone = 0
    for (const step of copySteps) {
      if (abortFlags.get(engine)) {
        // Undo everything THIS run produced so neither root is left holding a
        // half-moved item (a piper voice whose .onnx moved but whose .onnx.json
        // did not resolves to a path that does not exist). Sources end up
        // exactly as they started: no file is lost by cancelling.
        rollback()
        pushMigrate(win, { engine, phase: 'aborted', filesDone, filesTotal: plan.fileCount, bytesDone, bytesTotal: plan.totalBytes, message: 'Move cancelled — no files were deleted.' })
        return { ok: false, engine, movedFiles: 0, movedBytes: 0, aborted: true }
      }
      const relParts = step.relPath.split('/')
      const srcBase = originOf.get(step.relPath) ?? engineLegacyBase(engine)
      const src = join(srcBase, ...relParts)
      const dst = join(newBase, ...relParts)
      const tmp = `${dst}.migrating`
      pushMigrate(win, { engine, phase: 'copy', filesDone, filesTotal: plan.fileCount, bytesDone, bytesTotal: plan.totalBytes, currentFile: step.relPath })
      try {
        mkdirSync(dirname(dst), { recursive: true })
        let renamed = false
        if (canRenameFrom(srcBase)) {
          // Same volume: one atomic metadata operation. There is no instant at
          // which the bytes do not exist under one of the two names, so this is
          // strictly safer than copy-then-delete as well as ~instant.
          try {
            renameSync(src, dst)
            renamedThisRun.push({ src, dst })
            renamed = true
          } catch { /* fall through to copy-verify-delete for this file */ }
        }
        if (!renamed) {
          try { rmSync(tmp, { force: true }) } catch { /* stale temp from a prior abort */ }
          copyFileSync(src, tmp)
          // VERIFY before it counts as copied — size equality (the source was
          // already SHA-verified at download; a full re-hash of multi-GB files
          // would dominate the move time).
          const srcSize = fileBytes(src)
          const tmpSize = fileBytes(tmp)
          if (tmpSize !== srcSize || srcSize === 0 && step.bytes > 0) {
            try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
            throw new Error(`verify failed for ${step.relPath} (${tmpSize} != ${srcSize} bytes)`)
          }
          renameSync(tmp, dst) // atomic, same device
          writtenThisRun.push(dst)
        }
      } catch (err) {
        // Undo this run's output; every source ends up back where it started.
        try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
        rollback()
        const error = `Copy failed: ${err instanceof Error ? err.message : String(err)}. No files were deleted.`
        pushMigrate(win, { engine, phase: 'error', filesDone, filesTotal: plan.fileCount, bytesDone, bytesTotal: plan.totalBytes, error })
        return { ok: false, engine, movedFiles: filesDone, movedBytes: bytesDone, error }
      }
      filesDone++
      bytesDone += step.bytes
      pushMigrate(win, { engine, phase: 'copy', filesDone, filesTotal: plan.fileCount, bytesDone, bytesTotal: plan.totalBytes, currentFile: step.relPath })
    }

    // ── Delete phase (all sources are now verified at the destination) ──
    pushMigrate(win, { engine, phase: 'delete', filesDone: plan.fileCount, filesTotal: plan.fileCount, bytesDone: plan.totalBytes, bytesTotal: plan.totalBytes, message: 'Removing originals…' })
    for (const f of sources) {
      const src = srcOf(f.relPath)
      if (!existsSync(src)) continue // already consumed by a rename
      // LAST GATE before an irreversible delete: prove the destination really
      // holds this file. A source is never removed on the strength of the plan
      // alone — only on the strength of what is actually on disk.
      if (!destSatisfies(src, dstOf(f.relPath))) continue
      try { rmSync(src, { force: true }) } catch { /* best-effort; a locked file lingers harmlessly */ }
    }
    for (const base of sourceBases) pruneEmptyDirs(base)

    invalidateUsageCache()
    const movedBytes = plan.totalBytes
    pushMigrate(win, { engine, phase: 'done', filesDone: plan.fileCount, filesTotal: plan.fileCount, bytesDone: movedBytes, bytesTotal: movedBytes, message: 'Done.' })
    return { ok: true, engine, movedFiles: plan.fileCount, movedBytes }
  } finally {
    migrating.delete(engine)
    abortFlags.delete(engine)
  }
}

/** Relocate several engines in sequence. Stops at the first hard error but
 *  keeps whatever earlier engines already moved. */
export async function migrateEngines(engines: ModelEngineId[], win: BrowserWindow | null): Promise<ModelMigrateResult[]> {
  const results: ModelMigrateResult[] = []
  for (const e of engines) {
    const r = await migrateEngine(e, win)
    results.push(r)
    if (!r.ok && !r.skipped && !r.aborted) break
    if (r.aborted) break
  }
  return results
}

/** Remove now-empty directories under (but not including) `base`. */
function pruneEmptyDirs(base: string): void {
  const rec = (d: string): void => {
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      const p = join(d, name)
      try { if (statSync(p).isDirectory()) rec(p) } catch { continue }
    }
    try {
      // rmSync on a directory needs `recursive` even when empty (else EISDIR);
      // we only reach here once the dir has no remaining entries.
      if (readdirSync(d).length === 0 && d !== base) rmSync(d, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  try { if (existsSync(base)) rec(base) } catch { /* ignore */ }
}
