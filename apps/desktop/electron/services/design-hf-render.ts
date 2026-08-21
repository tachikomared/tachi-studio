// apps/desktop/electron/services/design-hf-render.ts
//
// HyperFrames composition → MP4. Spec Option B (HYPERFRAMES-INTEGRATION-SPEC-
// 2026-07-02): the spec preferred shelling out to the hyperframes CLI, but that
// path needs a bundled portable Node + a ~200MB npm install + its own Chrome —
// against the sidecar-diet goal. OUR generator only emits the v1 contract
// (single composition, one paused GSAP timeline, no audio, no sub-comps), which
// makes the deterministic-seek renderer small:
//
//   hidden sandboxed BrowserWindow (design-capture pattern, gsap INLINED)
//     → per frame: window.__timelines[id].seek(t) + double-rAF settle
//     → CDP Page.captureScreenshot (clip = composition size)
//     → PNG sequence → Remotion's ALREADY-BUNDLED ffmpeg (libx264 + image2,
//       probe-verified) → H.264 MP4. Zero new dependencies.
//
// v1 limitations (documented, inherent to the contract we generate):
// silent MP4; <video>/<audio> children are not frame-synced (the prompt steers
// compositions to pure CSS/SVG/typography).

import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import {
  resolveRemotionBinariesDir, remotionBinaryNames, REMOTION_BINARIES_MISSING,
} from './remotion-binaries-installer'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { buildHyperframesCaptureHtml, extractHyperframesMeta, HYPERFRAMES_COMPOSITION_ID } from '@tachi/core'
import { getGsapSource, setPreviewDoc, PREVIEW_SCHEME } from './preview-protocol'

const FPS = 30
/**
 * Locate the ffmpeg Remotion's compositor package carries.
 *
 * IT IS NO LONGER BUNDLED. Those binaries self-report
 * `libavcodec license: nonfree and unredistributable`, so shipping them made us
 * the distributor of something that says it may not be distributed. The package
 * is excluded from the build and fetched on an explicit click instead — see
 * remotion-binaries-installer.ts, which owns the whole story.
 *
 * This function is now a thin read of that one resolver, so the encoder this
 * path spawns and the encoder Remotion's own renderer spawns can never be two
 * different files.
 */
export function resolveHfFfmpeg(): string | null {
  const dir = resolveRemotionBinariesDir()
  if (!dir) return null
  const p = join(dir, remotionBinaryNames().ffmpeg)
  return existsSync(p) ? p : null
}

