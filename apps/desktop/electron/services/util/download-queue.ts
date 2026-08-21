// apps/desktop/electron/services/util/download-queue.ts
//
// PURE helpers for the resumable download manager (UX-benchmark #11).
// No electron / fs / net imports — everything I/O-shaped is injected — so the
// task-state maths, the persistence (de)serialization, and the HuggingFace
// resolve-URL parser are unit-testable exactly like installer-kit's
// disk-preflight helpers are (test/unit/downloadQueue.test.ts).
//
// The stateful orchestrator that USES these lives in
// ../download-manager.ts (electron main).

// ─── Wire/state types ─────────────────────────────────────────────────────────

/**
 * Every consumer routed through the central manager registers its kind here —
 * llama.cpp GGUF weights (curated + by-URL), sd.cpp checkpoint components,
 * piper ONNX voices and whisper ggml models.
 * The persistence parser and the strip both key off this list; extending it is
 * a one-line change.
 *
 * NOTE: 'goose-binary' was removed with the Goose harness. A persisted download
 * row of that kind simply fails isDownloadKind() and is dropped on restore —
 * see the parser below, which skips unrecognised kinds instead of throwing.
 */
export const DOWNLOAD_KINDS = [
  'gguf-model',
  'gguf-url',
  'sd-model',
  'piper-voice',
  'whisper-model',
] as const

export type DownloadKind = typeof DOWNLOAD_KINDS[number]

export function isDownloadKind(v: unknown): v is DownloadKind {
  return typeof v === 'string' && (DOWNLOAD_KINDS as readonly string[]).includes(v)
}

export type DownloadItemState =
  | 'queued'
  | 'active'
  | 'paused'
  | 'verifying'
  | 'done'
  | 'error'

export type DownloadErrorCode =
  | 'DISK_FULL'
  | 'CHECKSUM_MISMATCH'
  | 'SIZE_MISMATCH'
  /** The server would not continue the partial (200 to a Range request, or a
   *  206 starting at the wrong offset). The `.part` is intact and untouched. */
  | 'RANGE_IGNORED'
  | 'NETWORK'
  | 'CANCELLED'
  /** The storage root moved while this download was paused, and its partial
   *  could not be brought to the new root (cross-volume rename). The `.part`
   *  is untouched at the OLD path — the message names both. */
  | 'STORAGE_MOVED'

export type DownloadVerification = 'sha256' | 'size' | 'none'

/** What a download task looks like on the wire (IPC list / changed events). */
export interface DownloadItemSnapshot {
  id: string
  name: string
  kind: DownloadKind
  state: DownloadItemState
  receivedBytes: number
  /** Best-known total: response headers > exact expected > approx registry size. 0 = unknown. */
  totalBytes: number
  /** 0..100, or -1 when the total is unknown. */
  percent: number
  speedBytesPerSec: number
  etaSec: number
  error?: string
  errorCode?: DownloadErrorCode
  /** How completion was ACTUALLY checked — never claim more than was done. */
  verified?: DownloadVerification
  /** Streaming sha256 observed after completion (always computed). */
  observedSha256?: string
  updatedAt: number
}

// ─── Percent ──────────────────────────────────────────────────────────────────

/** 0..100 clamped, or -1 when total is unknown/absurd. */
export function percentOf(receivedBytes: number, totalBytes: number): number {
  if (!(totalBytes > 0)) return -1
  return Math.min(100, Math.floor((receivedBytes / totalBytes) * 100))
}

// ─── Persistence shape ────────────────────────────────────────────────────────
//
// userData/downloads.json — the queue + enough spec to resume after an app
// restart. Offsets are NOT trusted from JSON: the .part file's on-disk size is
// the single source of truth for the resume byte (the caller stats it).

export const DOWNLOADS_PERSIST_VERSION = 1

