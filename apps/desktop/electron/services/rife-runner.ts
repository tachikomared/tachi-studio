// apps/desktop/electron/services/rife-runner.ts
//
// LOCAL FRAME INTERPOLATION — one video file in, one smoother video file out.
//
//   ffprobe  → the source's rational frame rate + does it have audio
//   ffmpeg   → decode every frame verbatim into a PNG sequence  (-vsync 0)
//   rife     → N frames become N×multiplier, on the GPU, rife-v4.6
//   ffmpeg   → re-encode at multiplier× fps, audio copied through
//
// ── THREE PROPERTIES THIS FILE EXISTS TO KEEP ────────────────────────────────
//
//  1. ZERO EGRESS. Interpolation is a local computation on a local file, so it
//     runs in PRIVATE MODE unchanged — and to make that a FACT rather than a
//     promise, this module imports no network primitive at all (rifeWiring
//     asserts it) and localVideoRefusal rejects any http/https/media:/UNC path
//     before it can reach ffmpeg, which would otherwise happily fetch a URL.
//  2. STOP MEANS THE GPU STOPS. Every child is registered the instant it is
//     spawned and killed with the shared killProcessTree — on Windows
//     `proc.kill()` reaches our process and leaves its children running.
//  3. THE TEMP DIR ALWAYS GOES. A 300-frame 1080p PNG sequence is gigabytes;
//     leaving one behind on the failure path would be a disk leak per attempt.
//     The whole pipeline is inside one try/finally.
//
// ── FFMPEG IS NOT INSTALLED, IT IS ALREADY HERE ──────────────────────────────
//
// The app ships Remotion's compositor package, which carries ffmpeg 7.1 (libx264
// + the image2 demuxer, probe-verified by design-hf-render) AND ffprobe, side by
// side in one directory. `resolveHfFfmpeg()` is that resolver — packaged builds
// read the asarUnpacked tree, dev resolves through @remotion/renderer's own
// links — and ffprobe is its sibling. Nothing is downloaded, and PATH is never
// assumed. design-hf-render is loaded with a dynamic `import()` so this vertical
// adds nothing to the boot prelude.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import { app, type BrowserWindow } from 'electron'
import { killProcessTree } from './util/kill-tree'
// rife-PATHS, not rife-installer: the installer imports installer-kit, which
// imports `https`. Keeping it off this graph is what makes the zero-egress
// claim structural rather than a promise (rifeWiring asserts it transitively).
import { getRifeBinaryPath, isRifeInstalled, rifeModelDir } from './rife-paths'
import { REMOTION_BINARIES_MISSING } from './remotion-binaries-message'
import {
  FRAME_PATTERN,
  RIFE_MULTIPLIERS,
  buildEncodeArgs,
  buildExtractArgs,
  buildProbeArgs,
  buildRifeArgs,
  describeRifeExit,
  frameCountRefusal,
  interpolatedFrameCount,
  localVideoRefusal,
  outputRate,
  parseProbeFps,
  rifeOutputPath,
  RifeFrameCounter,
  type RifeMultiplier,
} from './rife-plan'

// ─── Progress ─────────────────────────────────────────────────────────────────

export type RifeRunStage = 'probing' | 'extracting' | 'interpolating' | 'encoding' | 'done' | 'error' | 'cancelled'

export interface RifeRunProgress {
  /** The source path — the job identity, so a second surface can follow it. */
  jobId: string
  stage: RifeRunStage
  message: string
  /** 0..100 when measured, -1 when it is not. Never invented. */
  percent: number
  counts?: { done: number; total: number }
  outputPath?: string
  error?: string
}

function push(win: BrowserWindow | null, e: RifeRunProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('rife:progress', e)
}

export interface RifeRunResult {
  ok: boolean
  outputPath?: string
  error?: string
  cancelled?: boolean
}

// ─── Concurrency + cancel ─────────────────────────────────────────────────────
//
// ONE RUN PER FILE. The job id IS the source path: two clicks on the same card
// join one run (rather than racing two GPU jobs onto the same output name), and
// two different files may legitimately proceed independently.

interface ActiveRun {
  proc: ReturnType<typeof spawn> | null
  cancelled: boolean
  promise: Promise<RifeRunResult>
}

