// apps/desktop/electron/services/design-render.ts
//
// Design tab → Export MP4. Renders a generated Remotion composition to a real
// H.264 MP4 server-side with @remotion/bundler + @remotion/renderer, driving the
// MANAGED Chromium (chrome-headless-shell in userData) via `browserExecutable`.
// This is the frame-accurate path that replaces the lossy screen-grab capture —
// crisp, deterministic frames straight from Remotion's compositor.
//
// Pipeline: buildRemotionEntry(code) → temp entry module → bundle() (webpack) →
// selectComposition() (reads the generated `config` dims) → renderMedia({h264}).
//
// Resolution note: the temp entry lives outside the repo tree, so webpack would
// not find react/remotion by walking up. We inject the resolved node_modules
// roots into `resolve.modules` (symlink-aware for pnpm) via webpackOverride.

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, resolve as resolvePath, basename } from 'path'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { resolveRemotionBinariesDir, REMOTION_BINARIES_MISSING } from './remotion-binaries-installer'
import { app, type BrowserWindow } from 'electron'
// LAZY imports on purpose: rollup hoists external require() calls to the TOP of
// the bundled main chunk, so a static import here would load esbuild (via
// @remotion/bundler) BEFORE services/esbuild-binary-path can set
// ESBUILD_BINARY_PATH — and esbuild captures that env var at module load.
// Loading at render time also keeps ~100ms of webpack machinery off app boot.
import type { webpack } from '@remotion/bundler'
import { buildRemotionEntry } from '@tachi/core'
import { installChromium, getChromiumPath } from './chromium-installer'
import { ensureStorageDir } from './storage-root'
import { designAudioPublicDir, designAudioDirFingerprint } from './design-audio'

const COMPOSITION_ID = 'design'
// The main process is bundled to CJS (no import.meta.url) — resolve runtime deps
// relative to the compiled file, matching the darksol/nook service pattern.
const nodeRequire = createRequire(__filename)

// ─── Stage progress (forwarded to the renderer over IPC) ──────────────────────

export type RenderStage = 'browser' | 'bundle' | 'render' | 'done' | 'error'
export interface RenderMp4Progress { stage: RenderStage; percent: number; message: string }

export interface RenderMp4Options {
  /** Generated composition module (TSX) — defines `Composition` + `config`. */
  code: string
  /** Where to write the MP4. Defaults to <storage root>/Design Renders/design-<ts>.mp4. */
  outputPath?: string
  onProgress?: (p: RenderMp4Progress) => void
  /** Window to forward Chromium install-progress events to (first run downloads it). */
  win?: BrowserWindow | null
  /** Export quality target: minimum output height in px (1080 default; 1440 = 2K, 2160 = 4K). */
  targetHeight?: number
}

/** node_modules roots that hold react/react-dom/remotion, derived from where they
 *  actually resolve (pnpm-safe), plus the workspace + repo-root fallbacks. */
function nodeModulesRoots(): string[] {
  const roots = new Set<string>()
  for (const pkg of ['react', 'react-dom', 'remotion']) {
    try {
      const nm = resolvePath(dirname(nodeRequire.resolve(`${pkg}/package.json`)), '..')
      if (basename(nm) === 'node_modules') roots.add(nm)
    } catch { /* devDep not resolvable in this context — fallbacks below cover it */ }
  }
  roots.add(join(process.cwd(), 'node_modules'))
  return [...roots]
}

const withNodeModules = (config: webpack.Configuration): webpack.Configuration => ({
  ...config,
  resolve: {
    ...config.resolve,
    symlinks: true, // follow pnpm symlinks when resolving from the injected roots
    modules: [...nodeModulesRoots(), ...((config.resolve?.modules as string[] | undefined) ?? ['node_modules'])],
  },
})

