// apps/desktop/electron/services/media-protocol.ts
//
// A custom `tachi-media://` protocol that serves generated media artifacts to
// the renderer. WHY: the renderer is served over http://localhost (dev) / a
// packaged origin (prod), and browsers/Electron refuse to load `file://` URLs
// from such an origin — so `<img src="file:///…/0.png">` renders a broken
// image even though the file exists. This scheme reads the file in main and
// streams it back with the right Content-Type, so images/audio/video display.
//
// SECURITY: only files under the user-content roots are served — the current
// storage root (Documents\Tachi Studio by default) plus the LEGACY userData
// locations (userData/media etc.) so pre-existing artifacts keep loading.
// Any path outside those roots is rejected (isUserContentPath).
//
// URL shape: tachi-media://artifact/<encodeURIComponent(absolutePath)>

import { protocol } from 'electron'
import { resolve } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { isUserContentPath } from './storage-root'

export const MEDIA_SCHEME = 'tachi-media'

/**
 * Register the scheme as privileged. MUST be called at module load, BEFORE the
 * app `ready` event (Electron requirement for registerSchemesAsPrivileged).
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
    },
  ])
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
  aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Wire the protocol handler. MUST be called AFTER the app `ready` event.
 * Serves only files under the user-content roots (storage root + legacy dirs).
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // Sandbox: resolve first (collapses ../ traversal), then require the path
      // to sit inside the storage root or a legacy user-content dir. All reads
      // below use the RESOLVED path so the check and the read can't diverge.
      const abs = resolve(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
      if (!isUserContentPath(abs)) {
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(abs)) return new Response('not found', { status: 404 })
      const mime = mimeFor(abs)
      const size = statSync(abs).size

      // Honor HTTP Range — REQUIRED for <video> playback in Chromium. Without a
      // 206 Partial-Content response the renderer's <video> loads nothing and
      // shows a black frame (images/audio are forgiving). The old net.fetch path
      // never forwarded Range, which is exactly why video previewed black.
      const range = request.headers.get('range') || request.headers.get('Range')
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end   = m && m[2] ? parseInt(m[2], 10) : size - 1
        if (!Number.isFinite(start)) start = 0
        if (!Number.isFinite(end) || end >= size) end = size - 1
        if (start > end || start >= size) {
          return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        }
        const slice = readFileSync(abs).subarray(start, end + 1)
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type':   mime,
            'Content-Range':  `bytes ${start}-${end}/${size}`,
            'Accept-Ranges':  'bytes',
            'Content-Length': String(end - start + 1),
          },
        })
      }

      return new Response(readFileSync(abs), {
        status: 200,
        headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
      })
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
}

/** Build a renderer-loadable URL for an on-disk media artifact (main-side only;
 *  the renderer builds the same string inline in mediaHelpers to avoid importing
 *  this electron module). Kept here for callers in main. */
export function mediaArtifactUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://artifact/${encodeURIComponent(absPath)}`
}
