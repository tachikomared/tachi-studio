// apps/desktop/src/pages/agent/FilePathChips.tsx
//
// "Files right in the chat": scans an assistant text bubble for absolute
// Windows paths of PREVIEWABLE files (the PreviewPanel-supported set) and
// renders them as clickable brutalist chips under the bubble — click opens
// the PreviewPanel overlay. Image paths additionally get an inline THUMBNAIL
// above the chip row (bounded box, click toggles a larger inline view — never
// a new window), loaded lazily through the same agent:read-file IPC the
// PreviewPanel uses.
//
// WHY agent:read-file and not the tachi-preview:// scheme: the renderer's
// production CSP allows images from `'self' data: blob: tachi-media:` only —
// an <img src="tachi-preview://…"> is blocked in packaged builds. agent:read-file
// hands back a data: URL, which the CSP already permits, and main confines the
// read to an authorized workspace root (confineToWorkspace), so no new
// filesystem surface is exposed to the renderer.
//
// extractFilePaths / svgTextToDataUrl / imageSrcFromRead / thumbImageStyle /
// expandedMaxHeightPx / readRetryDelayMs are PURE (unit-tested in
// test/unit/filePathChips.test.ts). The workingDir filter mirrors what
// agent:read-file enforces in main (only paths inside an authorized workspace
// root are readable), so a chip is never rendered for a path the IPC refuses.
//
// Style invariants: 2px brutalist borders, JetBrains Mono, semantic CSS vars,
// no border-radius, no emojis — ASCII labels only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// ── Pure path extraction ──────────────────────────────────────────────────────

