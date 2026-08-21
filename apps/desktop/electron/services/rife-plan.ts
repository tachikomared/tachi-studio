// apps/desktop/electron/services/rife-plan.ts
//
// THE RIFE VERTICAL'S PURE CORE — the pin, the arithmetic, the guards and every
// argv this pipeline will ever spawn. No electron, no fs, no child_process, and
// (deliberately) NO NETWORK PRIMITIVE ANYWHERE: frame interpolation is a purely
// local operation, and a module that cannot reach the network cannot leak.
//
// ── WHY THE ARITHMETIC IS A MODULE AND NOT THREE INLINE EXPRESSIONS ───────────
//
// Interpolation is three programs wired by numbers (ffmpeg → rife → ffmpeg).
// Every failure mode that matters is arithmetic: an off-by-one frame count or a
// mis-doubled fps produces a video that PLAYS, at the wrong speed, and looks
// like a working feature until someone measures it. So the numbers are exported
// and pinned by a test against the upstream source rather than against a guess.
//
// ── WHAT UPSTREAM ACTUALLY DOES (rife-ncnn-vulkan, tag 20221029, src/main.cpp)
//
//  • Directory mode (`-i dir -o dir`): `numframe` defaults to `count * 2`, then
//    for i in [0, numframe): `fx = i * (count / numframe)`, `sx = floor(fx)`,
//    and `sx` is CLAMPED to `count - 2` (with `fx = 1.0`). So N frames in give
//    exactly 2N out — the last one being the last input frame re-emitted, NOT
//    2N-1. 2N is also the count that keeps the duration identical at 2× fps.
//  • Outputs are named `%08d.<ext>` starting at **1** ("ffmpeg start from 1").
//  • `list_directory` sorts lexicographically → zero-padded names are the only
//    safe input names.
//  • The model is chosen by SUBSTRING of the `-m` path: `rife-v2` / `rife-v3` /
//    `rife-v4` / `rife`. `rife-v4.6` hits the v4 branch, and ONLY the v4 branch
//    accepts a custom `-n`/`-s` ("only rife-v4 model support custom numframe
//    and timestep"). That is what makes ×4 one pass instead of two.
//  • `-h`, an unknown flag, and a missing argument all `print_usage()` to
//    **stderr** and `return -1`. So `-h` exits 255 (POSIX) / 4294967295
//    (Windows DWORD) — a sanity check that expects exit 0 from `-h` would
//    reject every healthy install.
//
// ── WHY THE 20221029 TAG, AND WHY IT IS 431 MB ────────────────────────────────
//
// The committed research verdict said "~20-25 MB incl model dirs". That is
// wrong by a factor of ~18: every release ships ELEVEN model directories
// (rife, rife-HD, rife-UHD, rife-anime, v2, v2.3, v2.4, v3.0, v3.1, v4, v4.6),
// ~448 MB unpacked, of which the one we use — rife-v4.6 — is 11 MB. There is no
// smaller official asset: upstream publishes one zip per platform and nothing
// else. 20221029 is the newest release AND the first one that contains
// rife-v4.6 at all, so it is both the current and the minimum viable pin.

import { extname } from 'path'

// ─── The pin ──────────────────────────────────────────────────────────────────

/** Upstream release tag. Bumping this REQUIRES re-computing all three digests. */
export const RIFE_VERSION = '20221029'

/** The model directory we run. Must contain "rife-v4" — see the header. */
export const RIFE_MODEL_DIR = 'rife-v4.6'

/** Files that must exist inside RIFE_MODEL_DIR for the install to be usable. */
export const RIFE_MODEL_FILES = ['flownet.param', 'flownet.bin'] as const

export interface RifeRelease {
  platform: 'win32' | 'darwin' | 'linux'
  filename: string
  url: string
  /** EXACT asset size in bytes (verified against the real download). */
  sizeBytes: number
  /** EXACT sha256 of the asset (computed from the real download). */
  sha256: string
  /** The single top-level directory inside the zip. */
  archiveRoot: string
}

