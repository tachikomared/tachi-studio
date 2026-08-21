// apps/desktop/electron/services/video-last-frame.ts
//
// THE FLF HOP: a rendered clip → the PNG of its LAST frame.
//
// WHY THIS EXISTS. The community "10 s scenes → minutes" technique
// (LOWVRAM-META-RESEARCH-2026-07-28 DELTA ADDENDUM, "FLF CHAINING"): render a
// short scene, take its LAST frame, hand it to the next scene as the i2v start
// image, repeat. Wan 2.1/2.2 FLF2V is confirmed at our engine pin and the app
// already routes an init frame (params.image_url → --init-img), so the ONLY
// missing piece on the canvas was the frame itself: a media→media wire out of a
// VIDEO node carries an .mp4, and an i2v stage needs a PICTURE.
//
// WHAT IT COSTS, HONESTLY. This is a PIXEL round-trip, not a latent handoff —
// the deliberate NO in WORKFLOWS §2. Every hop decodes to RGB and re-encodes,
// so colour and identity drift ACCUMULATE down a chain; the community patches
// that with temporal colour matching and we have no equivalent. Cheap in
// wall-clock next to the generation itself (zero VRAM, post-decode) and the
// same ffmpeg the app already ships — but never free, and never lossless.
//
// THE TWO-PASS SHAPE. `-sseof -N` seeks from the END of the file, and
// `-update 1` makes the image2 muxer overwrite ONE output file per decoded
// frame, so the file left standing is the last frame. Two traps force a retry:
// a clip SHORTER than the seek window makes ffmpeg write nothing at all, and a
// container it cannot seek in can exit non-zero. The retry is the same idiom
// with a FULL decode — slower, always correct. A 0-byte output counts as no
// frame (the file exists; the picture does not).
//
// EVERY failure path returns null rather than throwing: a missing frame must
// degrade the chain to "this segment starts from text", exactly the way a
// failed upstream stage already does in runMediaPhase.

import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** How far back from the end the fast pass decodes. Long enough to contain the
 *  final frame of any sane clip at any fps; short enough that the fast pass is
 *  genuinely fast on a long video. */
const SEEK_FROM_END_SECONDS = 2

/** A stuck decoder must not hang Run-all forever. A Wan segment is ~5 s of
 *  video; two minutes is a ceiling no healthy extraction approaches. */
const FFMPEG_TIMEOUT_MS = 120_000

/**
 * The ffmpeg (fetched, not bundled — see remotion-binaries-installer), resolved AT MOST ONCE per process — same reuse point (and
 * same promise-caching reason) as rife-runner: `import()` keeps design-hf-render
 * and the @tachi/core graph behind it off the boot prelude, and caching the
 * PROMISE means two hops starting in the same tick share one module evaluation
 * instead of racing two.
 */
let ffmpegPromise: Promise<string | null> | null = null

function resolveFfmpeg(): Promise<string | null> {
  if (!ffmpegPromise) {
    ffmpegPromise = import('./design-hf-render')
      .then(({ resolveHfFfmpeg }) => resolveHfFfmpeg())
      .catch(() => null)
  }
  return ffmpegPromise
}

/** Tests only — drop the cached module resolution. */
export function resetLastFrameFfmpegCache(): void { ffmpegPromise = null }

/** Run ffmpeg to completion. Resolves with its exit code; never rejects — the
 *  caller decides what an unusable result means (here: try the other pass). */
function runFfmpeg(ffmpeg: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (code: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code) } }
    const proc = spawn(ffmpeg, args, { windowsHide: true })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } done(null) }, FFMPEG_TIMEOUT_MS)
    // stderr is drained so a chatty ffmpeg cannot fill its pipe and deadlock.
    proc.stderr?.on('data', () => { /* drained on purpose */ })
    proc.on('error', () => done(null))
    proc.on('close', (code) => done(code))
  })
}

/** A file that exists AND has bytes. The 0-byte output is the trap this names. */
function isRealFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 0 } catch { return false }
}

/**
 * Extract the LAST frame of `videoPath` into `outDir` as a PNG.
 * Returns the PNG path, or null when there is no ffmpeg, no clip, or no frame.
 * The caller owns `outDir` and therefore the cleanup (see lastFrameDataUrl).
 */
export async function extractLastFramePng(videoPath: string, outDir: string): Promise<string | null> {
  if (!videoPath || !existsSync(videoPath)) return null
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return null

  const out = join(outDir, 'last-frame.png')
  const common = ['-y', '-hide_banner', '-loglevel', 'error']
  // `-update 1` + image2: every decoded frame overwrites `out`, so what remains
  // when the decode ends IS the last frame. Deliberately NO `-frames:v 1` — that
  // would stop at the FIRST frame of the seek window (a whole scene off).
  const tail = ['-update', '1', '-f', 'image2', out]

  const seek = [...common, '-sseof', String(-SEEK_FROM_END_SECONDS), '-i', videoPath, ...tail]
  const code = await runFfmpeg(ffmpeg, seek)
  if (code === 0 && isRealFile(out)) return out

  // Shorter than the seek window / unseekable container → full decode.
  try { rmSync(out, { force: true }) } catch { /* nothing written */ }
  const full = [...common, '-i', videoPath, ...tail]
  const code2 = await runFfmpeg(ffmpeg, full)
  return code2 === 0 && isRealFile(out) ? out : null
}

/**
 * The value the graph layer threads: the last frame as a PNG data URL, matching
 * what resolveWiredImages already hands every provider (a filesystem path would
 * be meaningless to the cloud branches). The temp PNG is removed in `finally` —
 * a leaked frame per hop per run is how a storyboard of N scenes fills a disk.
 */
export async function lastFrameDataUrl(videoPath: string): Promise<string | null> {
  if (!videoPath || !existsSync(videoPath)) return null
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'tachi-lastframe-'))
    const png = await extractLastFramePng(videoPath, dir)
    if (!png) return null
    return `data:image/png;base64,${readFileSync(png).toString('base64')}`
  } catch {
    return null
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}