// Mirror of the PreviewPanel-supported set (AgentPage's PREVIEWABLE_EXTS):
// html/htm → iframe, images → <img>, the rest → text view. No pdf/mp4 — the
// PreviewPanel can't render those.
const PREVIEWABLE_EXTS = new Set([
  'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

const MAX_CHIPS = 8
const MAX_THUMBNAILS = 4

/** Collapsed thumbnail box height (px). Click expands to EXPANDED_MAX_H. */
const THUMB_MAX_H = 240
const EXPANDED_MAX_H = '70vh'

/**
 * ENLARGE MUST ACTUALLY ENLARGE.
 *
 * The first cut of the expanded state only raised `max-height` (240px → 70vh)
 * with `object-fit: contain` and no width — so a 128×128 PNG, which is already
 * smaller than BOTH caps, measured 128×128 in both states: the click was a
 * visual no-op and only the tooltip flipped (found live on the installed build).
 *
 * Expanded therefore sets an ABSOLUTE WIDTH derived from the intrinsic size:
 *   width = clamp(EXPANDED_MIN_W, intrinsic.width × EXPANDED_UPSCALE, EXPANDED_MAX_W)
 * so a small image is blown up to a readable box (128px → 512px) while a big
 * one still just fills the column. `max-width: 100%` (plus the wrapper's own)
 * clamps it to the bubble, and the browser recomputes the auto height from the
 * ratio, so nothing is stretched; `object-fit: contain` + `max-height: 70vh`
 * letterbox a very tall image instead of squashing it.
 *
 * WHY PX AND NOT `min(100%, …)`: the thumbnail wrapper is a shrink-to-fit
 * `inline-block`. A percentage width on a replaced child is treated as `auto`
 * while that shrink-to-fit width is being computed, so `width: min(100%, 512px)`
 * would resolve against the image's OWN intrinsic width — reintroducing exactly
 * the no-op this fixes. An absolute px width makes the wrapper measure 512px.
 *
 * PIXELATED ON PURPOSE: at or below PIXELATED_MAX_INTRINSIC px the file is an
 * icon / sprite / pixel-art asset, and the whole point of enlarging it is to
 * inspect the pixels — nearest-neighbour upscaling keeps them crisp, where the
 * browser's default smoothing turns them to mush. Photos (larger intrinsics)
 * keep the smooth default.
 */
const EXPANDED_UPSCALE = 4
const EXPANDED_MIN_W = 320
const EXPANDED_MAX_W = 1200
const PIXELATED_MAX_INTRINSIC = 256

/**
 * 70vh IS MEASURED AGAINST THE WRONG BOX.
 *
 * `max-height: 70vh` resolves against the WINDOW, but the figure lives inside
 * the transcript's scroll container — which, after the page header, the toolbar
 * row, an archive/workflow banner and the composer footer, is routinely far
 * shorter than 70vh (shorter still under a chassis theme, where .app-body is
 * inset by the bezel). So an "enlarged" figure could be TALLER THAN THE VIEWPORT
 * IT LIVES IN: the transcript clips it, most of the element's box sits scrolled
 * out past the top edge, and a click aimed at the middle of the figure lands on
 * whatever is painted above the scroll container (the "Viewing past session"
 * banner) instead of on the image. Only the sliver still inside the viewport
 * toggled back — exactly the dead-zone driver-2 measured on the installed build.
 *
 * The cap is therefore computed from BOTH boxes — the window AND the scroll
 * container that actually clips us — so an expanded figure always fits whole
 * inside the transcript and every pixel of it is hit-testable. `EXPANDED_MAX_H`
 * stays as the CSS fallback for the frame before anything has been measured.
 */
const EXPANDED_VH = 0.7
/** Room left for the figure's own 2px border + the transcript's row padding. */
const EXPANDED_GUTTER = 24

/**
 * The px cap for an expanded figure, or null when nothing could be measured
 * (⇒ fall back to the `70vh` CSS value). `containerH` is the clientHeight of the
 * nearest scrollable ancestor; 0/absent means "unknown, ignore this cap".
 */
export function expandedMaxHeightPx(viewportH: number, containerH: number): number | null {
  const caps: number[] = []
  if (Number.isFinite(viewportH) && viewportH > 0) caps.push(viewportH * EXPANDED_VH)
  if (Number.isFinite(containerH) && containerH > 0) caps.push(containerH - EXPANDED_GUTTER)
  if (caps.length === 0) return null
  const cap = Math.min(...caps)
  if (!(cap > 0)) return null
  return Math.round(cap)
}

/** Natural (intrinsic) pixel size of a loaded thumbnail, from `<img>` onLoad. */
export interface ImageIntrinsic {
  width:  number
  height: number
}

/**
 * The `<img>` style for a thumbnail in its collapsed / expanded state. Pure so
 * the "enlarge actually enlarges" rule is unit-testable without a DOM;
 * `intrinsic` is null until the image has loaded, where the width falls back to
 * the EXPANDED_MIN_W floor (a state the operator can barely reach — expanding
 * takes a click on an already-decoded thumbnail).
 */
export function thumbImageStyle(
  expanded: boolean,
  intrinsic?: ImageIntrinsic | null,
  /** Measured px cap (see expandedMaxHeightPx); omitted ⇒ the 70vh fallback. */
  maxHeightPx?: number | null,
): React.CSSProperties {
  const base: React.CSSProperties = {
    display:   'block',
    objectFit: 'contain',
    cursor:    expanded ? 'zoom-out' : 'zoom-in',
  }
  if (!expanded) {
    return { ...base, width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: THUMB_MAX_H }
  }
  const natW = intrinsic && intrinsic.width > 0 ? intrinsic.width : 0
  const natH = intrinsic && intrinsic.height > 0 ? intrinsic.height : 0
  const target = natW > 0
    ? Math.min(EXPANDED_MAX_W, Math.max(EXPANDED_MIN_W, Math.round(natW * EXPANDED_UPSCALE)))
    : 0
  const pixelArt = natW > 0 && natH > 0 && Math.max(natW, natH) <= PIXELATED_MAX_INTRINSIC
  return {
    ...base,
    // No intrinsic yet (image still decoding) ⇒ the floor, never `100%`: see
    // the shrink-to-fit note above.
    width:     target > 0 ? target : EXPANDED_MIN_W,
    height:    'auto',
    maxWidth:  '100%',
    // Measured cap wins: the figure must fit inside the SCROLL CONTAINER, not
    // just inside the window (see the note on EXPANDED_VH).
    maxHeight: typeof maxHeightPx === 'number' && maxHeightPx > 0 ? maxHeightPx : EXPANDED_MAX_H,
    ...(pixelArt ? { imageRendering: 'pixelated' as const } : {}),
  }
}

/** Cap on an inlined SVG source — a generated SVG can be megabytes, and a
 *  data: URL that big would bloat the transcript DOM for no visual gain. */
const MAX_SVG_CHARS = 512 * 1024

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path))
}