// ─── Bundle cache ─────────────────────────────────────────────────────────────
// webpack-bundling a composition is the slow part of an export (~seconds). The
// output only depends on the composition source, so we cache the bundle by a hash
// of the code: re-exporting the same animation (e.g. PNG then MP4, or tweaking
// only render settings) reuses it and skips webpack entirely. Persisted under
// userData so it survives across exports; the N most-recent are kept. This is
// an app INTERNAL cache — it deliberately stays in userData, NOT the
// user-visible storage root (only finished exports belong there).
const BUNDLE_CACHE_KEEP = 6
const bundleCache = new Map<string, string>() // codeHash -> serveUrl (bundle outDir)
const bundleCacheRoot = (): string => join(app.getPath('userData'), 'design-renders', '.bundle-cache')
const hashCode = (code: string): string => createHash('sha1').update(code).digest('hex').slice(0, 16)
/** A finished Remotion bundle has an index.html at its serveUrl root. */
const isValidBundle = (serveUrl: string): boolean => {
  try { return existsSync(join(serveUrl, 'index.html')) } catch { return false }
}
/** Keep the BUNDLE_CACHE_KEEP most-recent cache dirs (never the one just used). */
function evictOldBundles(keepHash: string): void {
  try {
    const root = bundleCacheRoot()
    const dirs = readdirSync(root)
      .map(name => ({ name, path: join(root, name) }))
      .filter(d => { try { return statSync(d.path).isDirectory() } catch { return false } })
      .map(d => ({ ...d, mtime: (() => { try { return statSync(d.path).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const d of dirs.slice(BUNDLE_CACHE_KEEP)) {
      if (d.name === keepHash) continue
      try { rmSync(d.path, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  } catch { /* no cache dir yet */ }
}

/**
 * Render the composition to an MP4. Ensures the managed Chromium is present
 * (downloading on first use), bundles + renders, and cleans up the temp project.
 * Returns the absolute output path.
 */
/**
 * PACKAGED builds: Remotion spawns its Rust compositor (+ ffmpeg/ffprobe) whose
 * path it resolves via require() — landing INSIDE app.asar, unspawnable (the
 * same class of bug as esbuild; instrumented probe showed selectComposition
 * stalling forever). The binaries ARE on disk via asarUnpack — point Remotion
 * at them with its official `binariesDirectory` option.
 */
function remotionBinariesDirectory(): string | null {
  // ONE resolver for both render paths — see remotion-binaries-installer.ts.
  // The compositor is no longer bundled (its FFmpeg self-reports
  // `nonfree and unredistributable`), so packaged builds read the copy the user
  // authorised us to fetch, and a dev tree keeps working with no download.
  const dir = resolveRemotionBinariesDir()
  if (!dir) {
    console.warn('[design-render] Remotion binaries are not installed — MP4 export will be refused with an actionable message')
    return null
  }
  return dir
}

export async function renderDesignMp4(opts: RenderMp4Options): Promise<{ outputPath: string }> {
  const code = opts.code?.trim()
  if (!code) throw new Error('No animation to export — generate a composition first.')
  // The encoder is a download the user has to authorise; say so before spending
  // a bundle + a browser launch on a render that cannot be encoded.
  if (!resolveRemotionBinariesDir()) throw new Error(REMOTION_BINARIES_MISSING)

  // Lazy remotion (see the import note at the top of this file). Stage logs are
  // deliberate: packaged-only hangs (asar) are invisible without them.
  const t0 = Date.now()
  const mark = (m: string) => console.log(`[design-render] +${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`)
  mark('loading @remotion/bundler…')
  const { bundle } = await import('@remotion/bundler')
  mark('loading @remotion/renderer…')
  const { selectComposition, renderMedia } = await import('@remotion/renderer')
  mark('remotion loaded')

  // 1. Managed Chromium (chrome-headless-shell in userData) — shared with puppeteer later.
  opts.onProgress?.({ stage: 'browser', percent: 0, message: 'Preparing Chromium…' })
  const browserExecutable = getChromiumPath() ?? await installChromium(opts.win ?? null)
  mark(`chromium ready: ${browserExecutable}`)

  // 2. Bundle (cached by composition hash). On a cache hit we skip webpack entirely;
  //    otherwise we write the Remotion entry + an anchoring package.json into the
  //    cache dir and bundle there (Remotion roots its webpack at the closest package.json).
  //    Voiceover files (design-audio) are COPIED into the bundle as its publicDir,
  //    so their fingerprint is part of the cache key — a re-synthesized line must
  //    not render from a stale cached bundle.
  const publicDir = designAudioPublicDir()
  const audioFp = publicDir ? designAudioDirFingerprint() : ''
  const hash = hashCode(audioFp ? `${code}\n@design-audio:${audioFp}` : code)
  const cacheDir = join(bundleCacheRoot(), hash)
  let serveUrl = bundleCache.get(hash)
  if (!serveUrl || !isValidBundle(serveUrl)) {
    opts.onProgress?.({ stage: 'bundle', percent: 0, message: 'Bundling animation…' })
    mkdirSync(cacheDir, { recursive: true })
    const entryPoint = join(cacheDir, 'index.tsx')
    writeFileSync(entryPoint, buildRemotionEntry(code, COMPOSITION_ID), 'utf8')
    writeFileSync(join(cacheDir, 'package.json'), JSON.stringify({ name: 'tachi-design-render', private: true }), 'utf8')
    mark('webpack bundle start')
    serveUrl = await bundle({
      entryPoint,
      outDir: join(cacheDir, 'bundle'),
      // Voiceover .wav files become the bundle's public/ — staticFile('vo.wav')
      // in the composition resolves against them during the headless render.
      publicDir,
      webpackOverride: withNodeModules,
      onProgress: (p) => opts.onProgress?.({ stage: 'bundle', percent: Math.round(p), message: 'Bundling animation…' }),
    })
    mark('webpack bundle done')
    bundleCache.set(hash, serveUrl)
    evictOldBundles(hash)
  } else {
    opts.onProgress?.({ stage: 'bundle', percent: 100, message: 'Reusing cached bundle…' })
  }

  // 3. selectComposition — runs in Chromium, reads the registered dims/duration.
  // logLevel verbose: the packaged-only stall lived here; keep the evidence flowing.
  const binariesDirectory = remotionBinariesDirectory()
  mark(`selectComposition start (binaries: ${binariesDirectory ?? 'default'})`)
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, browserExecutable, binariesDirectory })
  mark('selectComposition done')

  // 4. renderMedia → H.264 MP4. Export QUALITY floor: compositions are authored
  // at preview-friendly sizes (1280×720 typical), but the exported file should
  // hit the user's chosen target (1080p default, 2K/4K selectable) — Remotion's
  // `scale` renders every frame at N× the composition size (crisp, not an
  // upscale of rendered pixels). Cap ×6 so a tiny comp can't explode memory
  // (×6 = 4K from a 360p comp); comps already at target export natively.
  const targetH = Math.min(2160, Math.max(480, opts.targetHeight ?? 1080))
  const exportScale = Math.min(6, Math.max(1, Math.ceil((targetH / Math.max(1, composition.height)) * 4) / 4))
  if (exportScale > 1) mark(`export scale ×${exportScale} (${composition.width}×${composition.height} → ${Math.round(composition.width * exportScale)}×${Math.round(composition.height * exportScale)})`)
  // Remotion writes the MP4 itself, so the root must be healed BEFORE the render
  // (ensureStorageDir probes + falls back); a caller-supplied path was already
  // pre-healed by design.ipc.
  const outputLocation = opts.outputPath ?? join(ensureStorageDir('renders'), `design-${Date.now()}.mp4`)
  mkdirSync(dirname(outputLocation), { recursive: true })
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation,
    browserExecutable,
    binariesDirectory,
    scale: exportScale,
    onProgress: ({ progress }) => opts.onProgress?.({ stage: 'render', percent: Math.round(progress * 100), message: 'Rendering frames…' }),
  })
  mark('renderMedia done')

  opts.onProgress?.({ stage: 'done', percent: 100, message: 'Export complete.' })
  return { outputPath: outputLocation }
}
