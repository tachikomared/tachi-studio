// apps/desktop/electron/services/yt-dlp-installer.ts
//
// yt-dlp standalone-binary resolver + auto-downloader (STEAL 2026-06-21 #8).
// Mirrors the sd-cpp / piper installers: resolve env → bundled → PATH, else
// download the official single-file release for the platform into
//   ${userData}/yt-dlp/bin/yt-dlp[.exe]
// yt-dlp ships as one self-contained executable (Python frozen in), so there is
// nothing to extract. We pull the "latest" release on purpose — yt-dlp's
// extractors break constantly as sites change, and it is explicitly designed to
// be kept current (pinning a SHA would go stale within weeks).

import { existsSync, mkdirSync, createWriteStream, renameSync, chmodSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import { get as httpsGet } from 'https'
import { URL } from 'url'
import { resolveBinary } from './util/resolve-binary'
import { withInstallLock } from './util/install-lock'

function ytDlpRoot(): string { return join(app.getPath('userData'), 'yt-dlp') }
export function ytDlpBinDir(): string { return join(ytDlpRoot(), 'bin') }

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
function releaseAsset(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return 'yt-dlp_linux'
}
function binName(): string { return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp' }

export function getYtDlpBinaryPath(): string | null {
  return resolveBinary('yt-dlp', {
    envVar: 'YT_DLP_PATH',
    bundledCandidates: [join(ytDlpBinDir(), 'yt-dlp')],
  })
}
export function isYtDlpInstalled(): boolean { return getYtDlpBinaryPath() !== null }

export type YtDlpInstallStage = 'checking' | 'downloading' | 'done' | 'error'
export interface YtDlpInstallProgress {
  stage: YtDlpInstallStage
  message: string
  percent: number
  bytes?: number
  totalBytes?: number
}
function push(win: BrowserWindow | null, e: YtDlpInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('yt-dlp:install-progress', e)
}

/** Redirect-following https download to `dest` (GitHub releases redirect to a CDN). */
function download(url: string, dest: string, onChunk?: (b: number, t: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let hops = 0
    const go = (currentUrl: string): void => {
      if (++hops > 10) { reject(new Error(`Too many redirects: ${url}`)); return }
      let parsed: URL
      try { parsed = new URL(currentUrl) } catch { reject(new Error(`Invalid URL: ${currentUrl}`)); return }
      if (parsed.protocol !== 'https:') { reject(new Error(`Only https is allowed (got ${parsed.protocol})`)); return }
      const req = httpsGet({
        host: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'TachiDesk/yt-dlp-installer', 'Accept': '*/*' },
      }, (res) => {
        const code = res.statusCode ?? 0
        if (code >= 300 && code < 400 && res.headers.location) { res.resume(); go(new URL(res.headers.location, currentUrl).toString()); return }
        if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code} for ${currentUrl}`)); return }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0
        let received = 0
        const ws = createWriteStream(dest, { flags: 'w' })
        res.on('data', (chunk: Buffer) => { received += chunk.length; onChunk?.(received, total) })
        res.pipe(ws)
        ws.on('finish', () => ws.close(() => resolve()))
        ws.on('error', reject)
        res.on('error', reject)
      })
      req.setTimeout(60_000, () => req.destroy(new Error('socket idle timeout')))
      req.on('error', reject)
      req.end()
    }
    go(url)
  })
}

/** Resolve the yt-dlp binary, downloading the official release on first use. */
export async function ensureYtDlp(win: BrowserWindow | null): Promise<string> {
  const existing = getYtDlpBinaryPath()
  if (existing) return existing

  let resolved: string | null = null
  await withInstallLock('yt-dlp-binary', async () => {
    const again = getYtDlpBinaryPath()
    if (again) { resolved = again; return }
    push(win, { stage: 'checking', message: 'Preparing yt-dlp…', percent: 0 })
    mkdirSync(ytDlpBinDir(), { recursive: true })
    const dest = join(ytDlpBinDir(), binName())
    const tmp = dest + '.tmp'
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    push(win, { stage: 'downloading', message: 'Downloading yt-dlp…', percent: 0 })
    await download(`${RELEASE_BASE}/${releaseAsset()}`, tmp, (b, t) => {
      push(win, { stage: 'downloading', message: 'Downloading yt-dlp…', percent: t ? Math.round((b / t) * 100) : 0, bytes: b, totalBytes: t })
    })
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error('yt-dlp download produced an empty file')
    renameSync(tmp, dest)
    if (process.platform !== 'win32') { try { chmodSync(dest, 0o755) } catch { /* best-effort */ } }
    push(win, { stage: 'done', message: 'yt-dlp ready', percent: 100 })
    resolved = dest
  })
  if (!resolved) resolved = getYtDlpBinaryPath()
  if (!resolved) throw new Error('yt-dlp could not be resolved after install')
  return resolved
}
