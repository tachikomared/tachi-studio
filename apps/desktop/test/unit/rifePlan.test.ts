// apps/desktop/test/unit/rifePlan.test.ts
//
// THE PURE HALF OF THE RIFE VERTICAL — every decision the frame-interpolation
// pipeline makes that does NOT need a process, a GPU or a disk.
//
// Frame interpolation is a pipeline of three programs (ffmpeg → rife → ffmpeg)
// wired by ARITHMETIC: get the frame count or the output fps wrong by one and
// the result is a video that plays at the wrong speed — which looks like a
// working feature until someone measures it. So the arithmetic lives here,
// exported, and is pinned against the UPSTREAM SOURCE rather than against a
// guess (rife-ncnn-vulkan src/main.cpp, tag 20221029):
//
//   • directory mode with no `-n` sets `numframe = count * 2` — N frames in,
//     2N out (NOT 2N-1: the last output is the last input re-emitted at
//     timestep 1.0, because `sx` is clamped to `count-2`). The mission brief
//     said 2N-1; the source says 2N, and 2N is what keeps duration identical.
//   • output files are named `%08d.<ext>` starting at 1 ("ffmpeg start from 1").
//   • `list_directory` sorts lexicographically, so zero-padded names are the
//     only safe ones.
//   • rife-v4.6 matches the `rife-v4` branch, so a custom `-n` is ACCEPTED
//     (every older model hard-errors on it) — which is what makes x4 a single
//     pass instead of two.
//   • `-h` prints usage and returns -1. A sanity check that expects exit 0 from
//     `-h` would fail on a perfectly good binary, so it must not be written.

import { describe, it, expect } from 'vitest'
import {
  RIFE_VERSION,
  RIFE_MODEL_DIR,
  RIFE_RELEASES,
  RIFE_MULTIPLIERS,
  MAX_INPUT_FRAMES,
  defaultRifeRelease,
  rifeExeName,
  interpolatedFrameCount,
  outputFps,
  outputRate,
  frameCountRefusal,
  rifeOutputPath,
  localVideoRefusal,
  buildExtractArgs,
  buildRifeArgs,
  buildEncodeArgs,
  buildProbeArgs,
  parseProbeFps,
  RifeFrameCounter,
  describeRifeExit,
  rifeSanityRefusal,
} from '../../electron/services/rife-plan'

// ── the pin ───────────────────────────────────────────────────────────────────

describe('the pinned release', () => {
  it('is the 20221029 tag — the first release that ships rife-v4.6', () => {
    expect(RIFE_VERSION).toBe('20221029')
    expect(RIFE_MODEL_DIR).toBe('rife-v4.6')
  })

  it('pins url + byte size + sha256 for all three platforms', () => {
    // Sizes and digests were computed from the real downloaded assets
    // (2026-07-28). A drifted pin must fail HERE, not on a user's disk.
    const expected = {
      win32:  { size: 431540241, sha: 'd8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606' },
      darwin: { size: 436537917, sha: '4a63a1f3c9c715773c57d2ee51df1b315ed20cd6c63103e45c483ecc4400b595' },
      linux:  { size: 431302796, sha: '1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68' },
    } as const
    expect(RIFE_RELEASES.length).toBe(3)
    for (const r of RIFE_RELEASES) {
      const want = expected[r.platform]
      expect(want, `unexpected platform ${r.platform}`).toBeTruthy()
      expect(r.sizeBytes).toBe(want.size)
      expect(r.sha256).toBe(want.sha)
      expect(r.url).toBe(
        `https://github.com/nihui/rife-ncnn-vulkan/releases/download/${RIFE_VERSION}/${r.filename}`,
      )
      // The archive contains ONE top-level directory; the installer lifts its
      // contents into bin/, so the name is load-bearing, not decorative.
      expect(r.archiveRoot).toBe(r.filename.replace(/\.zip$/, ''))
    }
  })

  it('every pinned sha is a real 64-hex digest (no placeholders shipped)', () => {
    for (const r of RIFE_RELEASES) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves the asset for each supported platform and refuses the rest', () => {
    expect(defaultRifeRelease('win32')?.filename).toBe('rife-ncnn-vulkan-20221029-windows.zip')
    expect(defaultRifeRelease('darwin')?.filename).toBe('rife-ncnn-vulkan-20221029-macos.zip')
    expect(defaultRifeRelease('linux')?.filename).toBe('rife-ncnn-vulkan-20221029-ubuntu.zip')
    expect(defaultRifeRelease('freebsd' as NodeJS.Platform)).toBeNull()
  })

  it('names the executable with the win32 suffix only on win32', () => {
    expect(rifeExeName('win32')).toBe('rife-ncnn-vulkan.exe')
    expect(rifeExeName('darwin')).toBe('rife-ncnn-vulkan')
    expect(rifeExeName('linux')).toBe('rife-ncnn-vulkan')
  })
})

