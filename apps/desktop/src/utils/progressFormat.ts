// apps/desktop/src/utils/progressFormat.ts
//
// Tiny, dependency-free formatters for download-progress UI:
//   - fmtBytesPerSec(5_300_000) -> "5.1 MB/s"
//   - fmtEta(80)                -> "1m 20s"
//
// Used by the local-engine install/download progress lines (MediaPage) where
// the main process now emits speedBytesPerSec / etaSec alongside percent.
// Pure functions — safe to unit-test and reuse anywhere in the renderer.

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/**
 * Human-readable transfer rate. Returns '' for non-positive / non-finite input
 * so callers can omit the segment entirely.
 */
export function fmtBytesPerSec(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return ''
  if (bytesPerSec >= GB) return `${(bytesPerSec / GB).toFixed(1)} GB/s`
  if (bytesPerSec >= MB) return `${(bytesPerSec / MB).toFixed(1)} MB/s`
  if (bytesPerSec >= KB) return `${(bytesPerSec / KB).toFixed(0)} KB/s`
  return `${Math.round(bytesPerSec)} B/s`
}

/**
 * Human-readable ETA from a seconds count. Returns '' for non-positive /
 * non-finite input (e.g. the tracker's -1 "unknown" sentinel).
 *   45    -> "45s"
 *   80    -> "1m 20s"
 *   7325  -> "2h 2m"
 */
export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`
}
