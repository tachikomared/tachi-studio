// apps/desktop/electron/services/util/download-progress.ts
//
// Aggregate progress tracker for N parallel file downloads.
//
// Motivation: Flux and Wan model downloads consist of 4-5 separate component
// files that download simultaneously.  Each file reports its own (bytes,
// total) tick; this class merges them into a single combined progress snapshot
// suitable for the IPC `push()` helpers in sd-cpp-installer.ts / piper-installer.ts.
//
// Usage:
//   const tracker = new DownloadProgressTracker([
//     { id: 'diffusion', totalBytes: 6_700_000_000 },
//     { id: 'vae',       totalBytes:    84_000_000 },
//     { id: 'clip_l',    totalBytes:   246_000_000 },
//     { id: 't5xxl',     totalBytes: 9_200_000_000 },
//   ])
//   // In each file's onChunk callback:
//   tracker.tick('diffusion', receivedBytes, totalBytes)
//   const snap = tracker.snapshot()
//   push(win, { stage: 'downloading-model', percent: snap.percent, ... })
//
// The tracker is a pure data structure — no I/O, no timers.
// Callers are responsible for feeding ticks from their download callbacks.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileEntry {
  /** Stable identifier for this file within the download set. */
  id: string
  /**
   * Expected total byte size.  Pass 0 or omit when unknown at construction
   * time and the real value will be filled in on the first `tick` call.
   */
  totalBytes?: number
}

export interface ProgressSnapshot {
  /** Combined bytes received across all tracked files. */
  receivedBytes: number
  /** Combined expected total bytes (0 when completely unknown). */
  totalBytes: number
  /**
   * 0–100 overall percent, or -1 when totalBytes is unknown.
   * Capped at 100.
   */
  percent: number
  /**
   * Instantaneous download speed in bytes/sec computed from the rolling
   * window.  0 until at least two ticks have been recorded.
   */
  speedBytesPerSec: number
  /**
   * Estimated seconds to completion.  -1 when speed is 0 or total unknown.
   */
  etaSec: number
}

// ─── Implementation ───────────────────────────────────────────────────────────

/** Rolling window size for speed calculation (number of tick samples). */
const SPEED_WINDOW = 8

interface _FileState {
  id: string
  received: number
  total: number
}

interface _SpeedSample {
  /** Timestamp in ms. */
  ts: number
  /** Cumulative received bytes at this sample point. */
  cumulative: number
}

/**
 * Tracks combined progress for a fixed set of concurrent file downloads.
 *
 * Thread-safety: single-threaded Node.js main process — no locks needed.
 */
export class DownloadProgressTracker {
  private readonly _files = new Map<string, _FileState>()
  private readonly _speedWindow: _SpeedSample[] = []

  /**
   * @param files  Initial file list.  `totalBytes` may be 0 / absent when
   *               the size is unknown at construction time.
   */
  constructor(files: FileEntry[]) {
    for (const f of files) {
      this._files.set(f.id, { id: f.id, received: 0, total: f.totalBytes ?? 0 })
    }
  }

  /**
   * Register a byte-count update for the file identified by `id`.
   *
   * `receivedBytes` is the CUMULATIVE count received so far for this file
   * (not a delta) — consistent with how sd-cpp-installer and piper-installer
   * fire their `onChunk(received, total)` callbacks.
   *
   * If `totalBytes` is provided and larger than the stored value, the stored
   * value is updated (handles late Content-Length resolution).
   *
   * Silently ignores unknown ids to avoid crashes from race-condition ticks
   * after the tracker has been discarded.
   */
  tick(id: string, receivedBytes: number, totalBytes?: number): void {
    const state = this._files.get(id)
    if (!state) return
    state.received = receivedBytes
    if (totalBytes && totalBytes > state.total) state.total = totalBytes
    // Record speed sample.
    const cumulative = this._totalReceived()
    const now = Date.now()
    this._speedWindow.push({ ts: now, cumulative })
    if (this._speedWindow.length > SPEED_WINDOW) this._speedWindow.shift()
  }

  /**
   * Compute and return a combined progress snapshot.
   * Safe to call at any time, including before any ticks.
   */
  snapshot(): ProgressSnapshot {
    const receivedBytes = this._totalReceived()
    const totalBytes    = this._totalExpected()
    const percent       = totalBytes > 0 ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : -1
    const speedBytesPerSec = this._speed()
    const remaining     = totalBytes > 0 ? totalBytes - receivedBytes : -1
    const etaSec        = speedBytesPerSec > 0 && remaining >= 0
      ? Math.ceil(remaining / speedBytesPerSec)
      : -1

    return { receivedBytes, totalBytes, percent, speedBytesPerSec, etaSec }
  }

  /**
   * Reset progress for a single file, e.g. when a download is retried.
   * Does NOT clear the speed window — speeds are aggregate.
   */
  reset(id: string): void {
    const state = this._files.get(id)
    if (state) { state.received = 0 }
  }

  /**
   * Replace or add a file entry.  Use when the file list is not fully known
   * at construction time (e.g., manifest-driven installs).
   */
  upsert(file: FileEntry): void {
    const existing = this._files.get(file.id)
    if (existing) {
      if (file.totalBytes && file.totalBytes > existing.total) existing.total = file.totalBytes
    } else {
      this._files.set(file.id, { id: file.id, received: 0, total: file.totalBytes ?? 0 })
    }
  }

  /** Number of files being tracked. */
  get fileCount(): number { return this._files.size }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _totalReceived(): number {
    let sum = 0
    for (const s of this._files.values()) sum += s.received
    return sum
  }

  private _totalExpected(): number {
    let sum = 0
    let hasZero = false
    for (const s of this._files.values()) {
      if (s.total === 0) { hasZero = true }
      sum += s.total
    }
    // If ANY file has an unknown total, report 0 (percent will be -1).
    return hasZero ? 0 : sum
  }

  /**
   * Rolling-window speed estimate.
   * Returns 0 when fewer than 2 samples are available.
   */
  private _speed(): number {
    if (this._speedWindow.length < 2) return 0
    const oldest = this._speedWindow[0]
    const newest = this._speedWindow[this._speedWindow.length - 1]
    const dtMs   = newest.ts - oldest.ts
    if (dtMs <= 0) return 0
    const db = newest.cumulative - oldest.cumulative
    return Math.max(0, Math.floor((db / dtMs) * 1000))
  }
}

// ─── Factory helper ───────────────────────────────────────────────────────────

/**
 * Convenience factory that creates a `DownloadProgressTracker` pre-populated
 * from a list of `{ role, sizeMb }` records (the sd-cpp model component shape).
 *
 * Example:
 *   const tracker = trackerFromSdFiles(model.files)
 *   // inside downloadFrom callback:
 *   tracker.tick(f.role, received, total)
 */
export function trackerFromSdFiles(
  files: ReadonlyArray<{ role: string; sizeMb: number }>,
): DownloadProgressTracker {
  return new DownloadProgressTracker(
    files.map(f => ({ id: f.role, totalBytes: Math.round(f.sizeMb * 1_048_576) })),
  )
}
