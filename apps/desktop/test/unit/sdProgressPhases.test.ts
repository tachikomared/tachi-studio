// apps/desktop/test/unit/sdProgressPhases.test.ts
//
// THE PROGRESS BAR WAS TIMING THE WEIGHT LOADER, NOT THE RENDER.
//
// Driver finding (speed A/B, 2026-07-31, D:\projects\tachidecktests\driver-speedab\S3A-gen.log
// against the INSTALLED sd-cli). One 4-step Wan 2.1 I2V 14B render, as the
// activity strip told it:
//
//     16s   21% · 107/517       ← t5xxl TENSORS, called "generating"
//    106s   99% · 513/517       ← still t5xxl
//    116s   32% · 414/1303      ← the bar JUMPS BACKWARD: a new file, the DiT
//    143s  100% · 1303/1303     ← "done", with the GPU at 100% and 8 min left
//    ...    100% · 1303/1303    ← frozen here for EIGHT MINUTES
//    638s   25% · 1/4           ← the first REAL sampler step, bar falls to 25%
//    868s  100% · 64/64         ← the VAE decoder's tensors, called "generating"
//
// Four lies from one regex. `STEP_RE = /\b(?:step\s+)?(\d+)\s*\/\s*(\d+)\b/`
// cannot tell a tensor count from a sampler step, so whichever `N/M` was printed
// last won — and sd.cpp prints far more tensor counts than steps.
//
// THE DISCRIMINATOR IS IN THE LINE AND IT IS EXACT. Every progress bar the
// engine draws carries a RATE, and the rate names the unit of the counter:
//
//   loading   |##########        | 328/686 - 2.46GB/s     '#' fill, BYTE rate
//   sampling  |======>           |   1/8  - 1.22it/s      '='/'>' fill, ITER rate
//
// Across all six captured traces (engine-probes/*.log) that split is clean:
// 35 byte-rate bars, 88 iteration-rate bars, zero bars mixing the two fills.
// Every line quoted below is COPIED VERBATIM out of those logs — this file is
// the source-assertion, so an upstream format change fails here rather than
// silently re-freezing the bar.

import { describe, it, expect, afterEach } from 'vitest'
import { SdProgressParser, classifySdLine } from '../../electron/services/util/sd-progress-parser'
import {
  formatSdProgress, setSdPhaseLabels, resetMediaProgressBridge, FALLBACK_PHASE_LABELS,
} from '../../src/pages/media/mediaProgressBridge'
import { parseRunProgress } from '../../src/components/activity/activityRows'

// ── VERBATIM ENGINE LINES ────────────────────────────────────────────────────
// `\x1b[K` (erase-to-end-of-line) really is on the wire — od -c on
// engine-probes/cliBaseline1.log shows `033 [ K \n` closing every bar.
const EL = '\x1b[K'

/** engine-probes/cliBaseline1.log — the text encoder's 196 tensors, complete. */
const LOAD_FULL    = `  |##################################################| 196/196 - 1.09GB/s${EL}`
/** engine-probes/cliBaseline1.log — the diffusion model, mid-load. */
const LOAD_PARTIAL = `  |########################                          | 328/686 - 2.46GB/s${EL}`
/** engine-probes/controlA.log — the VAE, in MB/s rather than GB/s. */
const LOAD_MB      = `  |##################################################| 108/108 - 644.24MB/s${EL}`
/** engine-probes/controlB.log — a bar that has not moved yet. Empty fill, byte rate. */
const LOAD_EMPTY   = `  |                                                  | 1/108 - 0.00MB/s${EL}`

/** engine-probes/cliBaseline1.log — the FIRST real sampler step. */
const SAMPLE_1_8   = `  |======>                                           | 1/8 - 1.22it/s${EL}`
/** engine-probes/controlA.log — a slow step, so the rate inverts to s/it. */
const SAMPLE_2_20  = `  |============>                                     | 2/20 - 4.67s/it${EL}`
const SAMPLE_20_20 = `  |==================================================| 20/20 - 4.07s/it${EL}`

