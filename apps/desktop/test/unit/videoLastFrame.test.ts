// apps/desktop/test/unit/videoLastFrame.test.ts
//
// THE FLF HOP'S FIRST HALF: a clip on disk → the PNG of its LAST frame.
//
// The community storyboard technique (LOWVRAM-META-RESEARCH DELTA ADDENDUM,
// "FLF CHAINING") is: render a ~5 s scene, take its LAST frame, start the NEXT
// scene from it. sd.cpp's i2v path wants an IMAGE file; a chained media node
// only has an .mp4. This module is the bridge, and everything that can go
// wrong with it is a silent wrong-picture bug, so it is pinned here:
//
//  • the LAST frame, not the first — `-sseof` seeks from the END and `-update 1`
//    keeps overwriting one file, so the final decoded frame is what survives.
//  • a clip SHORTER than the seek window still yields a frame — ffmpeg writes
//    nothing at all when the seek lands past the end, so a full-decode retry
//    has to exist (a 0-byte or absent output is NOT a frame).
//  • no ffmpeg on this machine → null, never a throw: the chain must degrade to
//    "this segment starts from text" exactly the way a failed upstream stage
//    already does.
//  • the temp PNG is CLEANED. A leaked frame per hop per run is how a
//    storyboard of N scenes fills a disk.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const HOST = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return { root: mk(j(td(), 'tachi-lastframe-test-')) }
})

vi.mock('electron', () => ({
  app: { getPath: () => HOST.root, isPackaged: false },
  BrowserWindow: class {},
}))

// The bundled ffmpeg (Remotion compositor) — the SAME resolver rife-runner
// reuses, dynamic-imported so design-hf-render stays off the boot prelude.
vi.mock('../../electron/services/design-hf-render', () => ({
  resolveHfFfmpeg: () => ffmpegPath.value,
}))

const ffmpegPath = vi.hoisted(() => ({ value: 'C:/fake/ffmpeg.exe' as string | null }))

/** Every ffmpeg spawn, with the argv it got. The fake child WRITES the output
 *  file the argv names — so the module's own existence/size checks are real. */
const spawns = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  /** What each successive spawn does: 'frame' writes bytes, 'empty' writes a
   *  0-byte file, 'nothing' writes no file at all, 'fail' exits non-zero. */
  script: [] as Array<'frame' | 'empty' | 'nothing' | 'fail'>,
  /** Bytes the fake decoder "writes" as the frame. */
  bytes: 'LAST-FRAME-PIXELS',
}))

vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  class FakeProc extends EE {
    stdout = new EE()
    stderr = new EE()
    kill(): boolean { this.emit('close', null, 'SIGKILL'); return true }
  }
  return {
    spawn: (cmd: string, args: string[]) => {
      const p = new FakeProc()
      const n = spawns.calls.length
      spawns.calls.push({ cmd, args })
      const behaviour = spawns.script[n] ?? 'frame'
      // The output path is the LAST argv entry (ffmpeg's output operand).
      const out = args[args.length - 1]!
      setTimeout(() => {
        if (behaviour === 'frame') fs.writeFileSync(out, spawns.bytes)
        else if (behaviour === 'empty') fs.writeFileSync(out, '')
        if (behaviour === 'fail') p.stderr.emit('data', Buffer.from('ffmpeg exploded'))
        p.emit('close', behaviour === 'fail' ? 1 : 0, null)
      }, 0)
      return p
    },
  }
})

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractLastFramePng,
  lastFrameDataUrl,
  resetLastFrameFfmpegCache,
} from '../../electron/services/video-last-frame'

// ── fixtures ──────────────────────────────────────────────────────────────────

const CLIP = join(HOST.root, 'segment-1.mp4')

/** Temp dirs this module leaves behind, by prefix — the leak assertion. */
function tachiFrameDirs(): string[] {
  return readdirSync(tmpdir()).filter(n => n.startsWith('tachi-lastframe-') && !n.includes('test'))
}

