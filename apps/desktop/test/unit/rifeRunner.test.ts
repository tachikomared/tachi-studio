// apps/desktop/test/unit/rifeRunner.test.ts
//
// THE PIPELINE, END TO END, WITH THE PROCESSES FAKED AND THE DISK REAL.
//
// Three programs run in sequence and every one of them is handed numbers the
// previous one produced. A unit test of the arg builders alone (rifePlan.test)
// proves each builder is right; it cannot prove the WIRING — that the frame
// count fed to `-n` is the count that was actually extracted, that the fps fed
// to the encoder is the probed rate times the multiplier, that the encoder runs
// from the directory rife wrote into. Those are the bugs that produce a video
// playing at the wrong speed, so they are pinned here against real argv.
//
// The children are fakes; the filesystem is NOT. The frames "written" by the
// fake ffmpeg are real files in a real temp directory, so the counting, the
// output naming and — above all — the try/finally CLEANUP are exercised for
// real. A leaked frame directory is gigabytes per attempt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const HOST = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  const root = mk(j(td(), 'tachi-rife-test-'))
  return { root, temp: j(root, 'temp'), media: j(root, 'media'), engine: j(root, 'engine') }
})

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'temp' ? HOST.temp : HOST.root), isPackaged: false },
  BrowserWindow: class {},
}))

// The installed sidecar — faked at the PATHS boundary, so the runner's real
// pipeline is exercised without a 431 MB download.
vi.mock('../../electron/services/rife-paths', () => ({
  getRifeBinaryPath: () => `${HOST.engine}/${process.platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan'}`,
  isRifeInstalled: () => rifeInstalled.value,
  rifeModelDir: () => `${HOST.engine}/rife-v4.6`,
}))

// The bundled ffmpeg (Remotion compositor). Dynamic-imported by the runner.
vi.mock('../../electron/services/design-hf-render', () => ({
  resolveHfFfmpeg: () => ffmpegPath.value,
}))

/** An executable's name on the platform the test is running on. */
const EXE = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

const rifeInstalled = vi.hoisted(() => ({ value: true }))
const ffmpegPath = vi.hoisted(() => ({ value: '' as string | null }))

/** Every spawn, in order, with the cwd it was given. */
const spawns = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }>,
  /** cmd-substring → what the fake child does before it closes. */
  behaviour: new Map<string, (args: string[], cwd: string) => { code: number; stdout?: string; stderr?: string; hold?: boolean }>(),
  live: [] as Array<{ emitClose: (code: number | null, signal: string | null) => void }>,
}))

vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  class FakeProc extends EE {
    stdout = new EE()
    stderr = new EE()
    pid = 7777
    closed = false
    kill(): boolean { this.emitClose(null, 'SIGKILL'); return true }
    emitClose(code: number | null, signal: string | null): void {
      if (this.closed) return
      this.closed = true
      this.emit('close', code, signal)
    }
  }
  return {
    spawn: (cmd: string, args: string[], opts?: { cwd?: string }) => {
      const p = new FakeProc()
      // `taskkill` is killProcessTree's Windows helper, not a pipeline stage:
      // it must reach the child the way the real one does — by ending it.
      // The victim list is captured SYNCHRONOUSLY: reading `spawns.live` inside
      // the timer let a kill from one test land on a later test's fresh child
      // (which is exactly the cross-test flake that first showed up here).
      if (cmd === 'taskkill') {
        const victims = spawns.live.slice()
        setTimeout(() => { for (const l of victims) l.emitClose(null, 'SIGKILL') }, 0)
        return p
      }
      spawns.calls.push({ cmd, args, cwd: opts?.cwd })
      const key = [...spawns.behaviour.keys()].find(k => cmd.includes(k))
      const run = key ? spawns.behaviour.get(key)! : () => ({ code: 0 })
      const out = run(args, opts?.cwd ?? '')
      spawns.live.push({ emitClose: (c, s) => p.emitClose(c, s) })
      if (!out.hold) {
        setTimeout(() => {
          if (out.stdout) p.stdout.emit('data', Buffer.from(out.stdout))
          if (out.stderr) p.stderr.emit('data', Buffer.from(out.stderr))
          p.emitClose(out.code, null)
        }, 0)
      } else if (out.stderr) {
        setTimeout(() => p.stderr.emit('data', Buffer.from(out.stderr!)), 0)
      }
      return p
    },
  }
})

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  interpolateVideo,
  cancelRifeRun,
  cancelAllRifeRuns,
  drainWithin,
  activeRifeRuns,
  resetRifeFfmpegCache,
  RIFE_QUIT_DRAIN_MS,
} from '../../electron/services/rife-runner'