// ── frame math ────────────────────────────────────────────────────────────────

describe('frame math (upstream: numframe = count * multiplier)', () => {
  it('doubles the frame count — 2N, not 2N-1', () => {
    expect(interpolatedFrameCount(150, 2)).toBe(300)
    expect(interpolatedFrameCount(2, 2)).toBe(4)
  })

  it('quadruples for x4 (rife-v4 accepts a custom -n, so it is ONE pass)', () => {
    expect(interpolatedFrameCount(150, 4)).toBe(600)
  })

  it('offers exactly the multipliers the UI may ask for', () => {
    expect([...RIFE_MULTIPLIERS]).toEqual([2, 4])
  })

  it('doubles fps in lockstep, so the output has the SAME duration', () => {
    expect(outputFps(30, 2)).toBe(60)
    expect(outputFps(24, 4)).toBe(96)
    // 150 frames @ 30fps = 5.000s in; 300 frames @ 60fps = 5.000s out.
    const n = 150, fps = 30
    expect(interpolatedFrameCount(n, 2) / outputFps(fps, 2)).toBeCloseTo(n / fps, 10)
  })

  it('keeps fractional source rates fractional (23.976 → 47.952, never rounded)', () => {
    expect(outputFps(24000 / 1001, 2)).toBeCloseTo(47.952047952, 6)
  })

  it('multiplies the RATIONAL numerator, so NTSC survives the round trip exactly', () => {
    expect(outputRate({ num: 24000, den: 1001 }, 2)).toEqual({ num: 48000, den: 1001 })
    expect(outputRate({ num: 30, den: 1 }, 4)).toEqual({ num: 120, den: 1 })
  })

  it('refuses a clip with fewer than two frames — rife indexes filenames[sx+1]', () => {
    expect(frameCountRefusal(0)).toMatch(/no frames/i)
    expect(frameCountRefusal(1)).toMatch(/at least two/i)
    expect(frameCountRefusal(2)).toBeNull()
  })

  it('refuses a clip past the frame cap instead of filling the temp volume', () => {
    expect(frameCountRefusal(MAX_INPUT_FRAMES)).toBeNull()
    const tooMany = frameCountRefusal(MAX_INPUT_FRAMES + 1)
    expect(tooMany).toContain(String(MAX_INPUT_FRAMES))
    expect(tooMany).toMatch(/too long|shorter/i)
  })
})

// ── output naming ─────────────────────────────────────────────────────────────

describe('rifeOutputPath — next to the source, never over it', () => {
  const none = () => false

  it('lands "<stem>-rife2x.mp4" beside the source', () => {
    expect(rifeOutputPath('C:\\clips\\wan run.mp4', 2, none)).toBe('C:\\clips\\wan run-rife2x.mp4')
    expect(rifeOutputPath('/home/u/clips/a.webm', 2, none)).toBe('/home/u/clips/a-rife2x.mp4')
  })

  it('labels the multiplier honestly', () => {
    expect(rifeOutputPath('/v/a.mp4', 4, none)).toBe('/v/a-rife4x.mp4')
  })

  it('NEVER overwrites — an existing name gets a numeric suffix', () => {
    const taken = new Set(['/v/a-rife2x.mp4', '/v/a-rife2x-2.mp4'])
    expect(rifeOutputPath('/v/a.mp4', 2, p => taken.has(p))).toBe('/v/a-rife2x-3.mp4')
  })

  it('never returns the source path itself, even for an already-interpolated file', () => {
    const src = '/v/a-rife2x.mp4'
    const out = rifeOutputPath(src, 2, p => p === src)
    expect(out).not.toBe(src)
    expect(out).toBe('/v/a-rife2x-rife2x.mp4')       // the suffix stacks; nothing is clobbered
  })
})

// ── guards ────────────────────────────────────────────────────────────────────