const RELEASE_BASE = `https://github.com/nihui/rife-ncnn-vulkan/releases/download/${RIFE_VERSION}`

function release(platform: RifeRelease['platform'], suffix: string, sizeBytes: number, sha256: string): RifeRelease {
  const archiveRoot = `rife-ncnn-vulkan-${RIFE_VERSION}-${suffix}`
  const filename = `${archiveRoot}.zip`
  return { platform, filename, url: `${RELEASE_BASE}/${filename}`, sizeBytes, sha256, archiveRoot }
}

/**
 * The three official assets, size- and sha256-verified from real downloads on
 * 2026-07-28. macOS ships ONE asset for both architectures (upstream builds a
 * universal binary), so this table is keyed by platform, not platform+arch.
 */
export const RIFE_RELEASES: readonly RifeRelease[] = [
  release('win32',  'windows', 431540241, 'd8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606'),
  release('darwin', 'macos',   436537917, '4a63a1f3c9c715773c57d2ee51df1b315ed20cd6c63103e45c483ecc4400b595'),
  release('linux',  'ubuntu',  431302796, '1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68'),
]

/** The asset for a platform, or null where upstream publishes nothing. */
export function defaultRifeRelease(platform: NodeJS.Platform): RifeRelease | null {
  return RIFE_RELEASES.find(r => r.platform === platform) ?? null
}

/** Executable name inside the archive root. */
export function rifeExeName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan'
}

// ─── Frame math ───────────────────────────────────────────────────────────────

/** Multipliers the UI may ask for. ×4 is ONE pass (`-n 4N`), not two runs. */
export const RIFE_MULTIPLIERS = [2, 4] as const
export type RifeMultiplier = typeof RIFE_MULTIPLIERS[number]

/**
 * The frame cap. 3600 frames is two minutes at 30 fps, and at 1080p its PNG
 * sequence is already several GB of temp — past that the honest answer is "trim
 * the clip", not "fill the user's disk and fail at 94%".
 */
export const MAX_INPUT_FRAMES = 3600

/** Upstream's own rule: `numframe = count * multiplier`. N in → 2N out at ×2. */
export function interpolatedFrameCount(inputFrames: number, multiplier: RifeMultiplier): number {
  return inputFrames * multiplier
}

/** The rate the interpolated sequence must be encoded at to keep the duration. */
export function outputFps(sourceFps: number, multiplier: RifeMultiplier): number {
  return sourceFps * multiplier
}

/** A frame rate as the EXACT rational the container declared. */
export interface FrameRate { num: number; den: number }

/**
 * The output rate, still rational.
 *
 * Multiplying the NUMERATOR (not the decimal) is what keeps 24000/1001 exact
 * through the pipeline: the float round-trip of 23.976023976… reintroduces an
 * error ffmpeg would then bake into every timestamp.
 */
export function outputRate(rate: FrameRate, multiplier: RifeMultiplier): FrameRate {
  return { num: rate.num * multiplier, den: rate.den }
}

/** Honest reason a frame count cannot be interpolated, or null. */
export function frameCountRefusal(inputFrames: number): string | null {
  if (!Number.isFinite(inputFrames) || inputFrames <= 0) {
    return 'That video decoded to no frames at all — nothing to interpolate.'
  }
  if (inputFrames < 2) {
    // rife reads filenames[sx+1]; with one frame that index does not exist.
    return 'Frame interpolation needs at least two frames — this clip has one.'
  }
  if (inputFrames > MAX_INPUT_FRAMES) {
    return `That clip is too long for frame interpolation: ${inputFrames} frames, and the limit is ` +
      `${MAX_INPUT_FRAMES} (about two minutes at 30 fps). Interpolate a shorter clip.`
  }
  return null
}

// ─── Output naming ────────────────────────────────────────────────────────────

/**
 * `<stem>-rife<N>x.mp4`, NEXT TO the source and never over an existing file.
 *
 * The extension is forced to `.mp4` because that is what we re-encode to (H.264
 * in mp4 — the container our local vid_gen already emits and the one the media
 * gallery's <video> can always play), regardless of what the source was.
 */