// ── fixtures ──────────────────────────────────────────────────────────────────

const SOURCE = join(HOST.media, 'wan-clip.mp4')

/** ffprobe answer: 30 fps, one audio stream. */
const PROBE_30FPS_AUDIO = JSON.stringify({
  streams: [
    { codec_type: 'video', r_frame_rate: '30/1' },
    { codec_type: 'audio', r_frame_rate: '0/0' },
  ],
})

function writePngs(dir: string, n: number, from = 1): void {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `${String(from + i).padStart(8, '0')}.png`), 'x')
  }
}

/** Wait for the pipeline to reach the rife stage — never a fixed sleep, which
 *  is how a "cancel" test silently becomes a "cancel before anything started"
 *  test on a loaded machine. */
async function untilRifeSpawned(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (spawns.calls.some(c => c.cmd.includes('rife-ncnn-vulkan'))) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('rife never spawned')
}

/** Temp working directories the runner created and did not clean up. */
function leakedWorkDirs(): string[] {
  try { return readdirSync(HOST.temp).filter(n => n.startsWith('tachi-rife-')) } catch { return [] }
}

/** Wire the happy path: probe → 4 frames → 8 interpolated frames → an mp4. */
function scriptHappyPath(opts: { inputFrames?: number; outputFrames?: number; probe?: string } = {}): void {
  const inputFrames = opts.inputFrames ?? 4
  const outputFrames = opts.outputFrames ?? inputFrames * 2
  spawns.behaviour.set('ffprobe', () => ({ code: 0, stdout: opts.probe ?? PROBE_30FPS_AUDIO }))
  spawns.behaviour.set('ffmpeg', (args, cwd) => {
    // The encode step is the one whose last arg is the .mp4 output path.
    const last = args[args.length - 1]!
    if (last.endsWith('.mp4')) { writeFileSync(last, 'MP4'); return { code: 0 } }
    writePngs(cwd, inputFrames)                  // the extract step writes into its cwd
    return { code: 0 }
  })
  spawns.behaviour.set('rife-ncnn-vulkan', (args) => {
    const outDir = args[args.indexOf('-o') + 1]!
    writePngs(outDir, outputFrames)
    const lines = Array.from({ length: outputFrames }, (_, i) => `a b 0.5 -> ${outDir}/${i}.png done\n`).join('')
    return { code: 0, stderr: lines }
  })
}

