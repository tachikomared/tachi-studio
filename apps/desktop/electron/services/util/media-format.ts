// apps/desktop/electron/services/util/media-format.ts
//
// Best-per-resolution format picker for yt-dlp `--dump-json` output (STEAL
// 2026-06-21 #8, reclip app.py). yt-dlp returns dozens of formats per URL; the
// UI only wants one clean choice per resolution. Pure + testable.

export interface YtDlpFormat {
  format_id: string
  ext?: string
  height?: number | null
  vcodec?: string
  acodec?: string
  /** Total bitrate — the tie-breaker within a resolution. */
  tbr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
}

export interface PickedFormat {
  id: string
  /** e.g. "1080p · mp4 · ~45.2MB" */
  label: string
  height: number
}

function fmtSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `~${(mb / 1024).toFixed(1)}GB` : `~${mb.toFixed(1)}MB`
}

/** One best (highest-bitrate) video format per resolution, highest resolution first. */
export function pickBestFormats(formats: YtDlpFormat[]): PickedFormat[] {
  const byHeight = new Map<number, YtDlpFormat>()
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none') continue // skip audio-only
    const h = f.height ?? 0
    if (h <= 0) continue                            // skip height-less
    const cur = byHeight.get(h)
    if (!cur || (f.tbr ?? 0) > (cur.tbr ?? 0)) byHeight.set(h, f)
  }
  return [...byHeight.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map(f => {
      const size = fmtSize(f.filesize ?? f.filesize_approx)
      const label = [`${f.height}p`, f.ext, size].filter(Boolean).join(' · ')
      return { id: f.format_id, label, height: f.height ?? 0 }
    })
}