describe('localVideoRefusal — an honest reason, or null', () => {
  const opts = { exists: () => true, isFile: () => true }

  it('accepts an existing absolute local video file', () => {
    expect(localVideoRefusal('C:\\clips\\a.mp4', opts)).toBeNull()
    expect(localVideoRefusal('/home/u/a.mkv', opts)).toBeNull()
  })

  it('refuses anything that is not a plain absolute path', () => {
    expect(localVideoRefusal('', opts)).toMatch(/no file/i)
    expect(localVideoRefusal('clips/a.mp4', opts)).toMatch(/absolute/i)
  })

  it('refuses REMOTE and app-scheme sources — this pipeline reads bytes off disk', () => {
    for (const p of [
      'https://example.com/a.mp4',
      'http://example.com/a.mp4',
      'media://a.mp4',
      'file:///c:/a.mp4',
      'data:video/mp4;base64,AAAA',
      'blob:https://x/y',
      '\\\\server\\share\\a.mp4',
    ]) {
      expect(localVideoRefusal(p, opts), p).toMatch(/local file on this machine/i)
    }
  })

  it('refuses a container this pipeline does not read', () => {
    expect(localVideoRefusal('/v/a.txt', opts)).toMatch(/video file/i)
    expect(localVideoRefusal('/v/a', opts)).toMatch(/video file/i)
  })

  it('refuses a path that is gone, or is a directory', () => {
    expect(localVideoRefusal('/v/a.mp4', { exists: () => false, isFile: () => false })).toMatch(/no longer|not there|does not exist/i)
    expect(localVideoRefusal('/v/a.mp4', { exists: () => true, isFile: () => false })).toMatch(/not a file/i)
  })
})

// ── command construction ──────────────────────────────────────────────────────

describe('buildExtractArgs (ffmpeg → PNG sequence)', () => {
  const a = buildExtractArgs('/v/in.mp4', '%08d.png')

  it('overwrites nothing it was not given and reads the source once', () => {
    expect(a[0]).toBe('-y')
    expect(a).toContain('/v/in.mp4')
    expect(a[a.indexOf('/v/in.mp4') - 1]).toBe('-i')
  })

  it('extracts EVERY frame verbatim (-vsync 0) — no duplication, no drop', () => {
    // Without this, a VFR source silently gains or loses frames and the
    // fps arithmetic downstream is computed against a count that never existed.
    expect(a.join(' ')).toContain('-vsync 0')
  })

  it('writes the zero-padded pattern rife sorts lexicographically, LAST', () => {
    expect(a[a.length - 1]).toBe('%08d.png')
  })
})

describe('buildRifeArgs', () => {
  const base = { inDir: '/t/in', outDir: '/t/out', modelDir: '/e/bin/rife-v4.6', inputFrames: 150, multiplier: 2 as const }

  it('uses directory-in / directory-out mode with the pinned model', () => {
    const a = buildRifeArgs(base)
    expect(a[a.indexOf('-i') + 1]).toBe('/t/in')
    expect(a[a.indexOf('-o') + 1]).toBe('/t/out')
    expect(a[a.indexOf('-m') + 1]).toBe('/e/bin/rife-v4.6')
  })

  it('passes the frame count EXPLICITLY rather than trusting the default', () => {
    expect(buildRifeArgs(base)[buildRifeArgs(base).indexOf('-n') + 1]).toBe('300')
    expect(buildRifeArgs({ ...base, multiplier: 4 })[buildRifeArgs({ ...base, multiplier: 4 }).indexOf('-n') + 1]).toBe('600')
  })

  it('asks for the zero-padded png pattern the encoder then globs', () => {
    expect(buildRifeArgs(base)[buildRifeArgs(base).indexOf('-f') + 1]).toBe('%08d.png')
  })

  it('runs verbose — the per-frame "done" line is the ONLY real progress signal', () => {
    expect(buildRifeArgs(base)).toContain('-v')
  })

  it('uses a conservative default thread split (load:proc:save)', () => {
    const a = buildRifeArgs(base)
    expect(a[a.indexOf('-j') + 1]).toBe('1:2:2')
  })

  it('honours an explicit thread/gpu choice when one is given', () => {
    const a = buildRifeArgs({ ...base, jobs: '1:1:1', gpuId: -1 })
    expect(a[a.indexOf('-j') + 1]).toBe('1:1:1')
    expect(a[a.indexOf('-g') + 1]).toBe('-1')
  })

  it('omits -g entirely when no gpu is named (upstream picks the default device)', () => {
    expect(buildRifeArgs(base)).not.toContain('-g')
  })
})