export function rifeOutputPath(
  sourcePath: string,
  multiplier: RifeMultiplier,
  exists: (p: string) => boolean,
): string {
  // NOT path.join: on Windows it rewrites every '/' to '\', so a POSIX path
  // handed to this function came back mangled — which a test caught before it
  // could reach a user. Splitting on the source's OWN last separator keeps the
  // path byte-identical apart from the name we are replacing.
  const cut = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'))
  const dir = sourcePath.slice(0, cut + 1)
  const file = sourcePath.slice(cut + 1)
  const ext = extname(file)
  const stem = ext ? file.slice(0, -ext.length) : file
  const base = `${dir}${stem}-rife${multiplier}x`
  let candidate = `${base}.mp4`
  let n = 1
  // Bounded on purpose: an unbounded loop against a hostile `exists` would hang
  // main. 999 collisions on one stem is not a real state.
  while (exists(candidate) && n < 1000) {
    n++
    candidate = `${base}-${n}.mp4`
  }
  return candidate
}

// ─── Guards ───────────────────────────────────────────────────────────────────

/** Containers ffmpeg will be asked to decode. */
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.gif', '.mpg', '.mpeg', '.wmv'])

export interface LocalPathProbe {
  exists(p: string): boolean
  isFile(p: string): boolean
}

/**
 * "Is this a local video file we may read?" — an honest reason, or null.
 *
 * The installer-kit `notAFileReason` idiom: return the SENTENCE, never a
 * boolean, so the refusal that reaches the user is the refusal the code made.
 *
 * REMOTE IS REFUSED OUTRIGHT. This pipeline hands a path to ffmpeg, and ffmpeg
 * will happily open an http(s) URL — which would turn a "local, zero-egress"
 * feature into an arbitrary outbound fetch driven by a renderer string. A UNC
 * path (`\\server\share`) is refused for the same reason.
 */
export function localVideoRefusal(path: string, probe: LocalPathProbe): string | null {
  const p = typeof path === 'string' ? path.trim() : ''
  if (!p) return 'No file was given to interpolate.'
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//') || p.startsWith('\\\\')) {
    // Windows drive letters (`C:\…`) are two chars and would match the scheme
    // regex, so they are excluded before it runs.
    if (!/^[a-z]:[\\/]/i.test(p)) {
      return 'Frame interpolation only runs on a local file on this machine — save the video first, then interpolate it.'
    }
  }
  const absolute = /^[a-z]:[\\/]/i.test(p) || p.startsWith('/')
  if (!absolute) return 'Frame interpolation needs an absolute path — this one is relative.'
  if (!VIDEO_EXTS.has(extname(p).toLowerCase())) {
    return `That is not a video file this pipeline reads (${extname(p) || 'no extension'}).`
  }
  if (!probe.exists(p)) return 'That file is no longer there.'
  if (!probe.isFile(p)) return 'That path is not a file.'
  return null
}

// ─── Command construction ─────────────────────────────────────────────────────

/** The zero-padded pattern every stage of this pipeline agrees on. */
export const FRAME_PATTERN = '%08d.png'

/**
 * ffmpeg: decode the source into a PNG sequence.
 *
 * `-vsync 0` (a.k.a. `-fps_mode passthrough`) is load-bearing: without it a
 * variable-frame-rate source is silently re-timed to CFR, gaining or losing
 * frames, and every count downstream is then computed against a frame set that
 * never existed. Run FROM the frames directory (relative pattern).
 */
export function buildExtractArgs(sourcePath: string, pattern: string = FRAME_PATTERN): string[] {
  return ['-y', '-i', sourcePath, '-vsync', '0', pattern]
}

export interface RifeArgsInput {
  inDir: string
  outDir: string
  modelDir: string
  inputFrames: number
  multiplier: RifeMultiplier
  /** load:proc:save thread split. Conservative default — this runs on a laptop. */
  jobs?: string
  /** Explicit device (-1 = CPU). Omitted entirely when undefined: upstream then
   *  picks the default GPU, which is the right answer on every normal machine. */
  gpuId?: number
}

