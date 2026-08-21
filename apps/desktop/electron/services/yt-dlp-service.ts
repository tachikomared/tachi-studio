// apps/desktop/electron/services/yt-dlp-service.ts
//
// Media URL-import via yt-dlp (STEAL 2026-06-21 #8): "paste a YouTube/IG/X URL →
// get a local file" you can then edit (sd.cpp img2img / Wan) or use as a
// reference. PRIVATE-MODE + SSRF gated on the page URL (checkUrlEgressSafe).
// Downloads land in <storage root>/Media so the media:// protocol serves them
// and they appear in the library. Personal-use only — the UI shows a ToS
// notice; no DRM circumvention.

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { type BrowserWindow } from 'electron'
import { checkUrlEgressSafe } from './egress-policy'
import { ensureStorageDir } from './storage-root'
import { ensureYtDlp } from './yt-dlp-installer'
import { YtDlpProgressParser } from './util/yt-dlp-progress'
import { pickBestFormats, type PickedFormat } from './util/media-format'

const execFileP = promisify(execFile)

export interface MediaInfo {
  title: string
  thumbnail?: string
  durationSec?: number
  extractor?: string
  formats: PickedFormat[]
}

export interface DownloadResult {
  ok: boolean
  /** Absolute path of the downloaded file (on success). */
  path?: string
  /** media:// URL the renderer can use directly (on success). */
  mediaUrl?: string
  error?: string
}

function mediaDir(): string {
  // ensureStorageDir, not a bare mkdir: yt-dlp writes the file itself, so the
  // last moment we can heal a storage root that went unwritable mid-session
  // (Defender Controlled Folder Access on Documents — LANE J/L) is BEFORE the
  // download starts; the probe moves the whole download to a writable root.
  return ensureStorageDir('media')
}

/** Fetch metadata + a best-per-resolution format list for a URL (no download). */
export async function getMediaInfo(url: string, win: BrowserWindow | null): Promise<MediaInfo> {
  const eg = await checkUrlEgressSafe(url)
  if (!eg.allowed) throw new Error(eg.reason ?? 'Blocked by PRIVATE MODE.')
  const bin = await ensureYtDlp(win)
  const { stdout } = await execFileP(bin, ['-J', '--no-playlist', '--', url], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  })
  const j = JSON.parse(stdout) as {
    title?: string; thumbnail?: string; duration?: number; extractor_key?: string; extractor?: string
    formats?: unknown[]
  }
  return {
    title: j.title ?? 'media',
    thumbnail: typeof j.thumbnail === 'string' ? j.thumbnail : undefined,
    durationSec: typeof j.duration === 'number' ? j.duration : undefined,
    extractor: j.extractor_key ?? j.extractor,
    formats: pickBestFormats(Array.isArray(j.formats) ? (j.formats as never[]) : []),
  }
}

/** The newest non-temp file in `dir` modified at or after `sinceMs`, if any. */
function newestFileSince(dir: string, sinceMs: number): string | null {
  let best: { path: string; mtime: number } | null = null
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (name.endsWith('.part') || name.endsWith('.tmp') || name.endsWith('.ytdl')) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile() || st.mtimeMs < sinceMs - 1000) continue
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs }
    } catch { /* skip */ }
  }
  return best?.path ?? null
}

/** Download a URL's media into the local media library. */
export async function downloadMedia(opts: {
  url: string
  formatId?: string
  /** Grab the best audio stream only (music / podcast → Whisper transcription). */
  audioOnly?: boolean
  win: BrowserWindow | null
}): Promise<DownloadResult> {
  const eg = await checkUrlEgressSafe(opts.url)
  if (!eg.allowed) return { ok: false, error: eg.reason ?? 'Blocked by PRIVATE MODE.' }

  let bin: string
  try { bin = await ensureYtDlp(opts.win) } catch (e) { return { ok: false, error: (e as Error).message } }

  const outDir = mediaDir()
  const outTpl = join(outDir, '%(title).80s-%(id)s.%(ext)s')
  // Audio-only grabs the best audio stream; a chosen video format is merged with
  // best audio; otherwise let yt-dlp pick the best combined.
  const fmt = opts.audioOnly
    ? 'bestaudio/best'
    : opts.formatId ? `${opts.formatId}+bestaudio/best` : 'bestvideo*+bestaudio/best/best'
  const args = ['-f', fmt, '-o', outTpl, '--no-playlist', '--newline', '--no-mtime', '--restrict-filenames', '--', opts.url]
  const startedAt = Date.now()

  return new Promise<DownloadResult>((resolve) => {
    const parser = new YtDlpProgressParser()
    let stderrTail = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { windowsHide: true })
    } catch (e) { resolve({ ok: false, error: (e as Error).message }); return }

    const onData = (d: Buffer): void => {
      const text = d.toString('utf8')
      stderrTail = (stderrTail + text).slice(-2000)
      const p = parser.feed(text)
      if (p && opts.win && !opts.win.isDestroyed() && !opts.win.webContents.isDestroyed()) {
        opts.win.webContents.send('yt-dlp:download-progress', {
          url: opts.url, percent: p.percent, speed: p.speed, eta: p.eta, total: p.total,
        })
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `yt-dlp exited ${code}: ${stderrTail.trim().split('\n').slice(-1)[0] ?? ''}` })
        return
      }
      // Final (possibly merged) file = the newest media file produced this run.
      const path = newestFileSince(outDir, startedAt) ?? (parser.destination ? join(outDir, parser.destination.split(/[\\/]/).pop() ?? '') : null)
      if (!path || !existsSync(path)) { resolve({ ok: false, error: 'download finished but no output file was found' }); return }
      const name = path.split(/[\\/]/).pop() ?? ''
      resolve({ ok: true, path, mediaUrl: name ? `media://${name}` : undefined })
    })
  })
}