describe('buildEncodeArgs (PNG sequence → H.264 mp4)', () => {
  it('encodes at the MULTIPLIED rate and starts at frame 1', () => {
    const a = buildEncodeArgs({ fps: 60, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    expect(a[a.indexOf('-framerate') + 1]).toBe('60')
    expect(a[a.indexOf('-start_number') + 1]).toBe('1')   // upstream: "ffmpeg start from 1"
  })

  it('passes a RATIONAL rate through verbatim (24000/1001 doubled stays exact)', () => {
    const rate = outputRate({ num: 24000, den: 1001 }, 2)
    const a = buildEncodeArgs({ fps: rate, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    expect(a[a.indexOf('-framerate') + 1]).toBe('48000/1001')
  })

  it('expresses a bare float as a rational too, never as a truncated decimal', () => {
    const a = buildEncodeArgs({ fps: 47.952047952047955, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    expect(a[a.indexOf('-framerate') + 1]).toMatch(/^\d+\/1000000000000$/)
  })

  it('globs a RELATIVE pattern (image2 cannot match an absolute Windows path)', () => {
    const a = buildEncodeArgs({ fps: 60, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    expect(a[a.indexOf('-i') + 1]).toBe('%08d.png')
  })

  it('carries the ORIGINAL audio through untouched when the source has any', () => {
    const a = buildEncodeArgs({ fps: 60, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: true })
    const joined = a.join(' ')
    expect(joined).toContain('-i /v/in.mp4')     // second input = the source
    expect(joined).toContain('-map 0:v:0')
    expect(joined).toContain('-map 1:a:0')
    expect(joined).toContain('-c:a copy')
    expect(joined).toContain('-shortest')
  })

  it('does not open the source at all when it is silent', () => {
    const a = buildEncodeArgs({ fps: 60, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    expect(a).not.toContain('/v/in.mp4')
    expect(a).not.toContain('-c:a')
  })

  it('emits an even-dimension yuv420p H.264 mp4 (the shape our vid_gen already emits)', () => {
    const a = buildEncodeArgs({ fps: 60, sourcePath: '/v/in.mp4', outputPath: '/v/out.mp4', hasAudio: false })
    const joined = a.join(' ')
    expect(joined).toContain('-c:v libx264')
    expect(joined).toContain('-pix_fmt yuv420p')
    expect(joined).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2')
    expect(joined).toContain('-movflags +faststart')
    expect(a[a.length - 1]).toBe('/v/out.mp4')
  })
})

// ── probing ───────────────────────────────────────────────────────────────────

describe('buildProbeArgs / parseProbeFps', () => {
  it('asks ffprobe for the rational frame rate and the audio stream, as json', () => {
    const a = buildProbeArgs('/v/in.mp4')
    expect(a.join(' ')).toContain('-print_format json')
    expect(a.join(' ')).toContain('r_frame_rate')
    expect(a[a.length - 1]).toBe('/v/in.mp4')
  })

  it('reads an integer rate', () => {
    const j = JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '30/1' }] })
    expect(parseProbeFps(j)).toEqual({ fps: 30, rate: { num: 30, den: 1 }, hasAudio: false })
  })

  it('reads NTSC 23.976 without rounding it to 24, and KEEPS the rational', () => {
    const j = JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '24000/1001' }] })
    expect(parseProbeFps(j)!.fps).toBeCloseTo(23.976023976, 9)
    expect(parseProbeFps(j)!.rate).toEqual({ num: 24000, den: 1001 })
  })

  it('reports an audio stream when one is present', () => {
    const j = JSON.stringify({ streams: [
      { codec_type: 'video', r_frame_rate: '25/1' },
      { codec_type: 'audio', r_frame_rate: '0/0' },
    ] })
    expect(parseProbeFps(j)).toEqual({ fps: 25, rate: { num: 25, den: 1 }, hasAudio: true })
  })

  it('returns null rather than a guess for 0/0, garbage or no video stream', () => {
    expect(parseProbeFps(JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '0/0' }] }))).toBeNull()
    expect(parseProbeFps(JSON.stringify({ streams: [{ codec_type: 'audio', r_frame_rate: '1/1' }] }))).toBeNull()
    expect(parseProbeFps('not json')).toBeNull()
    expect(parseProbeFps('')).toBeNull()
  })
})