beforeEach(() => {
  spawns.calls.length = 0
  spawns.live.length = 0
  spawns.behaviour.clear()
  rifeInstalled.value = true
  ffmpegPath.value = `${HOST.engine}/${EXE('ffmpeg')}`
  resetRifeFfmpegCache()
  rmSync(HOST.temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(HOST.media, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(HOST.engine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(HOST.temp, { recursive: true })
  mkdirSync(HOST.media, { recursive: true })
  mkdirSync(HOST.engine, { recursive: true })
  // The bundled ffmpeg + ffprobe must LOOK present — the runner checks. It
  // looks for `ffprobe` without the suffix off Windows, so the fixture has to
  // carry the platform's own name: with `.exe` hardcoded this file passed on
  // Windows and told Linux the encoder was missing.
  writeFileSync(join(HOST.engine, EXE('ffmpeg')), 'x')
  writeFileSync(join(HOST.engine, EXE('ffprobe')), 'x')
  writeFileSync(SOURCE, 'VIDEO')
})

afterEach(() => { vi.useRealTimers() })

// ── the happy path ────────────────────────────────────────────────────────────

describe('interpolateVideo — the wiring between the three programs', () => {
  it('runs probe → extract → rife → encode, in that order', async () => {
    scriptHappyPath()
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok, res.error).toBe(true)
    expect(spawns.calls.map(c => c.cmd.split(/[\\/]/).pop())).toEqual([
      EXE('ffprobe'), EXE('ffmpeg'), EXE('rife-ncnn-vulkan'), EXE('ffmpeg'),
    ])
  })

  it('feeds rife the count that was ACTUALLY extracted, doubled', async () => {
    scriptHappyPath({ inputFrames: 7, outputFrames: 14 })
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    const rife = spawns.calls[2]!
    expect(rife.args[rife.args.indexOf('-n') + 1]).toBe('14')
  })

  it('quadruples in ONE pass for multiplier 4 (rife-v4 accepts a custom -n)', async () => {
    scriptHappyPath({ inputFrames: 5, outputFrames: 20 })
    await interpolateVideo({ sourcePath: SOURCE, multiplier: 4, win: null })
    const rife = spawns.calls[2]!
    expect(rife.args[rife.args.indexOf('-n') + 1]).toBe('20')
    expect(spawns.calls.filter(c => c.cmd.includes('rife-ncnn-vulkan')).length).toBe(1)
  })

  it('encodes at the PROBED rate times the multiplier, keeping NTSC exact', async () => {
    scriptHappyPath({
      probe: JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '24000/1001' }] }),
    })
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    const encode = spawns.calls[3]!
    expect(encode.args[encode.args.indexOf('-framerate') + 1]).toBe('48000/1001')
  })

  it('copies the source audio when the source HAS audio, and not otherwise', async () => {
    scriptHappyPath()
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(spawns.calls[3]!.args.join(' ')).toContain('-c:a copy')

    spawns.calls.length = 0
    scriptHappyPath({ probe: JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '30/1' }] }) })
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(spawns.calls[3]!.args.join(' ')).not.toContain('-c:a')
  })

  it('runs each ffmpeg from the directory whose relative pattern it globs', async () => {
    scriptHappyPath()
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    const extract = spawns.calls[1]!
    const rife = spawns.calls[2]!
    const encode = spawns.calls[3]!
    // extract writes into its own cwd, which is the dir rife then reads with -i
    expect(rife.args[rife.args.indexOf('-i') + 1]).toBe(extract.cwd)
    // the encoder must run from the dir rife WROTE into, or %08d.png matches nothing
    expect(encode.cwd).toBe(rife.args[rife.args.indexOf('-o') + 1])
  })

  it('writes "<name>-rife2x.mp4" NEXT TO the source and reports it', async () => {
    scriptHappyPath()
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.outputPath).toBe(join(HOST.media, 'wan-clip-rife2x.mp4'))
    expect(existsSync(res.outputPath!)).toBe(true)
    expect(existsSync(SOURCE)).toBe(true)                       // the original is untouched
  })

  it('never overwrites: a second run lands beside the first', async () => {
    scriptHappyPath()
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    scriptHappyPath()
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.outputPath).toBe(join(HOST.media, 'wan-clip-rife2x-2.mp4'))
  })

  it('cleans the frame directory up — gigabytes must not survive a run', async () => {
    scriptHappyPath()
    await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(leakedWorkDirs()).toEqual([])
  })
})

// ── progress ──────────────────────────────────────────────────────────────────

describe('progress events', () => {
  it('reports real frame counts from rife\'s own completion lines, then done', async () => {
    scriptHappyPath({ inputFrames: 3, outputFrames: 6 })
    const sent: Array<{ channel: string; payload: { stage: string; percent: number; counts?: { done: number; total: number } } }> = []
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: never) => { sent.push({ channel, payload }) } },
    }
    await interpolateVideo({ sourcePath: SOURCE, win: win as never })

    expect(sent.every(s => s.channel === 'rife:progress')).toBe(true)
    expect(sent.map(s => s.payload.stage)).toContain('interpolating')
    const measured = sent.filter(s => s.payload.counts && s.payload.counts.done > 0)
    expect(measured.length).toBeGreaterThan(0)
    expect(measured[measured.length - 1]!.payload.counts).toEqual({ done: 6, total: 6 })
    expect(sent[sent.length - 1]!.payload.stage).toBe('done')
    expect(sent[sent.length - 1]!.payload.percent).toBe(100)
  })

  it('emits a TERMINAL error stage on failure — the rail must never stick', async () => {
    scriptHappyPath()
    spawns.behaviour.set('ffprobe', () => ({ code: 1, stdout: '' }))
    const sent: Array<{ stage: string }> = []
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_c: string, p: { stage: string }) => { sent.push(p) } },
    }
    await interpolateVideo({ sourcePath: SOURCE, win: win as never })
    expect(sent[sent.length - 1]!.stage).toBe('error')
  })
})