export interface PersistedDownload {
  id: string
  name: string
  kind: DownloadKind
  url: string
  destPath: string
  partPath: string
  expectedSha256?: string
  /** Exact expected size (HF LFS), used for verification + preflight. */
  expectedBytes?: number
  /** Approximate size (registry sizeMb), display + preflight only. */
  approxTotalBytes?: number
  /** Full-file total learned from response headers on a previous run. */
  headerTotalBytes?: number
  /** Only 'paused' | 'error' are ever persisted (active/queued → paused). */
  state: 'paused' | 'error'
  error?: string
  errorCode?: DownloadErrorCode
}

export interface PersistedDownloadsFile {
  version: number
  tasks: PersistedDownload[]
}

/** A serializable subset of a live task (the manager maps its tasks into this). */
export interface SerializableTask {
  id: string
  name: string
  kind: DownloadKind
  url: string
  destPath: string
  partPath: string
  expectedSha256?: string
  expectedBytes?: number
  approxTotalBytes?: number
  headerTotalBytes?: number
  state: DownloadItemState
  error?: string
  errorCode?: DownloadErrorCode
}

/**
 * Shape live tasks into the persisted file. Rules:
 *   - done tasks are dropped (nothing to restore),
 *   - active / verifying / queued become 'paused' — the SAFE restart default is
 *     "wait for the user's RESUME click on the strip", never auto-network,
 *   - paused / error persist as-is.
 */
export function serializeDownloads(tasks: SerializableTask[]): PersistedDownloadsFile {
  const out: PersistedDownload[] = []
  for (const t of tasks) {
    if (t.state === 'done') continue
    out.push({
      id: t.id,
      name: t.name,
      kind: t.kind,
      url: t.url,
      destPath: t.destPath,
      partPath: t.partPath,
      expectedSha256: t.expectedSha256,
      expectedBytes: t.expectedBytes,
      approxTotalBytes: t.approxTotalBytes,
      headerTotalBytes: t.headerTotalBytes,
      state: t.state === 'error' ? 'error' : 'paused',
      error: t.state === 'error' ? t.error : undefined,
      errorCode: t.state === 'error' ? t.errorCode : undefined,
    })
  }
  return { version: DOWNLOADS_PERSIST_VERSION, tasks: out }
}

/**
 * Parse + validate the persisted file. Returns [] on any malformation —
 * a corrupt state file must never brick startup.
 */
export function parsePersistedDownloads(rawJson: string): PersistedDownload[] {
  try {
    const parsed = JSON.parse(rawJson) as Partial<PersistedDownloadsFile> | null
    if (!parsed || parsed.version !== DOWNLOADS_PERSIST_VERSION || !Array.isArray(parsed.tasks)) return []
    const out: PersistedDownload[] = []
    for (const t of parsed.tasks) {
      if (!t || typeof t !== 'object') continue
      const { id, name, kind, url, destPath, partPath, state } = t as PersistedDownload
      if (typeof id !== 'string' || !id) continue
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) continue
      if (typeof destPath !== 'string' || !destPath) continue
      if (typeof partPath !== 'string' || !partPath) continue
      if (!isDownloadKind(kind)) continue
      if (state !== 'paused' && state !== 'error') continue
      out.push({
        id,
        name: typeof name === 'string' && name ? name : id,
        kind,
        url,
        destPath,
        partPath,
        expectedSha256: typeof t.expectedSha256 === 'string' && /^[0-9a-f]{64}$/i.test(t.expectedSha256) ? t.expectedSha256 : undefined,
        expectedBytes: typeof t.expectedBytes === 'number' && t.expectedBytes > 0 ? t.expectedBytes : undefined,
        approxTotalBytes: typeof t.approxTotalBytes === 'number' && t.approxTotalBytes > 0 ? t.approxTotalBytes : undefined,
        headerTotalBytes: typeof t.headerTotalBytes === 'number' && t.headerTotalBytes > 0 ? t.headerTotalBytes : undefined,
        state,
        error: typeof t.error === 'string' ? t.error : undefined,
        errorCode: t.errorCode,
      })
    }
    return out
  } catch {
    return []
  }
}