export function buildRifeArgs(input: RifeArgsInput): string[] {
  const args = [
    '-i', input.inDir,
    '-o', input.outDir,
    '-m', input.modelDir,
    // EXPLICIT rather than relying on the `count * 2` default: the count is the
    // one number the whole pipeline is arithmetic on, so it is stated, and a
    // ×4 run is the same single pass with a different number.
    '-n', String(interpolatedFrameCount(input.inputFrames, input.multiplier)),
    '-f', FRAME_PATTERN,
    '-j', input.jobs ?? '1:2:2',
    // The per-frame "… -> … done" line only exists under -v, and it is the ONLY
    // progress this binary emits. Without it the rail would have to invent one.
    '-v',
  ]
  if (typeof input.gpuId === 'number') args.push('-g', String(input.gpuId))
  return args
}

/**
 * A rate as an ffmpeg `-framerate` argument.
 *
 * A RATIONAL passes through verbatim (`24000/1001` stays exact). A bare float
 * is expressed as a rational too rather than as a truncated decimal — 23.976…
 * doubled is 47.952…, and a decimal there drifts against the copied audio.
 */
export function fpsArg(fps: number | FrameRate): string {
  if (typeof fps !== 'number') return `${fps.num}/${fps.den}`
  if (Number.isInteger(fps)) return String(fps)
  const den = 1_000_000_000_000
  return `${Math.round(fps * den)}/${den}`
}

export interface EncodeArgsInput {
  /** The OUTPUT rate — rational where the source declared one. */
  fps: number | FrameRate
  sourcePath: string
  outputPath: string
  /** Whether the SOURCE carries an audio stream worth copying across. */
  hasAudio: boolean
}

/**
 * ffmpeg: the interpolated PNG sequence back into an H.264 mp4.
 *
 * Run FROM the frames directory with a RELATIVE pattern — the image2 demuxer's
 * `%08d` glob does not match an absolute Windows path (the same trap
 * design-hf-render documents). `-start_number 1` because rife names its first
 * output `00000001.png`.
 *
 * Audio is COPIED, never re-encoded: interpolation does not touch the audio, so
 * re-encoding it would be a silent quality loss for nothing. `-shortest` guards
 * the rounding case where the video track ends a frame before the audio does.
 */
export function buildEncodeArgs(input: EncodeArgsInput): string[] {
  const args = [
    '-y',
    '-framerate', fpsArg(input.fps),
    '-start_number', '1',
    '-i', FRAME_PATTERN,
  ]
  if (input.hasAudio) args.push('-i', input.sourcePath, '-map', '0:v:0', '-map', '1:a:0')
  args.push(
    // libx264 rejects odd dimensions; a source that decoded to an odd height
    // would otherwise fail at the very last step of a long run.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
  )
  if (input.hasAudio) args.push('-c:a', 'copy', '-shortest')
  args.push('-movflags', '+faststart', input.outputPath)
  return args
}

// ─── Probing ──────────────────────────────────────────────────────────────────

/** ffprobe: the source's rational frame rate + whether it has audio, as JSON. */
export function buildProbeArgs(sourcePath: string): string[] {
  return [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,r_frame_rate',
    '-print_format', 'json',
    sourcePath,
  ]
}

/**
 * Read the source rate out of ffprobe's JSON. Returns null rather than a
 * GUESS: an unknown rate must stop the run, because every downstream number is
 * derived from it and "assume 30" would silently re-time the user's video.
 */
export function parseProbeFps(stdout: string): { fps: number; rate: FrameRate; hasAudio: boolean } | null {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  const streams = (parsed as { streams?: unknown })?.streams
  if (!Array.isArray(streams)) return null
  let rate: FrameRate | null = null
  let hasAudio = false
  for (const s of streams as Array<{ codec_type?: string; r_frame_rate?: string }>) {
    if (s?.codec_type === 'audio') hasAudio = true
    if (s?.codec_type !== 'video' || rate !== null) continue
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s.r_frame_rate ?? ''))
    if (!m) continue
    const num = Number(m[1]); const den = Number(m[2])
    if (!den || !num || !Number.isFinite(num / den)) continue
    rate = { num, den }
  }
  if (!rate || !(rate.num / rate.den > 0)) return null
  return { fps: rate.num / rate.den, rate, hasAudio }
}