/** Trailing punctuation that prose/markdown glues onto a path — not part of it. */
function stripTrailingPunctuation(candidate: string): string {
  return candidate.replace(/[)\]"'`.,:;]+$/, '')
}

/** Normalize for comparison/dedupe: backslashes, lowercase (Windows paths are
 *  case-insensitive). */
function normPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

/**
 * Find absolute Windows file paths (drive-letter form, forward slashes
 * tolerated) in a chat message whose extension the PreviewPanel can render.
 * Deduped preserving order, capped at MAX_CHIPS.
 *
 * Only paths inside `workingDir` are kept: agent:read-file confines reads to
 * the open workspace roots (confineToWorkspace in agent.ipc.ts), so anything
 * outside would just error when clicked. No workingDir → no chips.
 */
export function extractFilePaths(text: string, workingDir: string | null): string[] {
  if (!text || !workingDir) return []

  const candidates: string[] = []
  // Pass 1 — quoted/backticked paths (may contain spaces): "D:\a b\c.png".
  const quoted = /["'`]([A-Za-z]:[\\/][^"'`\n]+)["'`]/g
  for (let m = quoted.exec(text); m; m = quoted.exec(text)) candidates.push(m[1])
  // Pass 2 — bare paths (no spaces): D:\foo\bar.html or D:/foo/bar.html.
  const bare = /[A-Za-z]:[\\/][^\s"'`<>|]+/g
  for (let m = bare.exec(text); m; m = bare.exec(text)) candidates.push(m[0])

  const dirNorm = normPath(workingDir).replace(/\\+$/, '') + '\\'
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of candidates) {
    const path = stripTrailingPunctuation(raw)
    if (!PREVIEWABLE_EXTS.has(extOf(path))) continue
    const norm = normPath(path)
    if (!norm.startsWith(dirNorm)) continue   // outside workspace → IPC refuses
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(path)
    if (out.length >= MAX_CHIPS) break
  }
  return out
}

// ── Pure <img src> building ───────────────────────────────────────────────────

/**
 * Turn SVG SOURCE TEXT into an <img>-loadable data URL.
 *
 * agent:read-file classifies `.svg` as TEXT (it is in the text-extension set),
 * so the renderer gets markup rather than a base64 image — we build the data
 * URL here. Fails closed (null) for empty/oversized input or anything that
 * doesn't actually start as an SVG document, so a mis-detected file never ends
 * up as a broken <img>.
 */