beforeEach(() => {
  spawns.calls.length = 0
  spawns.script.length = 0
  spawns.bytes = 'LAST-FRAME-PIXELS'
  ffmpegPath.value = 'C:/fake/ffmpeg.exe'
  resetLastFrameFfmpegCache()
  mkdirSync(HOST.root, { recursive: true })
  writeFileSync(CLIP, 'pretend-mp4-bytes')
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE ARGV — the difference between the last frame and the first one
// ═════════════════════════════════════════════════════════════════════════════

describe('extractLastFramePng: the ffmpeg invocation', () => {
  it('seeks from the END of the file, not the start', async () => {
    const dir = mkdtemp()
    await extractLastFramePng(CLIP, dir)
    const args = spawns.calls[0]!.args
    expect(args).toContain('-sseof')
    // a NEGATIVE offset — "-sseof 1" would seek to one second from the start
    expect(Number(args[args.indexOf('-sseof') + 1])).toBeLessThan(0)
  })

  it('overwrites ONE output file per decoded frame, so the last one wins', async () => {
    const dir = mkdtemp()
    await extractLastFramePng(CLIP, dir)
    const args = spawns.calls[0]!.args
    expect(args).toContain('-update')
    // -frames:v 1 would stop at the FIRST frame of the seek window — the exact
    // off-by-a-whole-scene bug this idiom exists to avoid.
    expect(args).not.toContain('-frames:v')
  })

  it('writes a .png, and returns the path it wrote', async () => {
    const dir = mkdtemp()
    const png = await extractLastFramePng(CLIP, dir)
    expect(png).toBeTruthy()
    expect(png!.toLowerCase().endsWith('.png')).toBe(true)
    expect(existsSync(png!)).toBe(true)
  })

  it('runs the ffmpeg the app already ships — never a bare "ffmpeg" from PATH', async () => {
    await extractLastFramePng(CLIP, mkdtemp())
    expect(spawns.calls[0]!.cmd).toBe('C:/fake/ffmpeg.exe')
  })

  it('names the input with -i and passes the clip path verbatim', async () => {
    await extractLastFramePng(CLIP, mkdtemp())
    const args = spawns.calls[0]!.args
    expect(args[args.indexOf('-i') + 1]).toBe(CLIP)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE SHORT-CLIP RETRY — an -sseof window past the start writes NOTHING
// ═════════════════════════════════════════════════════════════════════════════

describe('a clip shorter than the seek window still yields a frame', () => {
  it('retries with a full decode when the seek produced no file', async () => {
    spawns.script = ['nothing', 'frame']
    const png = await extractLastFramePng(CLIP, mkdtemp())
    expect(spawns.calls).toHaveLength(2)
    expect(spawns.calls[1]!.args).not.toContain('-sseof')  // full decode
    expect(spawns.calls[1]!.args).toContain('-update')     // …same last-wins idiom
    expect(png).toBeTruthy()
  })

  it('treats a 0-BYTE output as no frame at all and retries', async () => {
    // The 0-byte-output trap: the file exists, so a bare existsSync() check
    // would hand the chain an empty "picture".
    spawns.script = ['empty', 'frame']
    const png = await extractLastFramePng(CLIP, mkdtemp())
    expect(spawns.calls).toHaveLength(2)
    expect(png).toBeTruthy()
  })

  it('retries when the seek pass exits non-zero', async () => {
    spawns.script = ['fail', 'frame']
    const png = await extractLastFramePng(CLIP, mkdtemp())
    expect(spawns.calls).toHaveLength(2)
    expect(png).toBeTruthy()
  })

  it('gives up with null — never a throw — when BOTH passes come back empty', async () => {
    spawns.script = ['nothing', 'nothing']
    await expect(extractLastFramePng(CLIP, mkdtemp())).resolves.toBeNull()
  })

  it('does not retry when the first pass already produced a frame', async () => {
    await extractLastFramePng(CLIP, mkdtemp())
    expect(spawns.calls).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. FAIL-OPEN — no ffmpeg, no clip
// ═════════════════════════════════════════════════════════════════════════════

describe('the hop degrades instead of breaking the run', () => {
  it('returns null when the bundled ffmpeg cannot be located', async () => {
    ffmpegPath.value = null
    resetLastFrameFfmpegCache()
    await expect(extractLastFramePng(CLIP, mkdtemp())).resolves.toBeNull()
    expect(spawns.calls).toHaveLength(0)
  })

  it('returns null for a clip that is not on disk, without spawning', async () => {
    await expect(extractLastFramePng(join(HOST.root, 'ghost.mp4'), mkdtemp())).resolves.toBeNull()
    expect(spawns.calls).toHaveLength(0)
  })

  it('resolves the ffmpeg path ONCE per process, not once per hop', async () => {
    const dir = mkdtemp()
    await extractLastFramePng(CLIP, dir)
    await extractLastFramePng(CLIP, dir)
    // both hops ran; the assertion is that neither one re-imported/re-probed —
    // proven by the cache reset being the only way to change the answer
    ffmpegPath.value = null
    const still = await extractLastFramePng(CLIP, dir)
    expect(still).toBeTruthy()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. lastFrameDataUrl — what the graph layer actually threads
// ═════════════════════════════════════════════════════════════════════════════

describe('lastFrameDataUrl: the value a chained media node consumes', () => {
  it('is a PNG data URL carrying the extracted frame bytes', async () => {
    spawns.bytes = 'FRAME-OF-SEGMENT-1'
    const url = await lastFrameDataUrl(CLIP)
    expect(url).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(url!.split(',')[1]!, 'base64').toString('utf8')).toBe('FRAME-OF-SEGMENT-1')
  })

  it('leaves NO temp frame behind — try/finally, not best effort', async () => {
    const before = tachiFrameDirs().length
    await lastFrameDataUrl(CLIP)
    expect(tachiFrameDirs().length).toBe(before)
  })

  it('cleans up even when extraction fails', async () => {
    spawns.script = ['nothing', 'nothing']
    const before = tachiFrameDirs().length
    expect(await lastFrameDataUrl(CLIP)).toBeNull()
    expect(tachiFrameDirs().length).toBe(before)
  })

  it('is null (never a throw) for a missing clip', async () => {
    await expect(lastFrameDataUrl(join(HOST.root, 'nope.mp4'))).resolves.toBeNull()
  })

  it('is null for an empty path', async () => {
    await expect(lastFrameDataUrl('')).resolves.toBeNull()
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

let seq = 0
function mkdtemp(): string {
  const d = join(HOST.root, `out-${seq++}`)
  mkdirSync(d, { recursive: true })
  return d
}