// ─── Progress ─────────────────────────────────────────────────────────────────

/**
 * Counts rife's OWN per-frame completion lines off a stderr stream.
 *
 * Under `-v` each finished frame prints `<in0> <in1> <timestep> -> <out> done`.
 * That line is a measurement the binary made; everything else it prints (device
 * banner, queue sizes, decode failures) is not, and is ignored rather than
 * pattern-matched into a fake percent.
 *
 * Chunk-boundary safe, exactly like YtDlpProgressParser: a partial line is held
 * until its newline arrives, so a frame is never counted twice or dropped.
 */
export class RifeFrameCounter {
  private buf = ''
  /** Frames the binary has reported finished. */
  done = 0

  /** Feed a stderr chunk; returns the running count. */
  feed(chunk: string): number {
    this.buf += chunk
    const lines = this.buf.split(/\r?\n/)
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      if (/->.*\bdone\s*$/.test(line.trim())) this.done++
    }
    return this.done
  }

  /** 0..100 against a known total, or -1 when the total is not a measurement. */
  percentOf(total: number): number {
    if (!Number.isFinite(total) || total <= 0) return -1
    return Math.max(0, Math.min(100, Math.round((this.done / total) * 100)))
  }
}

// ─── Exit semantics ───────────────────────────────────────────────────────────

const STDERR_TAIL_LINES = 6

function tailOf(stderr: string): string {
  return stderr
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-STDERR_TAIL_LINES)
    .join('\n')
}

/**
 * What killed a rife run — or null when nothing did.
 *
 * EXIT 0 IS NOT PROOF OF WORK. When ncnn finds no Vulkan device the binary logs
 * it, writes nothing, and still exits 0; accepting that would hand the encoder
 * an empty directory and surface as a baffling ffmpeg error three steps later.
 * So success is `code === 0 AND frames were written`.
 */
export function describeRifeExit(input: {
  code: number | null
  signal: NodeJS.Signals | null
  framesWritten: number
  stderr: string
  cancelled?: boolean
}): string | null {
  const { code, signal, framesWritten, stderr, cancelled } = input
  if (code === 0 && framesWritten > 0) return null
  if (cancelled) return 'Frame interpolation was stopped before it finished.'
  if (code === 0) {
    return 'rife-ncnn-vulkan exited cleanly but wrote no frames. That is what a machine with no usable ' +
      'Vulkan GPU looks like — this engine needs one.' + (stderr ? `\n${tailOf(stderr)}` : '')
  }
  const how = signal ? `was killed by ${signal}` : `exited ${code}`
  return `rife-ncnn-vulkan ${how}.${stderr ? `\n${tailOf(stderr)}` : ''}`
}

/**
 * Post-install sanity: can the extracted binary actually START on this machine?
 *
 * THE TRAP THIS ENCODES: `-h` prints usage on **stderr** and `return -1` —
 * exit 255 on POSIX, 4294967295 (the raw DWORD) on Windows. A check written as
 * "run -h, expect exit 0" would therefore reject every healthy install. The
 * honest signal is the USAGE BANNER: printing it proves the image loaded, its
 * runtime DLLs resolved and main() ran. The exit code is ignored on purpose.
 */
export function rifeSanityRefusal(input: { error?: string; code: number | null; stderr: string }): string | null {
  if (input.error) {
    return `The rife-ncnn-vulkan binary could not be started: ${input.error}`
  }
  if (input.stderr.includes('rife-ncnn-vulkan')) return null
  return `The rife-ncnn-vulkan binary did not respond to a usage probe (exit ${input.code ?? 'none'}). ` +
    'The download may be damaged, or a system runtime it needs is missing.'
}