export function svgTextToDataUrl(svg: string, maxChars: number = MAX_SVG_CHARS): string | null {
  const trimmed = (svg ?? '').trim()
  if (!trimmed || trimmed.length > maxChars) return null
  if (!/^<(\?xml|!doctype\s+svg|svg)\b/i.test(trimmed)) return null
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`
}

/** The shape agent:read-file returns (see agent.ipc.ts). */
export interface ReadFileResult {
  kind:     string
  content?: string
}

/**
 * Map an agent:read-file result to an <img> src, or null when the file is not
 * displayable — too large (main answers kind 'binary' above 10 MB), unreadable,
 * not an image path, or an SVG that failed the sanity check. Null means "render
 * the plain chip only", never a broken image.
 */
export function imageSrcFromRead(path: string, result: ReadFileResult | null | undefined): string | null {
  if (!result || !isImagePath(path)) return null
  const content = typeof result.content === 'string' ? result.content : ''
  if (result.kind === 'image' && content.startsWith('data:')) return content
  if (result.kind === 'text' && extOf(path) === 'svg') return svgTextToDataUrl(content)
  return null
}

// ── Thumbnail read policy ─────────────────────────────────────────────────────

/**
 * THE FIRST READ CAN LOSE A RACE IT MUST NOT LOSE PERMANENTLY.
 *
 * agent:read-file confines every read to `authorizedRoots` — an IN-MEMORY Set in
 * MAIN (agent.ipc.ts), populated by the folder dialog, a session start, or the
 * renderer's `agent:register-workspace`. On a fresh process that Set starts
 * EMPTY, and the renderer registers the restored workingDir from an effect in
 * AgentPage. React runs CHILD effects before PARENT effects, so this component's
 * read fires BEFORE AgentPage's registration on the very first paint of a
 * restored/archived transcript: main answers "refused: path is outside the open
 * workspace", the read rejects, and the thumbnail is gone for the life of the
 * mount — while a manual read a second later succeeds. That is exactly the
 * first-attempt miss driver-2 measured on an archived session.
 *
 * Two fixes, both here:
 *  1. The read AWAITS its own idempotent `registerWorkspace` first, so the
 *     ordering no longer depends on which effect React happens to run first.
 *  2. A failed / undisplayable read is RE-ARMED instead of being marked done
 *     forever — bounded at MAX_THUMB_READ_ATTEMPTS with a short backoff, and
 *     driven by an explicit tick because an archived transcript is static and
 *     would otherwise never re-render to retry.
 *
 * The bound matters: a genuinely unreadable path must settle into the plain
 * chip, not spin the IPC forever. Three tries covers "main has not authorized
 * the root yet" and "the file is still being written" without ever becoming a
 * loop.
 */
export const MAX_THUMB_READ_ATTEMPTS = 3

/** Backoff before re-arming a failed read, keyed by attempts ALREADY spent. */
export function readRetryDelayMs(attemptsSpent: number): number {
  return attemptsSpent <= 1 ? 250 : 750
}

/** Should another read be issued for a path that has spent `attempts` tries? */
export function canRetryRead(attemptsSpent: number): boolean {
  return attemptsSpent < MAX_THUMB_READ_ATTEMPTS
}

/** agent bridge surface this component needs (both calls are optional in tests). */
interface AgentBridge {
  readFile?:          (p: string) => Promise<ReadFileResult>
  registerWorkspace?: (dir: string) => Promise<{ ok: boolean }>
}

/**
 * Authorize `dir` in main exactly once per app run — memoized so a transcript
 * with twenty bubbles does not fire twenty IPCs. A registration that did NOT
 * succeed is evicted so the next read attempt asks again (the folder may have
 * been mid-restore); a successful one is cached forever, since main's Set never
 * forgets a root.
 */
const registeredWorkspaces = new Map<string, Promise<unknown>>()
function ensureWorkspaceRegistered(agent: AgentBridge, dir: string | null): Promise<unknown> {
  if (!dir || !agent.registerWorkspace) return Promise.resolve()
  const key = normPath(dir)
  const cached = registeredWorkspaces.get(key)
  if (cached) return cached
  const pending = agent.registerWorkspace(dir).then(
    (r) => { if (!r?.ok) registeredWorkspaces.delete(key); return r },
    ()  => { registeredWorkspaces.delete(key); return undefined },
  )
  registeredWorkspaces.set(key, pending)
  return pending
}

// ── Component ─────────────────────────────────────────────────────────────────

function kindTag(path: string): string {
  const ext = extOf(path)
  if (ext === 'html' || ext === 'htm') return '[HTML]'
  if (IMAGE_EXTS.has(ext)) return '[IMG]'
  return '[TXT]'
}

interface FilePathChipsProps {
  text:       string
  workingDir: string | null
  onOpen:     (path: string) => void
}

export function FilePathChips({ text, workingDir, onOpen }: FilePathChipsProps) {
  const { t } = useTranslation('agent')
  const paths = useMemo(() => extractFilePaths(text, workingDir), [text, workingDir])
  const imagePaths = useMemo(
    () => paths.filter(isImagePath).slice(0, MAX_THUMBNAILS),
    [paths],
  )

  // path → <img> src (data URL), loaded lazily via the agent:read-file IPC.
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  // path → intrinsic pixel size, learned from the <img> onLoad. Feeds
  // thumbImageStyle so "enlarge" upscales a small image instead of no-opping.
  const [dims, setDims] = useState<Record<string, ImageIntrinsic>>({})
  // Which thumbnail is currently blown up (one at a time — the transcript
  // should never be pushed around by several giant images at once), and the
  // measured px cap that keeps it inside the transcript's own viewport.
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedCap, setExpandedCap] = useState<number | null>(null)

  // Read bookkeeping (see the "first read can lose a race" note above).
  // attempts: tries SPENT per path · inFlight: a read is out · settled: this
  // path is done, either with a src or knowingly given up on.
  const attemptsRef = useRef<Map<string, number>>(new Map())
  const inFlightRef = useRef<Set<string>>(new Set())
  const settledRef  = useRef<Set<string>>(new Set())
  const timersRef   = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const aliveRef    = useRef(true)
  const [readTick, setReadTick] = useState(0)

  // Declared FIRST so it runs before the read effect below on mount, and so its
  // cleanup is the LAST word on unmount. `alive` is per-MOUNT, deliberately not
  // per-effect-run: the previous cut cancelled every in-flight read whenever
  // `imagePaths` got a new identity, which during streaming is every token —
  // the read was dropped AND the path was already marked attempted.
  useEffect(() => {
    aliveRef.current = true
    const timers = timersRef.current
    return () => {
      aliveRef.current = false
      for (const id of timers) clearTimeout(id)
      timers.clear()
    }
  }, [])

  const scheduleRetry = useCallback((path: string) => {
    if (!aliveRef.current) return
    const spent = attemptsRef.current.get(path) ?? 0
    if (!canRetryRead(spent)) { settledRef.current.add(path); return }
    const id = setTimeout(() => {
      timersRef.current.delete(id)
      if (aliveRef.current) setReadTick(n => n + 1)
    }, readRetryDelayMs(spent))
    timersRef.current.add(id)
  }, [])

  useEffect(() => {
    const agent = (window.tachi as unknown as { agent?: AgentBridge })?.agent
    const readFile = agent?.readFile
    if (!agent || !readFile) return
    for (const path of imagePaths) {
      if (settledRef.current.has(path) || inFlightRef.current.has(path)) continue
      const spent = attemptsRef.current.get(path) ?? 0
      if (!canRetryRead(spent)) continue
      attemptsRef.current.set(path, spent + 1)
      inFlightRef.current.add(path)
      void (async () => {
        try {
          // Ordering guarantee, not an optimization: main must know this root
          // is authorized before it is asked to read inside it.
          await ensureWorkspaceRegistered(agent, workingDir)
          const result = await readFile(path)
          if (!aliveRef.current) return
          const src = imageSrcFromRead(path, result)
          if (src) {
            settledRef.current.add(path)
            setThumbs(prev => ({ ...prev, [path]: src }))
            return
          }
          // Readable but not displayable (kind 'binary', empty content, an SVG
          // that failed the sanity check). Re-arm — bounded — because the same
          // shape also covers "the file is still being written".
          scheduleRetry(path)
        } catch {
          scheduleRetry(path)
        } finally {
          inFlightRef.current.delete(path)
        }
      })()
    }
  }, [imagePaths, workingDir, readTick, scheduleRetry])

  // A src that decodes to nothing (truncated write, corrupt PNG) drops back to
  // the plain chip instead of leaving a broken-image glyph in the transcript.
  // The path stays SETTLED: the bytes arrived and the decoder rejected them, so
  // re-reading would just fail again.
  const dropThumb = useCallback((path: string) => {
    settledRef.current.add(path)
    setThumbs((prev) => {
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
    setExpanded(cur => (cur === path ? null : cur))
  }, [])

  // Record the decoded image's natural size once. Same-value loads (React
  // re-mounting the same src) are dropped so this never loops on itself.
  const noteIntrinsic = useCallback((path: string, img: HTMLImageElement) => {
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (!width || !height) return
    setDims((prev) => {
      const cur = prev[path]
      if (cur && cur.width === width && cur.height === height) return prev
      return { ...prev, [path]: { width, height } }
    })
  }, [])

  // ── Expanded figure: fit it to the transcript, not to the window ───────────
  const figureRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  /** clientHeight of the nearest scrollable ancestor — the box that clips us. */
  const measureCap = useCallback((el: HTMLElement | null): number | null => {
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 0
    let containerH = 0
    for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
      const overflowY = window.getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        containerH = node.clientHeight
        break
      }
    }
    return expandedMaxHeightPx(viewportH, containerH)
  }, [])

  const collapse = useCallback(() => { setExpanded(null); setExpandedCap(null) }, [])

  const toggleExpanded = useCallback((path: string) => {
    if (expanded === path) { collapse(); return }
    setExpandedCap(measureCap(figureRefs.current.get(path) ?? null))
    setExpanded(path)
  }, [expanded, collapse, measureCap])

  // Bring the whole figure into the transcript after it grows: `block: 'nearest'`
  // scrolls the minimum needed, so a figure that already fits is left alone.
  useEffect(() => {
    if (!expanded) return
    const el = figureRefs.current.get(expanded)
    if (!el?.scrollIntoView) return
    const id = window.requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(id)
  }, [expanded, expandedCap])

  // A resized window (or a re-laid-out chassis) changes the box we fitted to.
  useEffect(() => {
    if (!expanded) return
    const onResize = () => setExpandedCap(measureCap(figureRefs.current.get(expanded) ?? null))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [expanded, measureCap])

  // Escape always collapses: a keyboard way out that cannot be covered by
  // anything, whatever the transcript grows above the figure.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') collapse() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, collapse])

  if (paths.length === 0) return null

  return (
    <div style={{ marginTop: 6 }}>
      {/* Inline thumbnails — click toggles a larger inline view; the chip below
          still opens the full PreviewPanel. */}
      {imagePaths.map(path => {
        const src = thumbs[path]
        if (!src) return null
        const isExpanded = expanded === path
        return (
          <div
            key={path}
            ref={(el) => {
              if (el) figureRefs.current.set(path, el)
              else figureRefs.current.delete(path)
            }}
            style={{
              display: 'inline-block',
              maxWidth: '100%',
              border: '2px solid var(--border)',
              background: 'var(--bg-elevated)',
              marginBottom: 6,
              marginRight: 6,
              verticalAlign: 'top',
              // Belt to the fit-the-transcript brace: the expanded figure also
              // paints and hit-tests above anything else its own message row
              // draws. Confined to the row's stacking context, so it can never
              // climb over a banner or the composer.
              ...(isExpanded ? { position: 'relative' as const, zIndex: 1 } : {}),
            }}
          >
            <img
              src={src}
              alt={path.split(/[\\/]/).pop() ?? path}
              title={isExpanded ? t('fileChips.shrink') : t('fileChips.enlarge')}
              onClick={() => toggleExpanded(path)}
              onError={() => dropThumb(path)}
              onLoad={e => noteIntrinsic(path, e.currentTarget)}
              style={thumbImageStyle(isExpanded, dims[path], isExpanded ? expandedCap : null)}
            />
          </div>
        )
      })}
      {/* Chip row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {paths.map(path => {
          const basename = path.split(/[\\/]/).pop() ?? path
          return (
            <button
              key={path}
              onClick={() => onOpen(path)}
              title={path}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 8px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10, fontWeight: 700,
                letterSpacing: '0.04em',
                cursor: 'pointer',
                maxWidth: 260,
              }}
            >
              <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{kindTag(path)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {basename}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