function runFfmpeg(ffmpeg: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { cwd, windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
    proc.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`))
    })
  })
}

export interface HfRenderProgress { stage: string; percent: number; message: string }

/**
 * Render a HyperFrames composition to an H.264 MP4 at `outputPath`.
 * Deterministic by the composition contract: same seek → same pixels.
 */
export async function renderHyperframesMp4(opts: {
  code: string
  outputPath: string
  onProgress?: (p: HfRenderProgress) => void
  /** Export quality target: minimum output height in px (1080 default; 1440 = 2K, 2160 = 4K). */
  targetHeight?: number
}): Promise<{ outputPath: string }> {
  const code = opts.code?.trim()
  if (!code) throw new Error('No composition to export — generate one first.')
  const emit = (stage: string, percent: number, message: string) => { try { opts.onProgress?.({ stage, percent, message }) } catch { /* listener gone */ } }

  const ffmpeg = resolveHfFfmpeg()
  if (!ffmpeg) throw new Error(REMOTION_BINARIES_MISSING)

  const gsap = getGsapSource()
  if (!gsap) throw new Error('Vendored gsap could not be loaded — HyperFrames export needs it.')

  const meta = extractHyperframesMeta(code)
  const frames = Math.max(1, Math.ceil(meta.duration * FPS))
  // Export QUALITY target (parity with the Remotion path): compositions preview
  // at 1280×720-ish, but exports hit the user's chosen height (1080p default,
  // 2K/4K selectable). Zooming the capture window re-renders the CSS at N×
  // (crisp vector/text scaling, not pixel upscale). Quarter-step scale keeps
  // dimensions tidy; ×6 cap bounds memory (4K from a 360p comp).
  const targetH = Math.min(2160, Math.max(480, opts.targetHeight ?? 1080))
  const scale = Math.min(6, Math.max(1, Math.ceil((targetH / Math.max(1, meta.height)) * 4) / 4))
  const outW = Math.round(meta.width * scale)
  const outH = Math.round(meta.height * scale)
  // Error collector rides ahead of gsap+composition so a thrown composition
  // script surfaces as a REASON in our failure message, not a silent no-timeline.
  const collector = '<script>window.__hfErrs=[];window.addEventListener("error",function(e){window.__hfErrs.push(String(e.message||e))})</script>'
  const html = collector + buildHyperframesCaptureHtml(code, gsap)

  emit('prepare', 2, `Preparing ${outW}×${outH} · ${meta.duration}s · ${frames} frames`)
  const workDir = mkdtempSync(join(app.getPath('temp'), 'tachi-hf-'))
  const framesDir = join(workDir, 'frames')
  mkdirSync(framesDir)

  // Serve the capture doc via tachi-preview:// — the app's strict global CSP
  // (script-src 'self') kills inline scripts on file:// pages (the SAME bug
  // class that once broke the packaged live-preview), so a temp-file load would
  // silently never run gsap or the composition. The preview scheme is the
  // proven CSP-safe path the live preview already uses.
  const docId = `hf-capture-${Date.now().toString(36)}`
  setPreviewDoc(docId, html)

  const t0 = Date.now()
  // Stage logging is deliberate: this pipeline hangs invisibly if a capture or
  // encode step stalls (the seek/capture/ffmpeg failure modes we debugged).
  const log = (m: string) => console.log(`[hf-render] +${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`)
  const win = new BrowserWindow({
    // frame:false + useContentSize so the CONTENT area (what capturePage grabs)
    // is EXACTLY the (scaled) composition size — a framed window's content is
    // smaller than its outer width/height by the border+titlebar, which cropped
    // the capture. Sized at the EXPORT resolution; zoomFactor below re-renders
    // the composition to fill it.
    // offscreen: a hidden-but-real window is CLAMPED to the display's work
    // area by the OS (a 2560×1440 monitor capped 4K exports at 2560×1392).
    // OSR isn't an OS window, so 2K/4K surfaces render at full size; the
    // seek + settle + capturePage loop is unchanged.
    width: outW, height: outH, show: false, frame: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  try {
    // The constructor clamps bounds to the display work area even for OSR;
    // an explicit setContentSize AFTER construction is honoured for offscreen
    // surfaces (no OS window to clamp against).
    win.setContentSize(outW, outH)
    const [actualW, actualH] = win.getContentSize()
    log(`content size requested ${outW}×${outH}, actual ${actualW}×${actualH}`)
    log('loadURL start')
    await win.loadURL(`${PREVIEW_SCHEME}://doc/${docId}`)
    if (scale > 1) win.webContents.setZoomFactor(scale)
    log(`loadURL done (scale ×${scale} → ${outW}×${outH})`)
    // Belt & braces: an overflowing composition must never paint scrollbars
    // into the export.
    await win.webContents.insertCSS('html,body{overflow:hidden!important}').catch(() => {})
    // DPI calibration: OSR paints at the display's scale factor, so the CSS
    // viewport can come out SMALLER than the composition (a 1920px stage on a
    // 150% display got 1280 CSS px → scrollbars + the right third cropped).
    // Measure the real CSS viewport and counter-zoom until it matches.
    const innerW = await win.webContents.executeJavaScript('window.innerWidth') as number
    if (innerW > 0 && Math.abs(innerW - meta.width) > 1) {
      const z = win.webContents.getZoomFactor() * (innerW / meta.width)
      win.webContents.setZoomFactor(z)
      await new Promise(r => setTimeout(r, 50))
      const w2 = await win.webContents.executeJavaScript('window.innerWidth').catch(() => 0)
      log(`viewport calibrated: ${innerW} → ${w2} CSS px (target ${meta.width}, zoom ×${z.toFixed(3)})`)
    }
    // Fonts settle (bounded) + the composition script must have registered its
    // timeline. Poll briefly — the contract requires synchronous registration,
    // so one tick is normally enough.
    await win.webContents.executeJavaScript(
      `Promise.race([document.fonts.ready.then(()=>1), new Promise(r=>setTimeout(()=>r(0),4000))])`,
    ).catch(() => {})
    const id = JSON.stringify(HYPERFRAMES_COMPOSITION_ID)
    const ready = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        const tls = window.__timelines || {}
        if (tls[${id}] || Object.keys(tls).length > 0) return { ok: true }
        await new Promise(r => setTimeout(r, 50))
      }
      return { ok: false, gsap: typeof window.gsap, errs: (window.__hfErrs || []).slice(0, 3) }
    })()`) as { ok: boolean; gsap?: string; errs?: string[] }
    if (!ready.ok) {
      throw new Error(`The composition never registered a GSAP timeline on window.__timelines — cannot render. (gsap=${ready.gsap}; page errors: ${ready.errs?.join(' | ') || 'none'})`)
    }
    log(`timeline ready (gsap=${ready.gsap})`)

    // Seek + capture via first-party webContents APIs only. NOT the CDP
    // Page.captureScreenshot: in a never-shown window it waits forever for a
    // full-page composite (the hang we diagnosed). capturePage() returns the
    // current rendered frame of a hidden window (paintWhenInitiallyHidden is on
    // by default) and, since the window is exactly the composition size, needs
    // no beyond-viewport capture. executeJavaScript + capturePage are the same
    // client, so no DevTools deadlock either.
    for (let i = 0; i < frames; i++) {
      const t = i / FPS
      await win.webContents.executeJavaScript(`(async () => {
        const tls = window.__timelines || {};
        const tl = tls[${id}] || tls[Object.keys(tls)[0]];
        tl.pause(); tl.seek(${t});
        if (window.__hfApplyClips) window.__hfApplyClips(${t});
        await new Promise(r => setTimeout(r, 20));
        return 1;
      })()`)
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: outW, height: outH })
      writeFileSync(join(framesDir, `f${String(i).padStart(5, '0')}.png`), img.toPNG())
      if (i % 15 === 0 || i === frames - 1) {
        emit('capture', Math.round(((i + 1) / frames) * 80), `Capturing frame ${i + 1}/${frames}`)
      }
    }

    log('all frames captured, encoding')
    emit('encode', 85, 'Encoding H.264…')
    mkdirSync(dirname(opts.outputPath), { recursive: true })
    // Run FROM framesDir with a RELATIVE pattern: the image2 demuxer's %05d glob
    // does not match an absolute Windows path. The scale filter forces even
    // dimensions (HiDPI capturePage can yield odd w/h, which libx264 rejects).
    await runFfmpeg(ffmpeg, [
      '-y',
      '-framerate', String(FPS),
      '-start_number', '0',
      '-i', 'f%05d.png',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      opts.outputPath,
    ], framesDir)
    emit('done', 100, 'MP4 ready')
    return { outputPath: opts.outputPath }
  } finally {
    try { if (!win.isDestroyed()) win.destroy() } catch { /* already gone */ }
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* temp cleanup best-effort */ }
  }
}