const active = new Map<string, ActiveRun>()

/**
 * The ffmpeg/ffprobe pair, resolved AT MOST ONCE per process.
 *
 * NOT bundled any more — Remotion's compositor is fetched on an explicit click
 * because its FFmpeg states its own licence forbids redistribution. This path
 * therefore reports the same actionable sentence every other consumer does.
 *
 * `import()` is what keeps design-hf-render (and the @tachi/core graph behind
 * it) off the boot prelude. Caching the PROMISE — not just the result — means
 * two runs starting in the same tick share one module evaluation instead of
 * racing two, which is both cheaper and the difference between a deterministic
 * and an intermittently-failing load.
 */
let ffmpegPairPromise: Promise<{ ffmpeg: string; ffprobe: string } | null> | null = null

function resolveFfmpegPair(): Promise<{ ffmpeg: string; ffprobe: string } | null> {
  if (!ffmpegPairPromise) {
    ffmpegPairPromise = import('./design-hf-render')
      .then(({ resolveHfFfmpeg }) => {
        const ffmpeg = resolveHfFfmpeg()
        if (!ffmpeg) return null
        // ffprobe ships in the SAME compositor directory as ffmpeg — verified
        // on disk, never assumed from PATH.
        const ffprobe = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
        return existsSync(ffprobe) ? { ffmpeg, ffprobe } : null
      })
      .catch(() => null)
  }
  return ffmpegPairPromise
}

/** Tests only — drop the cached module resolution. */
export function resetRifeFfmpegCache(): void { ffmpegPairPromise = null }

/** Normalized job key. Case-insensitive on Windows, where paths are. */
function jobKey(sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
}

/**
 * Stop a run. Returns whether a kill was ISSUED — never a promise that the
 * process is already gone; the run learns that from its own `close` event.
 */
export function cancelRifeRun(sourcePath: string): boolean {
  const run = active.get(jobKey(sourcePath))
  if (!run) return false
  run.cancelled = true
  return killProcessTree(run.proc)
}

/** Job ids currently in flight (the renderer re-syncs its buttons off this). */
export function activeRifeRuns(): string[] {
  return [...active.keys()]
}

// ─── Quitting is not a cancel, and it used to behave like neither ─────────────
//
// Closing the window left rife-ncnn-vulkan and its ffmpeg siblings running: the
// GPU stayed pinned after the app was gone (the same class the owner hit with
// sd-cli), and — because a killed PROCESS never returns to `_run`'s `finally` —
// the multi-gigabyte PNG sequence in %TEMP% was stranded forever. Property 2 and
// property 3 at the top of this file were both true of a Stop CLICK and false of
// a quit.
//
// So the quit path needs two things the per-job cancel does not: every run at
// once, and a brief WINDOW in which the runs it just killed can unwind far
// enough to delete their own frame directories.

/**
 * How long the app may hold a quit open while cancelled runs unwind. Long enough
 * for a `finally` to `rmSync` a frame directory, short enough that a wedged run
 * cannot make Quit look broken. The boot sweep (graph-to-agentkit) is the
 * backstop for whatever does not make it.
 */
export const RIFE_QUIT_DRAIN_MS = 4_000

/**
 * Resolve when every task has settled OR when `ms` has elapsed — whichever comes
 * first, and never by rejecting: a caller with a deadline wants to know that the
 * WINDOW is over, not that one of the tasks failed.
 */
export function drainWithin(tasks: Array<Promise<unknown>>, ms: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    void Promise.allSettled(tasks).then(() => { clearTimeout(timer); resolve() })
  })
}

/**
 * Stop EVERY in-flight interpolation — the app-quit path.
 *
 * `cancelled` is returned SYNCHRONOUSLY, and every kill has already been issued
 * by the time it is: the caller (main.ts's will-quit) can only decide whether to
 * hold the quit open after it knows there is something to hold it for, and a
 * decision that arrived a tick later would arrive after the process was gone.
 *
 * A run whose child is between stages has no process to kill; marking it
 * cancelled is still what stops it, because the pipeline re-checks `cancelled`
 * after every stage. That is why the count is "runs condemned", not "kills
 * issued" — the latter would report 0 for a run that does stop.
 */