// ── cancel ────────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('kills the running child and reports a STOP, not a crash', async () => {
    scriptHappyPath()
    spawns.behaviour.set('rife-ncnn-vulkan', () => ({ code: 0, hold: true }))
    const p = interpolateVideo({ sourcePath: SOURCE, win: null })
    // Let the pipeline reach the rife spawn.
    await untilRifeSpawned()
    expect(spawns.calls.some(c => c.cmd.includes('rife-ncnn-vulkan'))).toBe(true)
    expect(cancelRifeRun(SOURCE)).toBe(true)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(res.error).toMatch(/stopped/i)
  })

  it('does not encode anything after a cancel', async () => {
    scriptHappyPath()
    spawns.behaviour.set('rife-ncnn-vulkan', () => ({ code: 0, hold: true }))
    const p = interpolateVideo({ sourcePath: SOURCE, win: null })
    await untilRifeSpawned()
    cancelRifeRun(SOURCE)
    await p
    expect(spawns.calls.filter(c => c.cmd.includes('ffmpeg')).length).toBe(1)   // extract only
    expect(existsSync(join(HOST.media, 'wan-clip-rife2x.mp4'))).toBe(false)
  })

  it('cleans the frame directory up on the cancel path too', async () => {
    scriptHappyPath()
    spawns.behaviour.set('rife-ncnn-vulkan', () => ({ code: 0, hold: true }))
    const p = interpolateVideo({ sourcePath: SOURCE, win: null })
    await untilRifeSpawned()
    cancelRifeRun(SOURCE)
    await p
    expect(leakedWorkDirs()).toEqual([])
  })

  it('answers false when nothing is running for that path', () => {
    expect(cancelRifeRun(SOURCE)).toBe(false)
  })
})

// ── quitting ──────────────────────────────────────────────────────────────────
//
// Closing the window used to leave rife-ncnn-vulkan and its ffmpeg siblings
// running — the GPU pinned after the app was gone, and the whole decoded PNG
// sequence stranded in %TEMP% because a killed process never reaches `finally`.

