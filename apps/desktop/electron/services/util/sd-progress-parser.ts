// apps/desktop/electron/services/util/sd-progress-parser.ts
//
// Tail-buffer parser for stable-diffusion.cpp (sd-cli) stdout/stderr output.
//
// ── WHY THIS FILE HAS PHASES (driver finding, speed A/B 2026-07-31) ──────────
//
// It used to answer one question — "what is the newest N/M on the wire" — with
// one regex, `/\b(?:step\s+)?(\d+)\s*\/\s*(\d+)\b/`. sd.cpp prints far more
// N/M than sampler steps, so the newest one was almost never a step. The
// activity strip's own log of a 4-step Wan 14B render
// (D:\projects\tachidecktests\driver-speedab\S3A-gen.log):
//
//     16s   21% · 107/517       ← t5xxl TENSORS, labelled "generating"
//    106s   99% · 513/517
//    116s   32% · 414/1303      ← a NEW file: the bar jumps BACKWARD
//    143s  100% · 1303/1303     ← "finished", with 12 more minutes to run
//    ...    100% · 1303/1303    ← frozen there for eight minutes
//    638s   25% · 1/4           ← the first real sampler step
//    868s  100% · 64/64         ← the VAE decoder's tensors, called "generating"
//
// So: the bar timed the WEIGHT LOADER, then sat at 100% through the whole
// render. On the 14B cold path the load alone is ~11 minutes, which is why the
// lie was big enough to look like a hang.
//
// ── THE DISCRIMINATOR ────────────────────────────────────────────────────────
//
// Every bar sd.cpp draws carries a RATE, and the rate names the counter's unit:
//
//   loading    |##########        | 328/686 - 2.46GB/s      '#' fill, BYTE rate
//   sampling   |======>           |   1/8  - 1.22it/s       '='/'>' fill, ITER rate
//
// Across the six captured -v traces in D:\projects\tachidecktests\engine-probes
// the split is clean (35 byte-rate bars, 88 iteration-rate bars, zero mixing
// the two fill alphabets). The RATE is the primary test rather than the fill,
// because a bar that has not moved yet is all spaces in both alphabets —
// `|            | 1/108 - 0.00MB/s` is a real line from controlB.log.
//
// Two more N/M shapes are NOT progress and are excluded by name:
//   `generating image: 1/1 - seed 12345`   ← the BATCH index (read as 100%)
//   `loading 108/194 tensors from <path>`  ← the -v text form of a load
//
// And one line is a trap in the other direction: `sampling using Euler A
// method` is printed when the sampler is CONFIGURED — in cliBaseline1.log it
// lands three lines BEFORE the first tensor bar — so it can never be the signal
// that sampling started. Only a sampler BAR is.
//
// The parser therefore:
//   1. Strips ANSI escape codes (colours, `\x1b[K` cursor rewrites).
//   2. Dedupes repeated identical lines (sd-cli overwrites in place with \r).
//   3. Classifies each line into a PHASE and that phase's own counter.
//   4. Keeps the phase MONOTONIC (loading → sampling → decoding), so the
//      decode-stage weight load cannot re-open "loading" at 100% over a render
//      that is still going.
//   5. Emits a "Starting..." heartbeat until the first real progress line.

/**
 * Which part of the run the numbers describe.
 *
 * 'decoding' carries NO fraction on purpose: sd.cpp emits a tensor bar for the
 * VAE's own weights and then nothing at all while `computing vae decode graph`
 * runs — which on video is the single longest step (103s of a 189s render in
 * controlA.log). A phase name is the honest answer; a made-up percentage is not.
 */
export type SdPhase = 'starting' | 'loading' | 'sampling' | 'decoding'