export function cancelAllRifeRuns(timeboxMs: number = RIFE_QUIT_DRAIN_MS): {
  cancelled: number
  /** Settles when the condemned runs have unwound, or when the timebox expires. */
  drained: Promise<void>
} {
  const pending: Array<Promise<RifeRunResult>> = []
  // A snapshot: each run deletes its own key from `active` when it settles, and
  // that can happen while this loop is still going.
  for (const [key, run] of [...active.entries()]) {
    cancelRifeRun(key)
    pending.push(run.promise)
  }
  return { cancelled: pending.length, drained: drainWithin(pending, timeboxMs) }
}

// ─── The pipeline ─────────────────────────────────────────────────────────────

export interface RifeRunInput {
  sourcePath: string
  multiplier?: number
  win: BrowserWindow | null
}

export function interpolateVideo(input: RifeRunInput): Promise<RifeRunResult> {
  const key = jobKey(input.sourcePath)
  const existing = active.get(key)
  if (existing) return existing.promise           // one run per file — join it
  const run: ActiveRun = { proc: null, cancelled: false, promise: Promise.resolve({ ok: false }) }
  run.promise = _run(input, run).finally(() => { active.delete(key) })
  active.set(key, run)
  return run.promise
}

async function _run(input: RifeRunInput, run: ActiveRun): Promise<RifeRunResult> {
  const jobId = input.sourcePath
  const fail = (error: string): RifeRunResult => {
    push(input.win, { jobId, stage: 'error', message: error, percent: 0, error })
    return { ok: false, error }
  }
  const stopped = (): RifeRunResult => {
    const error = 'Frame interpolation was stopped.'
    push(input.win, { jobId, stage: 'cancelled', message: error, percent: -1, error })
    return { ok: false, error, cancelled: true }
  }

  // ── Guards, cheapest-and-most-honest first ─────────────────────────────────
  const multiplier = (RIFE_MULTIPLIERS as readonly number[]).includes(input.multiplier ?? 2)
    ? ((input.multiplier ?? 2) as RifeMultiplier)
    : null
  if (multiplier === null) {
    return fail(`Unsupported interpolation factor: ${input.multiplier}. Use ${RIFE_MULTIPLIERS.join(' or ')}.`)
  }

  const pathRefusal = localVideoRefusal(input.sourcePath, {
    exists: p => existsSync(p),
    isFile: p => { try { return statSync(p).isFile() } catch { return false } },
  })
  if (pathRefusal) return fail(pathRefusal)

  if (!isRifeInstalled()) {
    return fail('The frame-interpolation engine is not installed yet. Install rife-ncnn-vulkan first.')
  }
  const rifeBin = getRifeBinaryPath()
  if (!rifeBin) return fail('The rife-ncnn-vulkan binary could not be resolved. Reinstall the engine.')

  // The ffmpeg the app already ships (Remotion's compositor). Loaded lazily so
  // this vertical costs the boot prelude nothing.
  const pair = await resolveFfmpegPair()
  if (!pair) {
    // ONE sentence for the whole app: the encoder is a download now, and
    // "reinstall dependencies" is advice a packaged-app user cannot act on.
    return fail(REMOTION_BINARIES_MISSING)
  }
  const { ffmpeg, ffprobe } = pair

  const workDir = mkdtempSync(join(app.getPath('temp'), 'tachi-rife-'))
  const inDir = join(workDir, 'in')
  const outDir = join(workDir, 'out')

  try {
    mkdirSync(inDir); mkdirSync(outDir)

    // ── 1. probe ────────────────────────────────────────────────────────────
    push(input.win, { jobId, stage: 'probing', message: 'Reading the source…', percent: -1 })
    const probe = await runProc(ffprobe, buildProbeArgs(input.sourcePath), workDir, run)
    if (run.cancelled) return stopped()
    const meta = parseProbeFps(probe.stdout)
    if (!meta) {
      return fail('Could not read this video\'s frame rate, so there is no honest rate to interpolate to.')
    }

    // ── 2. extract ──────────────────────────────────────────────────────────
    push(input.win, { jobId, stage: 'extracting', message: 'Decoding frames…', percent: -1 })
    const extract = await runProc(ffmpeg, buildExtractArgs(input.sourcePath, FRAME_PATTERN), inDir, run)
    if (run.cancelled) return stopped()
    if (extract.code !== 0) return fail(`ffmpeg could not decode this video (exit ${extract.code}).\n${tail(extract.stderr)}`)

    const inputFrames = countPngs(inDir)
    const countRefusal = frameCountRefusal(inputFrames)
    if (countRefusal) return fail(countRefusal)

    // ── 3. interpolate ──────────────────────────────────────────────────────
    const targetFrames = interpolatedFrameCount(inputFrames, multiplier)
    const counter = new RifeFrameCounter()
    push(input.win, {
      jobId, stage: 'interpolating',
      message: `Interpolating ${inputFrames} → ${targetFrames} frames`,
      percent: 0, counts: { done: 0, total: targetFrames },
    })
    const rife = await runProc(
      rifeBin,
      buildRifeArgs({ inDir, outDir, modelDir: rifeModelDir(), inputFrames, multiplier }),
      workDir,
      run,
      chunk => {
        const done = counter.feed(chunk)
        push(input.win, {
          jobId, stage: 'interpolating',
          message: `Interpolating ${inputFrames} → ${targetFrames} frames`,
          percent: counter.percentOf(targetFrames),
          counts: { done, total: targetFrames },
        })
      },
    )
    if (run.cancelled) return stopped()
    const framesWritten = countPngs(outDir)
    const died = describeRifeExit({ code: rife.code, signal: rife.signal, framesWritten, stderr: rife.stderr })
    if (died) return fail(died)

    // ── 4. encode ───────────────────────────────────────────────────────────
    // The name is chosen HERE, right before the write, so a file that appeared
    // beside the source during the (minutes-long) interpolation is still seen.
    const outputPath = rifeOutputPath(input.sourcePath, multiplier, p => existsSync(p))
    push(input.win, { jobId, stage: 'encoding', message: 'Encoding the result…', percent: -1 })
    const encode = await runProc(
      ffmpeg,
      buildEncodeArgs({
        fps: outputRate(meta.rate, multiplier),
        sourcePath: input.sourcePath,
        outputPath,
        hasAudio: meta.hasAudio,
      }),
      outDir,
      run,
    )
    if (run.cancelled) return stopped()
    if (encode.code !== 0 || !existsSync(outputPath)) {
      // A half-written mp4 is worse than none: it plays for two seconds and
      // then stops, which reads as "the feature is broken" forever after.
      try { rmSync(outputPath, { force: true }) } catch { /* */ }
      return fail(`ffmpeg could not encode the interpolated video (exit ${encode.code}).\n${tail(encode.stderr)}`)
    }

    push(input.win, { jobId, stage: 'done', message: 'Interpolated', percent: 100, outputPath })
    return { ok: true, outputPath }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  } finally {
    // GIGABYTES. Always, on every path, including a throw and a cancel.
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    run.proc = null
  }
}

// ─── Process plumbing ─────────────────────────────────────────────────────────

interface ProcResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/**
 * Spawn one child, register it for cancel, collect its output.
 *
 * NEVER REJECTS on a non-zero exit: every stage of this pipeline has its own
 * honest message for failure, and a throw here would replace it with a stack.
 * A spawn error IS a rejection — that is a different fact (the program is not
 * runnable) and the caller's catch turns it into a message.
 */
function runProc(
  cmd: string,
  args: string[],
  cwd: string,
  run: ActiveRun,
  onStderr?: (chunk: string) => void,
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return }

    // Registered BEFORE the first await point, so a cancel that arrives one
    // millisecond after the spawn still finds a handle to kill.
    run.proc = proc
    if (run.cancelled) killProcessTree(proc)

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      // rife -v prints one line per FRAME: keeping the whole stream would hold
      // megabytes for nothing. The counter has already read it by then.
      stderr = (stderr + text).slice(-20_000)
      onStderr?.(text)
    })
    proc.on('error', (err: Error) => { run.proc = null; reject(err) })
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      run.proc = null
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function countPngs(dir: string): number {
  try { return readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')).length }
  catch { return 0 }
}

function tail(stderr: string): string {
  return stderr.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean).slice(-6).join('\n')
}