/** engine-probes/cliBaseline1.log — the BATCH counter, not a step counter.
 *  The old regex read this as 1/1 and painted 100%. */
const BATCH_LINE   = `[INFO ] stable-diffusion.cpp:5321 - generating image: 1/1 - seed 12345`
/** engine-probes/cliBaseline1.log — printed when the sampler is CONFIGURED,
 *  which is BEFORE the weights load, not when sampling starts. */
const SAMPLER_NAMED = `[INFO ] stable-diffusion.cpp:4107 - sampling using Euler A method`
/** engine-probes/controlA.log — the -v text form of a tensor load. Also N/M. */
const LOAD_TEXT    = `[DEBUG] model_loader.cpp:1034 - loading 108/194 tensors from D:\\Tachi Studio\\Models\\sd\\wan21-t2v-1.3b\\vae.safetensors`
const LOAD_FROM    = `stable-diffusion.cpp:703  - loading model from 'D:\\Tachi Studio\\Models\\sd\\civitai-142421\\model.safetensors'`

/** engine-probes/cliBaseline1.log (image) / controlA.log (video) — decode begins. */
const SAMPLING_DONE_IMG = `[INFO ] stable-diffusion.cpp:5353 - sampling completed, taking 1.89s`
const SAMPLING_DONE_VID = `[INFO ] stable-diffusion.cpp:6477 - generating latent video completed, taking 82.49s`
const DECODE_IMG        = `[INFO ] stable-diffusion.cpp:4975 - decoding 1 latents`
const DECODE_VID        = `[INFO ] stable-diffusion.cpp:5900 - decode_video_outputs latent 60x104x9x16`

// ── classifySdLine: one line in, one verdict out ─────────────────────────────

describe('classifySdLine — the byte rate vs the iteration rate', () => {
  it('a BYTE-rate bar is the weight loader, whatever its counter says', () => {
    expect(classifySdLine(LOAD_FULL)).toEqual({ phase: 'loading', done: 196, total: 196, percent: null })
    expect(classifySdLine(LOAD_PARTIAL)).toEqual({ phase: 'loading', done: 328, total: 686, percent: null })
    expect(classifySdLine(LOAD_MB)).toEqual({ phase: 'loading', done: 108, total: 108, percent: null })
  })

  it('an EMPTY bar is not ambiguous — the rate decides, not the fill', () => {
    // '|      |' matches both fill alphabets. Only 'MB/s' says which one it is.
    expect(classifySdLine(LOAD_EMPTY)).toEqual({ phase: 'loading', done: 1, total: 108, percent: null })
  })

  it('an ITERATION-rate bar is the sampler', () => {
    expect(classifySdLine(SAMPLE_1_8)).toEqual({ phase: 'sampling', done: 1, total: 8, percent: null })
    expect(classifySdLine(SAMPLE_2_20)).toEqual({ phase: 'sampling', done: 2, total: 20, percent: null })
    expect(classifySdLine(SAMPLE_20_20)).toEqual({ phase: 'sampling', done: 20, total: 20, percent: null })
  })

  it('the -v text form of a tensor load is a load, not a step', () => {
    expect(classifySdLine(LOAD_TEXT)).toEqual({ phase: 'loading', done: 108, total: 194, percent: null })
  })

  it('"loading X from PATH" names the phase and carries no counter', () => {
    expect(classifySdLine(LOAD_FROM)).toEqual({ phase: 'loading', done: null, total: null, percent: null })
  })

  it('THE 100% LIE: "generating image: 1/1 - seed N" is a BATCH index', () => {
    // The old STEP_RE read 1/1 here and painted a finished bar over a render
    // that had not started. It must contribute no counter at all.
    expect(classifySdLine(BATCH_LINE)?.done).toBeNull()
    expect(classifySdLine(BATCH_LINE)?.total).toBeNull()
  })

  it('"sampling using Euler A method" does NOT mean sampling has begun', () => {
    // It is printed while the sampler is being CONFIGURED — in cliBaseline1.log
    // it lands three lines before the first tensor bar. Treating it as a phase
    // transition would reinstate the lie with a different regex.
    expect(classifySdLine(SAMPLER_NAMED)?.phase).not.toBe('sampling')
  })

  it('decode markers end sampling, on both the image and the video path', () => {
    for (const line of [SAMPLING_DONE_IMG, SAMPLING_DONE_VID, DECODE_IMG, DECODE_VID]) {
      expect(classifySdLine(line)).toMatchObject({ phase: 'decoding', done: null, total: null })
    }
  })
})

