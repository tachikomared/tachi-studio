// apps/desktop/electron/ipc/design.ipc.ts
//
// IPC for the Design tab. Channels:
//   design:generate — stream a self-contained HTML design from a prompt + preset.
//                     Emits `design:delta` { requestId, chunk } as text arrives,
//                     resolves with { ok, html, raw } | { ok:false, error }.
//   design:abort    — cancel an in-flight generation by requestId.
//
// The handler NEVER throws — every failure path returns { ok:false, error }.
// PRIVATE MODE / egress is enforced inside generateDesign().

import { ipcMain, dialog, app, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { generateDesign, clarifyDesign, type GenerateDesignInput } from '../services/design-generate'
import { renderDesignMp4 } from '../services/design-render'
import { captureDesignPng, captureDesignPdf } from '../services/design-capture'
import { setPreviewDoc } from '../services/preview-protocol'
import { synthesizeDesignVo, listDesignAudio, importDesignAudio } from '../services/design-audio'
import { addDesignAsset, resolveDesignAssetPath } from '../services/design-assets'
import { storageDir, legacyDir, ensureStorageDir, writeStorageFile } from '../services/storage-root'
import { isSensitiveFileName, isSensitiveDirName } from '../services/util/sensitive-files'
import {
  remotionBinariesState, installRemotionBinaries, removeRemotionBinaries,
  type RemotionBinariesState,
} from '../services/remotion-binaries-installer'

// ── On-disk project folders ─────────────────────────────────────────────────────
// Generated designs auto-save under <baseDir>/<project>/ so they are real files
// (openable, backup-able). The base is USER-CONFIGURABLE (persisted in a tiny
// design-config.json — an app INTERNAL that stays in userData); default is the
// storage root's Designs folder (Documents\Tachi Studio\Designs) — never the
// buried AppData folder. Designs saved under the older defaults (Documents/
// TACHI Design, or the userData fallback) stay where they are and keep working;
// only NEW writes land in the storage root.
function configPath(): string {
  return path.join(app.getPath('userData'), 'design-config.json')
}
function defaultBaseDir(): string {
  return storageDir('designs')
}
async function readBaseDir(): Promise<string> {
  try {
    const j = JSON.parse(await fs.readFile(configPath(), 'utf8')) as { baseDir?: string }
    if (typeof j.baseDir === 'string' && j.baseDir.trim()) return j.baseDir
  } catch { /* no config yet */ }
  return defaultBaseDir()
}
/**
 * The base dir to SAVE into. When it is the storage-root default (the only case
 * we own — a user-picked baseDir is their folder, not ours), it is resolved
 * through ensureStorageDir so a root that turned unwritable mid-session (Defender
 * Controlled Folder Access on Documents — LANE J/L) heals ONCE here, before the
 * project folder is created: that single heal then covers the design HTML AND
 * every asset copied next to it.
 */
async function healedBaseDir(): Promise<string> {
  const base = await readBaseDir()
  return base === defaultBaseDir() ? ensureStorageDir('designs') : base
}
async function writeBaseDir(dir: string): Promise<void> {
  await fs.writeFile(configPath(), JSON.stringify({ baseDir: dir }, null, 2), 'utf8')
}
function safeName(s: string, fallback = 'untitled'): string {
  const cleaned = (s || '')
    .replace(/[\\/:*?"<>|]/g, '-')   // strip path separators + reserved chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')             // no leading dots → neutralizes ".", ".." traversal
    .slice(0, 80)
  return cleaned || fallback
}

/**
 * Race an fs op against a timeout. The base dir is often Documents, which on
 * Windows can be a OneDrive "online-only" Known Folder where fs.mkdir/writeFile
 * BLOCK indefinitely — without this the save IPC hangs forever and the auto-save
 * silently never lands (and any awaiting caller hangs with it).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))])
}
async function writeDesignFile(baseDir: string, project: string | undefined, name: string | undefined, content: string): Promise<string> {
  const dir = path.join(baseDir, safeName(project ?? '', 'My Designs'))
  await withTimeout(fs.mkdir(dir, { recursive: true }), 4000, 'mkdir')
  const file = path.join(dir, safeName(name ?? '', 'design.html'))
  await withTimeout(fs.writeFile(file, content, 'utf8'), 4000, 'writeFile')
  return file
}

type GeneratePayload = Partial<GenerateDesignInput> & { requestId?: string }

export type DesignGenerateResult =
  | { ok: true; html: string; raw: string; code?: string }
  | { ok: false; error: string; aborted?: boolean }

// ── Folder-context reader ───────────────────────────────────────────────────────
// Walk a picked folder and concatenate a BUDGETED set of text files so the model
// understands what it's designing for. Skips dependency/build/binary noise; caps
// per-file, file-count, and total size so a huge repo can't blow up the prompt.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'vendor', '.venv', '__pycache__'])
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.vue', '.svelte', '.py', '.go', '.rs', '.rb', '.php', '.yml', '.yaml', '.toml'])
// Sized to the model context windows (Claude 200k / Gemini 1M). The design build
// budgets context to the model's real window (see designBudgets), so a real project
// can contribute far more than the old 60k-char cap.
const PER_FILE_CAP = 16_000
const TOTAL_CAP    = 300_000
const MAX_FILES    = 120

/** Priority weight — README/package.json first, then docs, then everything else. */
function priority(name: string): number {
  const n = name.toLowerCase()
  if (n.startsWith('readme')) return 0
  if (n === 'package.json' || n === 'cargo.toml' || n === 'pyproject.toml') return 1
  if (n.endsWith('.md')) return 2
  return 3
}

async function readFolderContext(root: string): Promise<{ context: string; fileCount: number }> {
  const collected: { rel: string; prio: number; text: string }[] = []
  let total = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || collected.length >= MAX_FILES || total >= TOTAL_CAP) return
    let entries: import('node:fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    // Files before subdirs so shallow, high-signal files win the budget.
    for (const e of entries) {
      if (collected.length >= MAX_FILES || total >= TOTAL_CAP) return
      if (e.isFile()) {
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue
        // Never sweep a secret-bearing file into a (possibly cloud) design prompt.
        if (isSensitiveFileName(e.name)) continue
        const full = path.join(dir, e.name)
        try {
          const stat = await fs.stat(full)
          if (stat.size > 512_000) continue // skip very large files
          const raw = await fs.readFile(full, 'utf8')
          const text = raw.slice(0, PER_FILE_CAP)
          collected.push({ rel: path.relative(root, full), prio: priority(e.name), text })
          total += text.length
        } catch { /* unreadable — skip */ }
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !isSensitiveDirName(e.name) && !e.name.startsWith('.')) {
        await walk(path.join(dir, e.name), depth + 1)
      }
    }
  }

  await walk(root, 0)
  collected.sort((a, b) => a.prio - b.prio || a.rel.localeCompare(b.rel))
  const context = collected.map(c => `### ${c.rel}\n${c.text}`).join('\n\n')
  return { context, fileCount: collected.length }
}

export function registerDesignIpc(win: BrowserWindow): void {
  const controllers = new Map<string, AbortController>()

  ipcMain.handle('design:generate', async (event, payload: unknown): Promise<DesignGenerateResult> => {
    const p = (payload ?? {}) as GeneratePayload
    if (!p.providerId || !p.model) return { ok: false, error: 'Pick a provider and a model first.' }

    const requestId = typeof p.requestId === 'string' ? p.requestId : ''
    const controller = new AbortController()
    if (requestId) controllers.set(requestId, controller)

    const emit = (chunk: string) => {
      try { event.sender.send('design:delta', { requestId, chunk }) } catch { /* window gone */ }
    }

    try {
      const { html, raw, code, finish } = await generateDesign(
        {
          providerId: p.providerId,
          model: p.model,
          prompt: p.prompt ?? '',
          presetId: p.presetId,
          designMd: p.designMd,
          currentHtml: p.currentHtml,
          refImage: p.refImage,
          context: p.context,
          mode: p.mode,
          engine: p.engine,
          history: p.history,
        },
        { onDelta: emit, signal: controller.signal },
      )
      if (p.mode === 'animate') {
        const okComposition = p.engine === 'hyperframes'
          ? !!code && /__timelines/.test(code)
          : !!code && /\bComposition\b/.test(code)
        if (!okComposition) {
          const need = p.engine === 'hyperframes'
            ? 'a valid HyperFrames composition (needs a GSAP timeline registered on window.__timelines)'
            : 'a valid Remotion composition (needs a `Composition` component)'
          // generateDesign already auto-continued a cut reply and ran one repair
          // retry — tell the user what ACTUALLY happened, not "try harder".
          const hint = finish === 'length'
            ? ' The reply kept hitting the output limit even after auto-continue — ask for a shorter/simpler animation or split it in two.'
            : ' An automatic retry was already attempted — resend (↺ edit) or rephrase.'
          return { ok: false, error: `The model did not return ${need}.${hint}` }
        }
        return { ok: true, html, raw, code }
      }
      if (!html.trim()) {
        return { ok: false, error: 'The model did not return an HTML document. Try a stronger model (Claude / GPT / Gemini) or rephrase the request.' }
      }
      return { ok: true, html, raw }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg)) return { ok: false, error: 'Generation cancelled.', aborted: true }
      return { ok: false, error: msg }
    } finally {
      if (requestId) controllers.delete(requestId)
    }
  })

  // Save a generated design to its project folder on disk. Returns the path.
  // Resilient: if the configured/default base (under Documents — a OneDrive
  // online-only folder that can block fs) fails or hangs, fall back to the
  // always-writable userData dir (the legacy designs location) so the design
  // still lands somewhere real.
  ipcMain.handle('design:save-file', async (_e, payload: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const { project, name, content } = (payload ?? {}) as { project?: string; name?: string; content?: string }
    if (typeof content !== 'string' || !content) return { ok: false, error: 'No content to save.' }
    try {
      const saved = await writeDesignFile(await healedBaseDir(), project, name, content)
      await copyReferencedAssets(content, path.dirname(saved))
      return { ok: true, path: saved }
    } catch {
      try {
        const saved = await writeDesignFile(legacyDir('designs'), project, name, content)
        await copyReferencedAssets(content, path.dirname(saved))
        return { ok: true, path: saved }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  })

  // A saved page that references attached media (`assets/<name>`) must stay a
  // standalone on-disk artifact: copy each referenced asset from the
  // DesignAssets dir next to the saved HTML. Best-effort — a missing asset
  // never fails the save.
  async function copyReferencedAssets(content: string, dir: string): Promise<void> {
    const names = new Set<string>()
    for (const m of content.matchAll(/assets\/([A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}\.[A-Za-z0-9]{2,4})/g)) names.add(m[1])
    if (names.size === 0) return
    for (const asset of names) {
      const src = resolveDesignAssetPath(asset)
      if (!src) continue
      try {
        const outDir = path.join(dir, 'assets')
        await fs.mkdir(outDir, { recursive: true })
        await fs.copyFile(src, path.join(outDir, asset))
      } catch { /* best-effort */ }
    }
  }

  // Attach one media file (video/audio/gif) as a design asset: copied into the
  // DesignAssets storage dir, referenced by generated pages as assets/<name>.
  ipcMain.handle('design:add-asset', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { path?: string; name?: string; bytes?: ArrayBuffer | Uint8Array }
    return addDesignAsset(p)
  })

  // Open a project's on-disk folder (or the base folder) in the OS file manager.
  ipcMain.handle('design:reveal', async (_e, payload: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      const { project } = (payload ?? {}) as { project?: string }
      const base = await healedBaseDir()
      const dir = project ? path.join(base, safeName(project, 'My Designs')) : base
      await fs.mkdir(dir, { recursive: true })
      const err = await shell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true, path: dir }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Read / change the base folder where designs are saved.
  ipcMain.handle('design:get-base', async (): Promise<{ baseDir: string }> => ({ baseDir: await readBaseDir() }))
  ipcMain.handle('design:set-base', async (): Promise<{ ok: boolean; baseDir?: string; error?: string }> => {
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where TACHI Design saves files' })
      if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
      await writeBaseDir(r.filePaths[0])
      return { ok: true, baseDir: r.filePaths[0] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Pick a folder → return budgeted text-file context for the model.
  ipcMain.handle('design:pick-folder', async (): Promise<{ ok: boolean; folder?: string; context?: string; fileCount?: number; error?: string }> => {
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Pick a folder to design for' })
      if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
      const folder = r.filePaths[0]
      const { context, fileCount } = await readFolderContext(folder)
      if (!context) return { ok: false, folder, error: 'No readable text files found in that folder.' }
      return { ok: true, folder, context, fileCount }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Same as pick-folder but for a folder the user DROPPED onto the composer (or
  // a path passed programmatically) — no native dialog. Validates the path is a
  // real directory before reading; the read itself skips node_modules/.git,
  // sensitive files, and caps size (readFolderContext). Never throws.
  ipcMain.handle('design:read-folder', async (_e, payload: unknown): Promise<{ ok: boolean; folder?: string; context?: string; fileCount?: number; error?: string }> => {
    const { folder } = (payload ?? {}) as { folder?: string }
    if (typeof folder !== 'string' || !folder.trim()) return { ok: false, error: 'No folder path given.' }
    try {
      const st = await fs.stat(folder)
      if (!st.isDirectory()) return { ok: false, error: 'That path is not a folder.' }
      const { context, fileCount } = await readFolderContext(folder)
      if (!context) return { ok: false, folder, error: 'No readable text files found in that folder.' }
      return { ok: true, folder, context, fileCount }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Brand-from-URL: harvest a site's real design tokens (colors/fonts/logo/copy)
  // and return a markdown "brand direction" the user can drop into the design
  // prompt. Reuses the SSRF-guarded managed-Chromium page pipeline. Never throws.
  ipcMain.handle('design:extract-brand', async (_e, payload: unknown): Promise<{ ok: boolean; brand?: import('../services/page-render').BrandKit; markdown?: string; error?: string }> => {
    const { url } = (payload ?? {}) as { url?: string }
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'Enter a site URL to extract its brand.' }
    const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
    try {
      const { harvestBrandFromPage, brandKitToMarkdown } = await import('../services/page-render')
      const brand = await harvestBrandFromPage(normalized, { win: win })
      return { ok: true, brand, markdown: brandKitToMarkdown(brand) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Discovery pass: return a few clarifying questions for the user to answer
  // before the build (Claude-Design-style interview). `structured` powers the
  // interactive option-chip card; `questions` is the plain-text rendering
  // (message body + history threading). Never throws.
  ipcMain.handle('design:clarify', async (_e, payload: unknown): Promise<{
    ok: boolean
    questions?: string
    structured?: Array<{ q: string; options: string[]; default?: string }> | null
    error?: string
  }> => {
    const p = (payload ?? {}) as GeneratePayload
    if (!p.providerId || !p.model) return { ok: false, error: 'Pick a provider and a model first.' }
    try {
      const { text, structured } = await clarifyDesign({
        providerId: p.providerId, model: p.model, prompt: p.prompt ?? '',
        presetId: p.presetId, designMd: p.designMd, refImage: p.refImage, context: p.context, mode: p.mode,
      })
      if (!text.trim()) return { ok: false, error: 'No questions came back — try GENERATE directly.' }
      return { ok: true, questions: text, structured }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Export an animation composition to a real H.264 MP4. Streams stage progress
  // via `design:render-progress`; the managed Chromium downloads on first use
  // (its `chromium:install-progress` events are relayed by the preload). Renders
  // into the user-visible storage root (Design Renders), then reveals it.
  // ── THE VIDEO ENCODER: state, install, remove ──────────────────────────────
  //
  // Three verbs rather than one, because the download is a DECISION: the UI has
  // to say what it costs and what it is BEFORE the click, and be able to undo it
  // after. `install` is never reachable from a render path — see
  // remotion-binaries-installer.ts for why bundling those binaries was wrong.
  ipcMain.handle('remotion-binaries:state', (): RemotionBinariesState => remotionBinariesState())

  ipcMain.handle('remotion-binaries:install', async (): Promise<{ ok: boolean; dir?: string; error?: string }> => {
    try { return { ok: true as const, dir: await installRemotionBinaries(win) } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('remotion-binaries:remove', (): { ok: boolean; error?: string } => removeRemotionBinaries())

  ipcMain.handle('design:render-mp4', async (event, payload: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const { code, name, targetHeight } = (payload ?? {}) as { code?: string; name?: string; targetHeight?: number }
    if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'No animation to export — generate a composition first.' }
    // Export quality picker: 1080p (default) / 1440 (2K) / 2160 (4K).
    const targetH = [1080, 1440, 2160].includes(targetHeight as number) ? (targetHeight as number) : 1080
    const emit = (p: { stage: string; percent: number; message: string }) => {
      try { event.sender.send('design:render-progress', p) } catch { /* window gone */ }
    }
    try {
      const outName = `${safeName(name ?? 'animation', 'animation')}-${Date.now()}.mp4`
      // ensureStorageDir, not storageDir: the MP4 itself is written by ffmpeg /
      // Remotion (not by us), so the only moment we can heal an unwritable root
      // is BEFORE the render starts — the probe here moves the whole export to a
      // writable root instead of burning minutes and dying on the last write.
      const outputPath = path.join(ensureStorageDir('renders'), outName)
      // Engine by content (same detection the DesignPage preview uses): a
      // HyperFrames comp registers a GSAP timeline on window.__timelines →
      // deterministic seek+capture renderer; everything else is Remotion.
      // One IPC + one Export button serve both engines.
      if (/__timelines/.test(code)) {
        const { renderHyperframesMp4 } = await import('../services/design-hf-render')
        const { outputPath: out } = await renderHyperframesMp4({ code, outputPath, onProgress: emit, targetHeight: targetH })
        shell.showItemInFolder(out)
        return { ok: true, path: out }
      }
      const { outputPath: out } = await renderDesignMp4({ code, outputPath, win: win, onProgress: emit, targetHeight: targetH })
      shell.showItemInFolder(out)
      return { ok: true, path: out }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Export a page design to PNG or PDF via a hidden, sandboxed BrowserWindow
  // (free — no managed Chromium). Lands in the storage root's Design Renders
  // folder, then reveals it.
  ipcMain.handle('design:export-image', async (_e, payload: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const { html, name, format } = (payload ?? {}) as { html?: string; name?: string; format?: 'png' | 'pdf' }
    if (typeof html !== 'string' || !html.trim()) return { ok: false, error: 'No page to export — generate a design first.' }
    const fmt = format === 'pdf' ? 'pdf' : 'png'
    try {
      const buf = fmt === 'pdf' ? await captureDesignPdf(html) : await captureDesignPng(html)
      const outName = `${safeName(name ?? 'design', 'design')}-${Date.now()}.${fmt}`
      // writeStorageFile: one re-probe + retry when the cached root turned
      // unwritable, and a CFA-tagged message (not a raw ENOENT) in the
      // { ok:false, error } this handler already surfaces.
      const outPath = writeStorageFile('renders', outName, buf)
      shell.showItemInFolder(outPath)
      return { ok: true, path: outPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Servable audio files across both audio roots (storage root + legacy
  // userData, newest first) — the Voiceover panel lists them; the same names
  // are pinned into the generation contract.
  ipcMain.handle('design:list-audio', async (): Promise<{ ok: boolean; files: Array<{ name: string; size: number; mtimeMs: number }> }> => {
    return { ok: true, files: listDesignAudio() }
  })

  // Copy an existing audio artifact (Media tab / Nodes TTS result) into the
  // audio storage dir so animate compositions can score with it.
  ipcMain.handle('design:import-audio', async (_e, payload: unknown): Promise<{ ok: boolean; file?: string; error?: string }> => {
    const { path } = (payload ?? {}) as { path?: string }
    if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'No file path.' }
    try {
      const r = importDesignAudio(path)
      return { ok: true, file: r.file }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Synthesize a voiceover line with the piper TTS sidecar into the audio
  // storage dir. Returns the bare filename the composition passes to staticFile(…) —
  // the same name plays in the live preview (tachi-preview:// serves it) and
  // muxes into the MP4 export (design-render ships the dir as publicDir).
  ipcMain.handle('design:synthesize-vo', async (_e, payload: unknown): Promise<{ ok: boolean; file?: string; path?: string; error?: string }> => {
    const { voiceId, text, name } = (payload ?? {}) as { voiceId?: string; text?: string; name?: string }
    if (typeof voiceId !== 'string' || !voiceId.trim()) return { ok: false, error: 'Pick a piper voice first (Media tab → TTS).' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'No text to speak.' }
    try {
      const r = await synthesizeDesignVo({ voiceId, text, name: typeof name === 'string' ? name : undefined })
      return { ok: true, file: r.file, path: r.path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Stash the current preview HTML so the renderer can load it from the
  // tachi-preview:// scheme (own CSP → inline scripts run; a blob iframe would
  // inherit the strict renderer CSP and block them).
  ipcMain.handle('design:set-preview', async (_e, payload: unknown): Promise<{ ok: boolean }> => {
    const { id, html } = (payload ?? {}) as { id?: string; html?: string }
    if (typeof id !== 'string' || !id || typeof html !== 'string') return { ok: false }
    if (html.length > 8 * 1024 * 1024) return { ok: false }
    setPreviewDoc(id, html)
    return { ok: true }
  })

  ipcMain.handle('design:abort', async (_e, payload: unknown): Promise<{ ok: boolean }> => {
    const requestId = (payload as { requestId?: string } | null | undefined)?.requestId
    if (requestId && controllers.has(requestId)) {
      controllers.get(requestId)!.abort()
      controllers.delete(requestId)
      return { ok: true }
    }
    return { ok: false }
  })
}
