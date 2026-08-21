// apps/desktop/electron/services/preview-protocol.ts
//
// A custom `tachi-preview://` scheme that serves the Design tab's live PREVIEW
// HTML to the renderer.
//
// WHY: the preview iframe used a blob: URL, and a blob document INHERITS the
// embedder's CSP — which in packaged builds is strict (`script-src 'self'
// https://esm.sh https://unpkg.com`, NO 'unsafe-inline'). So inline scripts are
// refused INSIDE the preview, silently breaking the Remotion <Player> bootstrap
// and any interactive page. (Dev uses a looser CSP, so it only bit packaged
// builds — and prior verification rendered extracted HTML in a CSP-free window,
// which masked it.) A document loaded from a REAL registered scheme does not
// inherit the embedder CSP; it gets its own from the response, so its scripts
// run again.
//
// SECURITY: the served document gets a DISTINCT origin and the iframe stays
// sandboxed allow-scripts (NOT allow-same-origin), so it can't reach
// window.tachi. We also attach a SCOPED CSP to the response so the preview may
// load only the same CDNs the app already trusts (esm.sh / unpkg / Google
// fonts) — never arbitrary origins. Content lives in memory only.

import { protocol } from 'electron'
import { createRequire } from 'module'
import { createReadStream, readFileSync, statSync } from 'fs'
import { Readable } from 'stream'
import { resolveDesignAudioPath } from './design-audio'
import { isDesignAudioName, designAudioMime } from './util/design-audio'
import { resolveDesignAssetPath } from './design-assets'
import { designAssetMime } from './util/design-assets'
import { injectMediaBlobBootstrap } from './util/preview-inject'

export const PREVIEW_SCHEME = 'tachi-preview'

// Vendored GSAP for HyperFrames-engine previews — served from THIS scheme so
// preview works fully offline / in PRIVATE MODE (no CDN dependency). Read once,
// lazily, from the resolved package (works inside app.asar — fs.readFile is fine,
// only spawn isn't). Falls back to '' on failure (preview then no-ops the anim).
const nodeRequire = createRequire(__filename)
let _gsapSource: string | null = null
function gsapSource(): string {
  if (_gsapSource !== null) return _gsapSource
  try {
    const p = nodeRequire.resolve('gsap/dist/gsap.min.js')
    _gsapSource = readFileSync(p, 'utf8')
  } catch (err) {
    console.warn('[preview-protocol] could not load vendored gsap:', err)
    _gsapSource = ''
  }
  return _gsapSource
}

/** The vendored gsap source, for consumers that must INLINE it (e.g. the
 *  HyperFrames MP4 frame-capture window, which loads from a temp file where no
 *  tachi-preview:// scheme exists). '' when the vendored file is unavailable. */
export function getGsapSource(): string {
  return gsapSource()
}

// id -> html. The renderer pushes the current preview doc via IPC before loading
// `tachi-preview://doc/<id>`. Bounded so stale docs don't accumulate.
const docs = new Map<string, string>()
const order: string[] = []
const MAX_DOCS = 8

export function setPreviewDoc(id: string, html: string): void {
  if (!docs.has(id)) order.push(id)
  docs.set(id, html)
  while (order.length > MAX_DOCS) {
    const old = order.shift()
    if (old && old !== id) docs.delete(old)
  }
}

// The preview's OWN CSP: permissive enough to run a generated page + the Remotion
// CDN bootstrap (inline module + esm.sh/unpkg + Babel's eval), but with no
// arbitrary network egress (connect limited to the trusted CDNs).
const PREVIEW_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  // tachi-preview: lets the HyperFrames preview load its vendored GSAP from
  // tachi-preview://asset/gsap.min.js (a different host = origin than the doc).
  "script-src 'unsafe-inline' 'unsafe-eval' tachi-preview: https://esm.sh https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src data: https://fonts.gstatic.com",
  // 'self' = the doc's own tachi-preview://doc origin, where staticFile('vo.wav')
  // resolves (served below from the design-audio dir); https: mirrors img-src so
  // <Audio>/<Video> can use direct remote URLs.
  "media-src 'self' data: blob: https:",
  "connect-src tachi-preview: https://esm.sh https://unpkg.com data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