export interface SdProgress {
  /** SAMPLER step index. Null unless `phase === 'sampling'`. */
  step:  number | null
  /** Total sampler steps. Null unless `phase === 'sampling'`. */
  total: number | null
  /**
   * Completion 0-100 OF THE CURRENT PHASE, -1 when unknown or unmeasurable.
   *
   * Phase-scoped, not run-scoped, and that is the whole fix: a loading percent
   * is a true statement about the loader and a false one about the render, so
   * it only ever travels next to `phase`.
   */
  percent: number
  /** Human-readable status line, stripped of ANSI. */
  message: string
  /** True during the heartbeat window before real progress lines arrive. */
  heartbeat: boolean
  /** What the numbers above are about. */
  phase: SdPhase
}

// ─── ANSI stripping ───────────────────────────────────────────────────────────

// Covers SGR codes (colours, bold, etc.) + EL/cursor-movement sequences
// that sd-cli uses for in-place progress rewrites.
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|[()][0-9A-Z]|[^[\]()])/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ─── Line classification ──────────────────────────────────────────────────────

/**
 * A BYTE rate closing a bar ⇒ its N/M counts TENSORS.
 *   `- 2.46GB/s`  `- 644.24MB/s`  `- 0.00MB/s`
 *
 * The complement is the SAMPLER's rate, in iterations: `- 1.22it/s` when a step
 * is quicker than a second and `- 4.67s/it` when it is not (the 14B prints the
 * inverted form for its whole run). That one is not a regex here on purpose —
 * a bar closing with neither rate, on an older build or through a wrapper, is
 * still not a file transfer, so "not a byte rate" is the safer test than "is an
 * iteration rate".
 */
const BYTE_RATE_RE = /-\s*[\d.]+\s*(?:[KMGT]i?)?B\/s/i

/**
 * Any drawn progress bar: `|fill| N/M` or `[fill] N/M`. The fill alphabet is
 * deliberately NOT part of the match — the rate decides which phase it is, and
 * an unstarted bar is all spaces either way.
 */