// ─── HuggingFace resolve-URL parsing ─────────────────────────────────────────
//
// https://huggingface.co/{owner}/{repo}/resolve/{revision}/{path...}
// The LFS oid for such a file (fetched via the paths-info API) IS its sha256 —
// the download manager uses it for post-download integrity when the caller
// didn't supply a checksum.

export interface HfResolveRef {
  /** "{owner}/{repo}" */
  repoId: string
  revision: string
  /** Path inside the repo (decoded, '/'-joined). */
  path: string
}

export function parseHfResolveUrl(rawUrl: string): HfResolveRef | null {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return null
    const h = u.hostname.toLowerCase()
    const isHf = h === 'huggingface.co' || h.endsWith('.huggingface.co') || h === 'hf.co' || h.endsWith('.hf.co')
    if (!isHf) return null
    const segs = u.pathname.split('/').filter(Boolean)
    // Expect exactly [owner, repo, 'resolve', revision, ...path]
    if (segs.length < 5 || segs[2] !== 'resolve') return null
    const path = segs.slice(4).map(s => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
    if (!path) return null
    let revision = segs[3]
    try { revision = decodeURIComponent(revision) } catch { /* keep raw */ }
    return { repoId: `${segs[0]}/${segs[1]}`, revision, path }
  } catch {
    return null
  }
}

/** True for a well-formed lowercase/uppercase hex sha256. */
export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)
}

// ─── Managed-download failure classification ─────────────────────────────────
//
// Installers route model files through runManagedDownload() but keep their
// proven legacy download path as a SAFETY NET: if the manager fails in an
// unexpected way, the install falls back rather than breaking. Rejections that
// carry one of these codes are DELIBERATE outcomes (user pause/cancel, disk
// preflight, integrity verdicts) — falling back would override the user's
// intent or re-download a file the manager just proved bad, so they propagate.

const CODED_REJECTS: ReadonlySet<string> = new Set([
  'PAUSED',
  'CANCELLED',
  'DISK_FULL',
  'CHECKSUM_MISMATCH',
  'SIZE_MISMATCH',
  // LOAD-BEARING. The legacy fallback writes the SAME .part on the SAME
  // resumableDownload primitive, so letting a RANGE_IGNORED refusal decay to
  // it would just re-ask the question that was already answered — and the
  // refusal exists precisely to stop that answer from truncating the partial.
  'RANGE_IGNORED',
])

/**
 * True when a runManagedDownload rejection should trigger the installer's
 * legacy direct-download fallback (uncoded error → network failure or a
 * manager bug); false when it is a deliberate, user-meaningful outcome that
 * must propagate unchanged.
 */
export function shouldFallBackToLegacyDownload(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return !(typeof code === 'string' && CODED_REJECTS.has(code))
}

// ─── Managed-download ids for sd.cpp components ──────────────────────────────
//
// An sd.cpp "model" is a SET of component files, each its own managed
// download. The id is `sd:<modelId>:<role>`, which makes STOP a prefix sweep
// over `sd:<modelId>:` — the trailing colon is load-bearing: without it
// `sd:sd15` would also match `sd15-inpaint`'s tasks and pause a download the
// user never asked to stop.

/** Managed-download id for one sd.cpp model component file. */
export function sdManagedId(modelId: string, role: string): string {
  return `sd:${modelId}:${role}`
}

/** Prefix matching EVERY component task of one sd.cpp model (Stop / lookup). */
export function sdManagedIdPrefix(modelId: string): string {
  return `sd:${modelId}:`
}

// ─── Human size labels → bytes ────────────────────────────────────────────────

/**
 * Parse a human size label like "~75 MB", "142MB", "~1.5 GB" into approximate
 * bytes for disk preflight + strip display. Returns undefined on anything it
 * cannot parse — callers then simply run without a size estimate.
 */
export function approxBytesFromSizeLabel(label: unknown): number | undefined {
  if (typeof label !== 'string') return undefined
  const m = /([\d.]+)\s*(kb|mb|gb|tb)/i.exec(label)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  const mult = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[m[2].toLowerCase() as 'kb' | 'mb' | 'gb' | 'tb']
  return Math.round(n * mult)
}