describe('cancelAllRifeRuns — the app is quitting', () => {
  it('stops EVERY in-flight run, not just one, and each cleans its frame dir', async () => {
    const other = join(HOST.media, 'other.mp4')
    writeFileSync(other, 'VIDEO')
    scriptHappyPath()
    spawns.behaviour.set('rife-ncnn-vulkan', () => ({ code: 0, hold: true }))
    const a = interpolateVideo({ sourcePath: SOURCE, win: null })
    const b = interpolateVideo({ sourcePath: other, win: null })
    await untilRifeSpawned()
    expect(activeRifeRuns().length).toBe(2)

    const { cancelled, drained } = cancelAllRifeRuns()
    expect(cancelled).toBe(2)                       // synchronously, before any await

    await drained
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.cancelled, rb.cancelled]).toEqual([true, true])
    expect(activeRifeRuns()).toEqual([])
    // The whole point of draining: gigabytes must not outlive the app.
    expect(leakedWorkDirs()).toEqual([])
  })

  it('reports nothing to do — and an already-settled drain — when nothing runs', async () => {
    const { cancelled, drained } = cancelAllRifeRuns()
    expect(cancelled).toBe(0)
    await expect(drained).resolves.toBeUndefined()
  })

  it('gives up after the timebox rather than holding the quit open forever', async () => {
    // A run that never unwinds must cost the quit its timebox and not one ms
    // more; the boot sweep is the backstop for whatever it leaves behind.
    const t0 = Date.now()
    await expect(drainWithin([new Promise(() => { /* never settles */ })], 25)).resolves.toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('returns as soon as the runs settle, without waiting out the timebox', async () => {
    const t0 = Date.now()
    await drainWithin([Promise.resolve('done'), Promise.reject(new Error('boom'))], 30_000)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('publishes a timebox a quit can survive', () => {
    expect(RIFE_QUIT_DRAIN_MS).toBeGreaterThan(0)
    expect(RIFE_QUIT_DRAIN_MS).toBeLessThanOrEqual(5_000)
  })
})

// ── one run per file ──────────────────────────────────────────────────────────

describe('one run per file', () => {
  it('joins a second request for the SAME file instead of racing two GPU jobs', async () => {
    scriptHappyPath()
    const a = interpolateVideo({ sourcePath: SOURCE, win: null })
    const b = interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(activeRifeRuns().length).toBe(1)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe(rb)                                       // the same promise, literally
    expect(spawns.calls.filter(c => c.cmd.includes('rife-ncnn-vulkan')).length).toBe(1)
    expect(activeRifeRuns()).toEqual([])                      // released when it settles
  })

  it('lets a DIFFERENT file proceed independently', async () => {
    const other = join(HOST.media, 'other.mp4')
    writeFileSync(other, 'VIDEO')
    scriptHappyPath()
    const [a, b] = await Promise.all([
      interpolateVideo({ sourcePath: SOURCE, win: null }),
      interpolateVideo({ sourcePath: other, win: null }),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(a.outputPath).not.toBe(b.outputPath)
  })
})

// ── refusals ──────────────────────────────────────────────────────────────────

describe('refusals — before a single process is spawned', () => {
  const noSpawn = (): void => { expect(spawns.calls).toEqual([]) }

  it('refuses a remote source — ffmpeg would happily fetch a URL', async () => {
    const res = await interpolateVideo({ sourcePath: 'https://example.com/a.mp4', win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/local file on this machine/i)
    noSpawn()
  })

  it('refuses a media:// artifact URL for the same reason', async () => {
    const res = await interpolateVideo({ sourcePath: 'media://clip.mp4', win: null })
    expect(res.ok).toBe(false)
    noSpawn()
  })

  it('refuses a file that is not there', async () => {
    const res = await interpolateVideo({ sourcePath: join(HOST.media, 'ghost.mp4'), win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no longer there/i)
    noSpawn()
  })

  it('refuses when the sidecar is not installed, and says so actionably', async () => {
    rifeInstalled.value = false
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not installed/i)
    noSpawn()
  })

  it('refuses an unsupported multiplier rather than passing it through', async () => {
    const res = await interpolateVideo({ sourcePath: SOURCE, multiplier: 3, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/2 or 4/)
    noSpawn()
  })

  it('refuses when the bundled ffmpeg cannot be resolved', async () => {
    ffmpegPath.value = null
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ffmpeg/i)
    noSpawn()
  })
})

// ── failures mid-pipeline ─────────────────────────────────────────────────────

describe('failures leave nothing behind', () => {
  it('reports a decode failure and cleans up', async () => {
    scriptHappyPath()
    spawns.behaviour.set('ffmpeg', () => ({ code: 1, stderr: 'Invalid data found' }))
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not decode/i)
    expect(res.error).toContain('Invalid data found')
    expect(leakedWorkDirs()).toEqual([])
  })

  it('refuses a clip that decoded to a single frame', async () => {
    scriptHappyPath({ inputFrames: 1 })
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least two/i)
    expect(spawns.calls.some(c => c.cmd.includes('rife-ncnn-vulkan'))).toBe(false)
  })

  it('treats "exit 0 but no frames" as the no-Vulkan failure it is', async () => {
    scriptHappyPath()
    spawns.behaviour.set('rife-ncnn-vulkan', () => ({ code: 0, stderr: 'no vulkan device' }))
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/vulkan/i)
  })

  it('deletes a half-written mp4 when the encoder fails', async () => {
    scriptHappyPath()
    const outPath = join(HOST.media, 'wan-clip-rife2x.mp4')
    spawns.behaviour.set('ffmpeg', (args, cwd) => {
      const last = args[args.length - 1]!
      if (last.endsWith('.mp4')) { writeFileSync(last, 'HALF'); return { code: 1, stderr: 'x264 error' } }
      writePngs(cwd, 4)
      return { code: 0 }
    })
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(existsSync(outPath)).toBe(false)
    expect(leakedWorkDirs()).toEqual([])
  })

  it('refuses a source whose frame rate ffprobe could not report', async () => {
    scriptHappyPath({ probe: JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '0/0' }] }) })
    const res = await interpolateVideo({ sourcePath: SOURCE, win: null })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/frame rate/i)
    expect(spawns.calls.length).toBe(1)                        // probe only
  })
})