const BAR_RE = /[[|][#=>\s]*[\]|]\s*(\d+)\s*\/\s*(\d+)/

/** The -v text form of a tensor load: `loading 108/194 tensors from <path>`. */
const LOAD_COUNT_RE = /\bloading\s+(\d+)\s*\/\s*(\d+)\s+tensors\b/i

/**
 * A load ANNOUNCEMENT with no counter — `loading model from '…'`, `loading
 * diffusion model from …`, `loading t5xxl from …`, `loading vae from …`.
 * Enough to name the phase before the first bar arrives.
 */
const LOAD_FROM_RE = /\bloading\s+[\w .\-]*\bfrom\b/i

/**
 * THE BATCH COUNTER, which the old regex read as 100%:
 * `generating image: 1/1 - seed 12345`. It says an image is STARTING, never how
 * far along it is.
 */
const BATCH_RE = /\bgenerating\s+(?:image|video)\s*:/i

/** An explicit `step 3 / 20`. No shipped build emits it; kept because a line
 *  that literally says "step" cannot be anything else. */
const STEP_TEXT_RE = /\bstep\s+(\d+)\s*\/\s*(\d+)\b/i

/**
 * Sampling is over and the VAE has the latents. Both paths, at the log level
 * the app actually runs at (no `-v`): the image path prints `sampling
 * completed` / `decoding N latents` at INFO, the video path prints `generating
 * latent video completed` / `decode_video_outputs latent …` at INFO.
 */
const DECODE_RE = /\bsampling completed\b|\bgenerating (?:latent video|\d+ latent images?) completed\b|\bdecode_first_stage\b|\bdecode_video_outputs\b|\bdecoding \d+ latents?\b|\bcomputing vae decode\b/i

/** A bare `15%` / `100%` / `75.0%`. sd.cpp does not emit these; a wrapper might. */
const PCT_RE = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/

/** What one line of engine output proves. */
export interface SdLineEvent {
  /** The phase this line is evidence of, or null when it says nothing. */
  phase:  SdPhase | null
  /** That phase's counter, or null when the line carries none. */
  done:   number | null
  total:  number | null
  /** A bare percentage with no phase of its own. */
  percent: number | null
}

const NOTHING: SdLineEvent = { phase: null, done: null, total: null, percent: null }

/**
 * Classify ONE already-ANSI-stripped line. Pure, and exported so the regexes
 * can be asserted against verbatim engine output rather than against prose
 * about it (test/unit/sdProgressPhases.test.ts).
 *
 * Order matters, and it is the order of specificity: the two named N/M shapes
 * that are NOT progress are settled before anything is allowed to read a
 * counter out of them.
 */
export function classifySdLine(raw: string): SdLineEvent | null {
  const line = stripAnsi(raw).trim()
  if (!line) return null

  // 1. The -v text load, which carries an N/M that is tensors.
  const loadText = LOAD_COUNT_RE.exec(line)
  if (loadText) {
    const total = Number(loadText[2])
    return { phase: 'loading', done: Number(loadText[1]), total: total > 0 ? total : null, percent: null }
  }

  // 2. Decode / end-of-sampling markers. Checked before the bars because
  //    `decoding 1 latents` must not be mistaken for anything countable.
  if (DECODE_RE.test(line)) return { phase: 'decoding', done: null, total: null, percent: null }

  // 3. A DRAWN BAR — the rate says which counter it is. Checked before the
  //    batch line because a bar is unambiguous evidence and some builds draw
  //    one behind the `generating image:` label.
  const bar = BAR_RE.exec(line)
  if (bar) {
    const done  = Number(bar[1])
    const total = Number(bar[2])
    if (total > 0) {
      return { phase: BYTE_RATE_RE.test(line) ? 'loading' : 'sampling', done, total, percent: null }
    }
  }

  // 4. The batch counter, with no bar behind it. Named explicitly so its `1/1`
  //    can never be read as a finished render. It is evidence that the weights
  //    are up and an image is beginning, but it is NOT a sampler step, so it
  //    contributes no counter and no phase.
  if (BATCH_RE.test(line)) return { phase: null, done: null, total: null, percent: null }

  // 5. An explicit "step N / M".
  const stepText = STEP_TEXT_RE.exec(line)
  if (stepText) {
    const total = Number(stepText[2])
    if (total > 0) return { phase: 'sampling', done: Number(stepText[1]), total, percent: null }
  }

  // 6. A bare percentage — no phase of its own.
  const pct = PCT_RE.exec(line)
  if (pct) {
    return { phase: null, done: null, total: null, percent: Math.min(100, Math.max(0, Math.round(parseFloat(pct[1])))) }
  }

  // 7. A load announcement with no numbers.
  if (LOAD_FROM_RE.test(line)) return { phase: 'loading', done: null, total: null, percent: null }

  return NOTHING
}

/** Phase order, for the monotonic clamp. */
const PHASE_RANK: Record<SdPhase, number> = { starting: 0, loading: 1, sampling: 2, decoding: 3 }

// ─── SdProgressParser class ───────────────────────────────────────────────────

export class SdProgressParser {
  private _tailBuf   = ''
  private _lastLine  = ''
  private _phase: SdPhase = 'starting'
  private _loadDone:  number | null = null
  private _loadTotal: number | null = null
  private _step:      number | null = null
  private _total:     number | null = null
  private _pct:       number | null = null
  private _sawProgress = false
  private _startedAt = Date.now()
  private readonly _heartbeatMs: number

  /**
   * @param heartbeatMs  How long (ms) to emit "Starting..." before real progress
   *                     arrives. Default 4 000 ms.
   */
  constructor(heartbeatMs = 4_000) {
    this._heartbeatMs = heartbeatMs
  }

  /**
   * Feed raw stdout/stderr bytes (Buffer or string chunk).
   * Returns the current SdProgress after consuming the chunk, or null if
   * nothing meaningful changed (caller can skip redundant pushes).
   */
  feed(chunk: Buffer | string): SdProgress | null {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    this._tailBuf += text

    // Flush complete lines (split on \r or \n, keep the trailing partial).
    const parts = this._tailBuf.split(/\r\n|\r|\n/)
    this._tailBuf = parts.pop() ?? ''

    let updated = false
    for (const raw of parts) {
      const line = stripAnsi(raw).trim()
      if (!line) continue
      if (line === this._lastLine) continue  // dedup in-place overwrites
      this._lastLine = line
      if (this._apply(line)) updated = true
      else if (this._isProgressish(line)) updated = true  // a status line worth forwarding
    }

    if (!updated) return null
    return this._snapshot()
  }

  /**
   * Force-emit current state even without new data.
   * Used by the heartbeat timer.
   */
  heartbeat(): SdProgress {
    return this._snapshot()
  }

  /** Call once the process exits to get the final state. */
  finish(): SdProgress {
    // Flush any partial tail line.
    if (this._tailBuf.trim()) {
      const line = stripAnsi(this._tailBuf).trim()
      if (line) { this._apply(line); this._lastLine = line }
      this._tailBuf = ''
    }
    // The run is over, so its own completion IS 100 — but only when something
    // was actually measured. A run that never emitted a step still reports the
    // phase it died in rather than inventing a finished one.
    return {
      step:      this._step,
      total:     this._total,
      percent:   this._sawProgress ? 100 : -1,
      message:   this._lastLine || 'Done.',
      heartbeat: false,
      phase:     this._phase,
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Fold one line into the state. Returns true when something changed.
   *
   * THE MONOTONIC CLAMP lives here. A tensor bar only counts while we are still
   * loading: after the first sampler step, every remaining `#` bar belongs to a
   * weight load the DECODER is doing (the VAE's 108 tensors in controlA.log,
   * the 64 the driver saw at 868s) or to a second expert being paged in, and
   * letting either repaint a 100% "loading" bar over a live render is the
   * original bug wearing a different regex.
   */
  private _apply(line: string): boolean {
    const ev = classifySdLine(line)
    if (!ev) return false

    if (ev.phase === 'sampling') {
      this._phase = 'sampling'
      if (ev.done !== null && ev.total !== null) {
        this._step = ev.done
        this._total = ev.total
        this._sawProgress = true
      }
      return true
    }

    if (ev.phase === 'loading') {
      if (PHASE_RANK[this._phase] > PHASE_RANK.loading) return false  // decoder's weights
      this._phase = 'loading'
      if (ev.done !== null && ev.total !== null) {
        this._loadDone = ev.done
        this._loadTotal = ev.total
        this._sawProgress = true
      }
      return true
    }

    if (ev.phase === 'decoding') {
      this._phase = 'decoding'
      // The sampler's numbers stop describing anything the moment decode starts.
      this._step = null
      this._total = null
      return true
    }

    if (ev.percent !== null) {
      this._pct = ev.percent
      this._sawProgress = true
      return true
    }

    return false
  }

  private _isProgressish(line: string): boolean {
    // Lines containing these tokens are worth forwarding even without step numbers.
    const kw = /sampl|denois|latent|vae|encod|decod|step|generat|running|load/i
    return kw.test(line) && line.length < 200
  }

  private _snapshot(): SdProgress {
    const inHeartbeat = !this._sawProgress && (Date.now() - this._startedAt) < this._heartbeatMs
    let percent = -1
    if (this._phase === 'sampling' && this._step !== null && this._total !== null) {
      percent = Math.min(100, Math.round((this._step / this._total) * 100))
    } else if (this._phase === 'loading' && this._loadDone !== null && this._loadTotal !== null) {
      percent = Math.min(100, Math.round((this._loadDone / this._loadTotal) * 100))
    } else if (this._phase !== 'decoding' && this._pct !== null) {
      percent = this._pct
    }

    return {
      step:      this._phase === 'sampling' ? this._step  : null,
      total:     this._phase === 'sampling' ? this._total : null,
      percent,
      message:   inHeartbeat ? 'Starting...' : (this._lastLine || 'Running...'),
      heartbeat: inHeartbeat,
      phase:     this._phase,
    }
  }
}
