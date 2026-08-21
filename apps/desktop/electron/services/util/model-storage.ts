// apps/desktop/electron/services/util/model-storage.ts
//
// PURE core for the model-weight storage dashboard + relocation feature
// (USER-PAINS T5+T6 — Ollama users' 2-100 GB C:-drive pain). No electron, no
// fs — only data-in / data-out so every rule here is unit-testable headless
// (test/unit/storageDashboard.test.ts).
//
// Three tested units live here:
//   1. planMigration     — a flat file list -> an ordered, abort-safe step plan
//   2. firstExisting     — the dual-root resolver ORDER (new root first, legacy
//                          fallback), existence injected
//   3. sumBytes / hasEnoughFreeSpace — size aggregation + the fail-closed
//                          low-disk gate (need size * 1.1 free)
//
// The impure orchestration (fs walking, copy-verify-delete, progress events,
// writability probe) lives in services/model-storage.ts and leans on these.

/** The four local inference engines that park weights under userData today. */
export type ModelEngineId = 'llama' | 'sd' | 'whisper' | 'piper'

export const MODEL_ENGINE_IDS: readonly ModelEngineId[] = ['llama', 'sd', 'whisper', 'piper']

/** How an engine lays each model out on disk. */
export interface ModelEngineLayout {
  id: ModelEngineId
  /**
   * 'file' — each model is ONE flat file, gated by `ext` (llama `.gguf`,
   *          whisper `.bin`); the item id is the basename minus the extension.
   * 'dir'  — each model is a SUBDIRECTORY of the base (sd component sets,
   *          piper voices); the item id is the subdir name.
   */
  itemKind: 'file' | 'dir'
  /** For 'file' engines: only names ending with this (lowercased) count. */
  ext?: string
  /** Subfolder name under `<storage root>/Models/`. */
  subdir: string
  /** Human label for the dashboard section header. */
  label: string
}

export const MODEL_ENGINES: Record<ModelEngineId, ModelEngineLayout> = {
  llama:   { id: 'llama',   itemKind: 'file', ext: '.gguf', subdir: 'llama',   label: 'llama.cpp (GGUF)' },
  sd:      { id: 'sd',      itemKind: 'dir',                subdir: 'sd',      label: 'Stable Diffusion' },
  whisper: { id: 'whisper', itemKind: 'file', ext: '.bin',  subdir: 'whisper', label: 'Whisper (STT)' },
  piper:   { id: 'piper',   itemKind: 'dir',                subdir: 'piper',   label: 'Piper (voices)' },
}

// ─── Partial-download naming (LANE U) ────────────────────────────────────────
//
// A download lands with `renameSync(partPath, destPath)`. `rename(2)` /
// MoveFile cannot cross devices — it throws EXDEV — so the partial file MUST
// sit in the SAME DIRECTORY as its final path. Deriving one from the other
// makes that structural instead of a convention four installers have to
// remember: once the weights target `<storage root>/Models/<engine>/` on D:,
// a `.part` left behind in `%APPDATA%\<engine>\downloads\` on C: would (a)
// write the whole multi-GB payload to the drive we are trying to spare and
// (b) fail the landing rename.

/** Suffix appended to a final weight path to name its partial download. */
export const PART_SUFFIX = '.part'

/**
 * The partial-download path for a final weight path — same directory, always.
 *
 * The suffix is appended (never substituted) so the `.part` never satisfies an
 * engine's extension gate: `phi.gguf.part` does not end with `.gguf`, so an
 * in-flight download is invisible to listEngineItemIds / walkEngineFiles and
 * can never be listed as a model or swept up by a relocation.
 */
export function partPathFor(finalPath: string): string {
  return `${finalPath}${PART_SUFFIX}`
}

/** True when `name` is a partial download rather than a finished weight. */
export function isPartFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PART_SUFFIX)
}

/** A single file to migrate: path RELATIVE to the engine's source base + size. */
export interface MigrationFile { relPath: string; bytes: number }

export type MigrationStepKind = 'copy' | 'delete-src'

export interface MigrationStep {
  kind: MigrationStepKind
  /** Path relative to the engine base (identical on the source and dest side). */
  relPath: string
  bytes: number
}

export interface MigrationPlan {
  steps: MigrationStep[]
  fileCount: number
  totalBytes: number
}

/**
 * Build a deterministic, abort-safe migration plan from a flat file list.
 *
 * INVARIANT (structural, asserted by the tests): every `copy` step precedes
 * every `delete-src` step. The delete phase only begins once ALL files are
 * copied + verified at the destination — so:
 *   - an abort DURING the copy phase deletes zero sources (originals intact);
 *   - an abort DURING the delete phase means every file already landed at the
 *     destination and was verified, so the deletes are pure cleanup.
 * This is the "never delete before a verified copy" guarantee at the plan level.
 *
 * Steps are ordered by `relPath` so the plan is stable across runs (resumable).
 */
export function planMigration(files: MigrationFile[]): MigrationPlan {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  )
  const copy: MigrationStep[] = sorted.map(f => ({ kind: 'copy' as const, relPath: f.relPath, bytes: f.bytes }))
  const del:  MigrationStep[] = sorted.map(f => ({ kind: 'delete-src' as const, relPath: f.relPath, bytes: f.bytes }))
  return {
    steps: [...copy, ...del],
    fileCount: sorted.length,
    totalBytes: sorted.reduce((s, f) => s + (f.bytes > 0 ? f.bytes : 0), 0),
  }
}

/**
 * The dual-root resolver ORDER: return the first candidate that exists, else
 * null. Callers pass `[newPath, legacyPath]` so a weight is read from the
 * storage-root location first and the userData location only as a fallback —
 * mirroring the design-audio dual-root pattern. Existence is injected so this
 * is pure.
 */
export function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) {
    if (exists(c)) return c
  }
  return null
}

/** Sum item sizes (per-engine total, grand total). Negative/NaN sizes ignored. */
export function sumBytes(items: ReadonlyArray<{ bytes: number }>): number {
  return items.reduce((s, i) => s + (Number.isFinite(i.bytes) && i.bytes > 0 ? i.bytes : 0), 0)
}

/**
 * Fail-closed low-disk gate: a relocation needs the payload size PLUS a 10 %
 * headroom free at the destination before the first byte is copied (temp files,
 * fs slack). Returns false when `freeBytes` can't cover `requiredBytes * 1.1`.
 */
export function hasEnoughFreeSpace(requiredBytes: number, freeBytes: number): boolean {
  if (requiredBytes <= 0) return true
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return false
  return freeBytes >= Math.ceil(requiredBytes * 1.1)
}

/** The byte budget a relocation must clear (payload + 10 % headroom). */
export function requiredFreeBytes(payloadBytes: number): number {
  return Math.ceil(Math.max(0, payloadBytes) * 1.1)
}

/** Human-readable byte size (dashboard + progress). Pure, locale-free. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  const rounded = v >= 100 || u === 0 ? Math.round(v) : Math.round(v * 10) / 10
  return `${rounded} ${units[u]}`
}