// ── the parser: phase is monotonic, and each phase owns its own numbers ───────

describe('SdProgressParser — phases, not one global N/M', () => {
  it('a tensor bar reports LOADING and never touches step/total', () => {
    const p = new SdProgressParser().feed(LOAD_PARTIAL + '\n')
    expect(p).toMatchObject({ phase: 'loading', percent: 48, step: null, total: null })
  })

  it('a sampler bar reports SAMPLING with the real step numbers', () => {
    const parser = new SdProgressParser()
    parser.feed(LOAD_FULL + '\n')
    const p = parser.feed(SAMPLE_1_8 + '\n')
    expect(p).toMatchObject({ phase: 'sampling', step: 1, total: 8, percent: 13 })
  })

  it('THE REPRO: a finished weight load does not read as a finished render', () => {
    const parser = new SdProgressParser()
    // 517 t5xxl tensors, then 1303 DiT tensors — the exact S3A sequence.
    parser.feed(`  |####      | 107/517 - 0.31GB/s${EL}\n`)
    parser.feed(`  |##########| 517/517 - 1.10GB/s${EL}\n`)
    parser.feed(`  |###       | 414/1303 - 2.46GB/s${EL}\n`)
    const loaded = parser.feed(`  |##########| 1303/1303 - 3.37GB/s${EL}\n`)
    // 100% of the LOADER — and the phase says so, so nothing downstream can
    // render it as 100% of the run.
    expect(loaded).toMatchObject({ phase: 'loading', percent: 100, step: null, total: null })
    // …and eight minutes later the first real step lands.
    const sampling = parser.feed(`  |======>   | 1/4 - 210.0s/it${EL}\n`)
    expect(sampling).toMatchObject({ phase: 'sampling', step: 1, total: 4, percent: 25 })
  })

  it('THE OTHER HALF OF THE REPRO: the VAE decoder\'s tensors do not re-open loading', () => {
    const parser = new SdProgressParser()
    parser.feed(`  |##########| 1303/1303 - 3.37GB/s${EL}\n`)
    parser.feed(SAMPLE_2_20 + '\n')
    // The decode-stage weight load the driver saw as "100% · 64/64".
    const after = parser.feed(`  |##########| 64/64 - 644.24MB/s${EL}\n`)
    // Either nothing changed, or it is still the sampler's number — never a
    // loading bar at 100% painted over a render that is mid-flight.
    if (after) expect(after).toMatchObject({ phase: 'sampling', step: 2, total: 20 })
    expect(parser.heartbeat()).toMatchObject({ phase: 'sampling', step: 2, total: 20, percent: 10 })
  })

  it('decoding is a LABEL, not a fraction — the engine emits no counter for it', () => {
    const parser = new SdProgressParser()
    parser.feed(SAMPLE_20_20 + '\n')
    const dec = parser.feed(SAMPLING_DONE_VID + '\n')
    expect(dec).toMatchObject({ phase: 'decoding', step: null, total: null, percent: -1 })
  })

  it('the whole cliBaseline1.log ordering produces loading → sampling → decoding', () => {
    const parser = new SdProgressParser()
    const seen: string[] = []
    const push = (line: string) => {
      const p = parser.feed(line + '\n')
      if (p && seen[seen.length - 1] !== p.phase) seen.push(p.phase)
    }
    // Verbatim ordering from engine-probes/cliBaseline1.log, abridged.
    push(LOAD_FROM)
    push(SAMPLER_NAMED)          // BEFORE the weights: must not start sampling
    push(LOAD_FULL)
    push(BATCH_LINE)
    push(LOAD_PARTIAL)
    push(SAMPLE_1_8)
    push(SAMPLE_20_20)
    push(SAMPLING_DONE_IMG)
    push(DECODE_IMG)
    expect(seen).toEqual(['loading', 'sampling', 'decoding'])
  })
})

