// apps/desktop/electron/services/util/yt-dlp-progress.ts
//
// Parser for yt-dlp's `--newline` progress output (STEAL 2026-06-21 #8). Mirrors
// sd-progress-parser's shape: a pure line parser + a feed() class that buffers
// partial lines and tracks the destination. yt-dlp prints lines like:
//   [download]  42.3% of  123.45MiB at  1.23MiB/s ETA 00:42
//   [download] 100% of 10.00MiB in 00:03
//   [download]   0.0% of ~123.45MiB at  Unknown B/s ETA Unknown
//   [download] Destination: C:\videos\clip.mp4

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
const SIZE = '[\\d.]+\\s*[KMGT]?i?B'

export interface YtDlpProgress {
  /** 0-100, or -1 when unknown (e.g. a Destination line). */
  percent: number
  /** Total size token, e.g. "123.45MiB" (approximate "~" stripped). */
  total?: string
  /** Transfer speed token, e.g. "1.23MiB/s" — omitted when yt-dlp prints "Unknown". */
  speed?: string
  /** ETA token, e.g. "00:42" — omitted when "Unknown". */
  eta?: string
  /** Present only on a "Destination:" line. */
  destination?: string
  /** The cleaned (ANSI-stripped) source line. */
  message: string
}

export function parseYtDlpLine(line: string): YtDlpProgress | null {
  const clean = line.replace(ANSI_RE, '').trim()
  if (!clean) return null

  const dest = /^\[download\]\s+Destination:\s*(.+)$/.exec(clean)
  if (dest) return { percent: -1, destination: dest[1]!.trim(), message: clean }

  const pct = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(clean)
  if (!pct) return null
  const percent = Math.min(100, Math.max(0, Math.round(parseFloat(pct[1]!))))
  const total = new RegExp(`of\\s+~?\\s*(${SIZE})`, 'i').exec(clean)?.[1]?.replace(/\s+/g, '')
  const speed = new RegExp(`at\\s+(${SIZE}/s)`, 'i').exec(clean)?.[1]?.replace(/\s+/g, '')
  const eta = /ETA\s+(\d[\d:]*)/i.exec(clean)?.[1]
  const out: YtDlpProgress = { percent, message: clean }
  if (total) out.total = total
  if (speed) out.speed = speed
  if (eta) out.eta = eta
  return out
}

/** Stateful wrapper: buffers partial lines across chunks, tracks the destination. */
export class YtDlpProgressParser {
  private buf = ''
  destination: string | null = null

  /** Feed a stdout/stderr chunk; returns the latest progress in it, or null. */
  feed(chunk: Buffer | string): YtDlpProgress | null {
    this.buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const parts = this.buf.split(/\r\n|\r|\n/)
    this.buf = parts.pop() ?? ''
    let latest: YtDlpProgress | null = null
    for (const raw of parts) {
      const p = parseYtDlpLine(raw)
      if (!p) continue
      if (p.destination) this.destination = p.destination
      if (p.percent >= 0) latest = p
    }
    return latest
  }
}