// ── progress ──────────────────────────────────────────────────────────────────

describe('RifeFrameCounter — counts the producer\'s OWN completion lines', () => {
  it('counts one frame per verbose "-> … done" line', () => {
    const c = new RifeFrameCounter()
    expect(c.feed('/t/in/00000001.png /t/in/00000002.png 0.000000 -> /t/out/00000001.png done\n')).toBe(1)
    expect(c.feed('/t/in/00000001.png /t/in/00000002.png 0.500000 -> /t/out/00000002.png done\n')).toBe(2)
  })

  it('buffers a partial line until its newline arrives (never counts it twice)', () => {
    const c = new RifeFrameCounter()
    expect(c.feed('a b 0.0 -> c do')).toBe(0)
    expect(c.feed('ne\n')).toBe(1)
    expect(c.done).toBe(1)
  })

  it('ignores everything that is not a completion line', () => {
    const c = new RifeFrameCounter()
    c.feed('[0 NVIDIA GeForce RTX 3060]  queueC=2[8]  queueG=0[16]\n')
    c.feed('decode image /t/in/00000001.png failed\n')
    expect(c.done).toBe(0)
  })

  it('never reports a percent it did not measure', () => {
    const c = new RifeFrameCounter()
    expect(c.percentOf(0)).toBe(-1)          // total unknown
    c.feed('a b 0.0 -> c done\n')
    expect(c.percentOf(4)).toBe(25)
    for (let i = 0; i < 10; i++) c.feed('a b 0.0 -> c done\n')
    expect(c.percentOf(4)).toBe(100)         // clamped, never >100
  })
})

// ── exit semantics ────────────────────────────────────────────────────────────

describe('describeRifeExit — recorded from upstream main.cpp, not guessed', () => {
  it('is silent on a clean run that produced its frames', () => {
    expect(describeRifeExit({ code: 0, signal: null, framesWritten: 300, stderr: '' })).toBeNull()
  })

  it('calls a stop a stop, and drops the stderr tail', () => {
    const m = describeRifeExit({ code: null, signal: 'SIGKILL', framesWritten: 12, stderr: 'boom', cancelled: true })
    expect(m).toMatch(/stopped/i)
    expect(m).not.toContain('boom')
  })

  it('reports the platform-specific `return -1` codes as a failure, not a success', () => {
    // POSIX truncates to 255; Windows hands back the raw DWORD.
    for (const code of [255, 4294967295, 1]) {
      expect(describeRifeExit({ code, signal: null, framesWritten: 0, stderr: 'unknown model dir type' })).toContain('unknown model dir type')
    }
  })

  it('names the missing-vulkan case, which exits 0 having written nothing', () => {
    // ncnn logs "no vulkan device" and the run completes with zero output —
    // exit 0 alone is NOT proof of work.
    const m = describeRifeExit({ code: 0, signal: null, framesWritten: 0, stderr: 'no vulkan device' })
    expect(m).toMatch(/no frames/i)
    expect(m).toMatch(/vulkan|gpu/i)
  })
})

describe('rifeSanityRefusal — proving the extracted binary can actually start', () => {
  // `-h` (and a bare invocation) prints usage on STDERR and returns -1. A check
  // that asserted exit 0 would reject every healthy install; the real signal is
  // the usage banner.
  const usage = 'Usage: rife-ncnn-vulkan -0 infile -1 infile1 -o outfile [options]...\n'

  it('accepts the usage banner regardless of the non-zero exit code', () => {
    expect(rifeSanityRefusal({ code: 255, stderr: usage })).toBeNull()
    expect(rifeSanityRefusal({ code: 4294967295, stderr: usage })).toBeNull()
    expect(rifeSanityRefusal({ code: 0, stderr: usage })).toBeNull()
  })

  it('refuses when the process could not be started at all', () => {
    expect(rifeSanityRefusal({ error: 'spawn ENOENT', code: null, stderr: '' })).toMatch(/could not be started/i)
  })

  it('refuses a binary that dies without printing its own usage (missing runtime dll)', () => {
    const m = rifeSanityRefusal({ code: 3221225781, stderr: '' })
    expect(m).toMatch(/did not respond/i)
    expect(m).toContain('3221225781')
  })
})