// ── the line the user reads ──────────────────────────────────────────────────
//
// The activity strip already splits these two things apart and documents the
// split (ActivityStrip.tsx: "`parseRunProgress` is the exact inverse of the
// formatter that produced the phrase, so a stage that IS the measurement
// ('14/20') is already on the bar … prose the engine writes itself parses to -1
// and is the only thing this slot exists to carry"). The formatter simply never
// used it: it emitted `107/517` for a weight load, which parses to a
// measurement, which drew a bar. So the fix is entirely on this side — a phase
// that cannot honestly drive the bar is emitted as PROSE, and the strip's own
// honesty rule does the rest.

describe('formatSdProgress — the phase decides whether there is a bar', () => {
  afterEach(() => { resetMediaProgressBridge() })

  const base = { message: '', heartbeat: false }

  it('LOADING is prose: the strip shows the phrase and leaves the bar indeterminate', () => {
    const line = formatSdProgress({ ...base, phase: 'loading', step: null, total: null, percent: 32 })
    expect(line).toBe('loading model… 32%')
    // The whole point: this must NOT parse as a measurement of the run.
    expect(parseRunProgress(line)).toEqual({ percent: -1, counts: null })
  })

  it('SAMPLING is the measurement: bare N/M, exactly what the strip consumes', () => {
    const line = formatSdProgress({ ...base, phase: 'sampling', step: 4, total: 20, percent: 20 })
    expect(line).toBe('4/20')
    expect(parseRunProgress(line)).toEqual({ percent: 20, counts: { done: 4, total: 20 } })
  })

  it('DECODING is a label with no fraction — the engine emits none', () => {
    const line = formatSdProgress({ ...base, phase: 'decoding', step: null, total: null, percent: -1 })
    expect(line).toBe('decoding…')
    expect(parseRunProgress(line).percent).toBe(-1)
  })

  it('THE REPRO, end to end: a full weight load never draws a full bar', () => {
    const parser = new SdProgressParser()
    parser.feed(`  |##########| 1303/1303 - 3.37GB/s${EL}\n`)
    const loaded = parser.heartbeat()
    const line = formatSdProgress(loaded)
    expect(line).toBe('loading model… 100%')
    // 100% of the loader, 0 evidence about the render — so no bar.
    expect(parseRunProgress(line).percent).toBe(-1)
  })

  it('the phrases are localizable, and a locale switch is picked up live', () => {
    setSdPhaseLabels({
      loading: pct => `Modell wird geladen… ${pct}%`,
      decoding: () => 'Wird dekodiert…',
    })
    expect(formatSdProgress({ ...base, phase: 'loading', step: null, total: null, percent: 7 }))
      .toBe('Modell wird geladen… 7%')
    expect(formatSdProgress({ ...base, phase: 'decoding', step: null, total: null, percent: -1 }))
      .toBe('Wird dekodiert…')
    // …and the sampling line is NOT localized: it is a measurement, and the
    // strip parses it back out.
    expect(formatSdProgress({ ...base, phase: 'sampling', step: 2, total: 4, percent: 50 })).toBe('2/4')
  })

  it('a payload with no phase at all keeps the old behaviour (older main build)', () => {
    expect(formatSdProgress({ ...base, step: 3, total: 20, percent: 15 })).toBe('3/20')
    expect(formatSdProgress({ ...base, step: null, total: null, percent: 48 })).toBe('48%')
    expect(formatSdProgress({ ...base, step: null, total: null, percent: -1, message: 'x' })).toBe('x')
  })

  it('the English fallback is what ships when nobody set labels', () => {
    expect(FALLBACK_PHASE_LABELS.loading(50)).toBe('loading model… 50%')
    expect(FALLBACK_PHASE_LABELS.decoding()).toBe('decoding…')
  })
})