/**
 * Register the scheme as privileged. MUST run BEFORE the app `ready` event
 * (Electron requirement). `supportFetchAPI`/`stream` let the preview's module
 * imports + importmap resolve.
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled: the preview iframe is sandboxed WITHOUT allow-same-origin,
    // so its origin is opaque and every fetch() to this scheme is cross-origin.
    // Without corsEnabled Chromium blocks such fetches at the network layer —
    // before our ACAO headers are even consulted (media elements still loaded,
    // they use no-cors). Needed for the blob-preload scrub recipe; responses
    // stay gated by the handler's own validation + per-route ACAO.
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ])
}

/** Serve one on-disk file honoring HTTP Range (a 206 is what lets Chromium's
 *  media element seek/scrub; same lesson as media-protocol.ts — without it
 *  playback can silently load nothing). Shared by the design-audio route and
 *  the design-assets route.
 *
 *  PERF (2026-07-22, "design viewer is lagging"): this used to readFileSync the
 *  WHOLE file per request and slice it. A cursor-scrub page fires dozens of
 *  Range requests per second — each one synchronously re-reading the full video
 *  ON THE MAIN PROCESS blocked the event loop and janked the entire app. Now
 *  only the requested byte window is streamed, off the event loop. */
function serveFileWithRange(abs: string, mime: string, request: Request): Response {
  const size = statSync(abs).size
  const toWeb = (start?: number, end?: number) =>
    Readable.toWeb(createReadStream(abs, start === undefined ? {} : { start, end })) as unknown as ReadableStream
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
    return new Response(toWeb(start, end), {
      status: 206,
      headers: {
        'Content-Type':   mime,
        'Content-Range':  `bytes ${start}-${end}/${size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': String(end - start + 1),
        // The preview iframe is sandboxed WITHOUT allow-same-origin, so its
        // origin is opaque and every fetch() is CORS-gated — media ELEMENTS
        // load fine (no-cors) but the blob-preload recipe needs this. The
        // route only ever serves validated names from the app's own dirs.
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
  return new Response(toWeb(), {
    status: 200,
    headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(size), 'Access-Control-Allow-Origin': '*' },
  })
}

/** Wire the protocol handler. MUST run AFTER the app `ready` event. */
export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // tachi-preview://asset/gsap.min.js → vendored GSAP for HyperFrames previews.
      if (url.hostname === 'asset') {
        if (/gsap(\.min)?\.js$/.test(url.pathname)) {
          return new Response(gsapSource(), {
            status: 200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
          })
        }
        return new Response('unknown asset', { status: 404 })
      }
      // tachi-preview://doc/<id>?v=<hash>  → host "doc", path "/<id>"
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, '') || url.hostname)
      const html = docs.get(id)
      if (html == null) {
        // A generated page's `assets/<name>` (attached video/audio/gif) resolves
        // DOC-relative and lands here as /assets/<name>. Fail-closed: only a
        // bare, known-extension media name present in the DesignAssets dir.
        if (id.startsWith('assets/')) {
          const name = id.slice('assets/'.length)
          const abs = resolveDesignAssetPath(name)
          if (abs) return serveFileWithRange(abs, designAssetMime(name) ?? 'application/octet-stream', request)
          return new Response('no asset', { status: 404 })
        }
        // A composition's staticFile('vo.wav') resolves DOC-relative, so its
        // request lands here as /vo.wav. Serve ONLY validated bare audio names
        // out of the design-audio dir (where design:synthesize-vo writes piper
        // voiceover) — the generated page is untrusted, so nothing else passes.
        if (isDesignAudioName(id)) {
          const abs = resolveDesignAudioPath(id)
          if (abs) return serveFileWithRange(abs, designAudioMime(id) ?? 'application/octet-stream', request)
          return new Response('no audio', { status: 404 })
        }
        return new Response('no preview', { status: 404 })
      }
      // Media blob-bootstrap: assets/-sourced <video>/<audio> can't decode over
      // this scheme's streaming path (metadata only — measured), so the served
      // doc gets a tiny script that swaps them onto blob: URLs via fetch (which
      // DOES work: corsEnabled + ACAO). The stored/saved HTML stays untouched.
      return new Response(injectMediaBlobBootstrap(html), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP },
      })
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
}
