// apps/desktop/test/unit/speechModelSizes.test.ts
//
// THE SPEECH REGISTRIES USED TO LIE ABOUT DOWNLOAD SIZES — the same class of
// bug sdModelSizes.test.ts pinned for sd.cpp, and this file is its sibling.
//
// piper-models.ts declared `en_US-amy-low` at sizeMb 28 while the file on the
// pinned URL is 63_104_526 bytes (60.2 MiB) — a 2.15x under-declaration. Those
// numbers are not cosmetic: piper-installer feeds
// `Math.round(sizeMb * 1_048_576)` to the download manager as
// `approxTotalBytes`, which is what the DISK PREFLIGHT reserves against, and
// catalog-service/catalog.store turn the same field into the row's size chip.
// Under-declaring means starting a download onto a volume that may not hold it
// — the exact failure the preflight exists to stop. ("low" is a SYNTHESIS
// quality tier in piper, not a smaller file; all three curated voices are
// within 100 KB of each other.)
//
// whisper-models.ts was honest but incomplete: only ONE of the five assets
// carried an exact `sizeBytes`, so the other four fell through to
// `approxBytesFromSizeLabel(sizeLabel)` — re-parsing a rounded human string for
// a number the preflight depends on. All five are now measured.
//
// MEASURED 2026-07-27 by HEAD + redirect on every URL in both registries (11
// requests, all HTTP 200): the numbers below are the `Content-Length` of the
// 200 response. The 302's `X-Linked-Size` agreed on every LFS object, and every
// `X-Linked-ETag` equalled the sha256 pinned in the registry — so these URLs
// still serve the pinned bytes, and only the DECLARED sizes were wrong.
//
// Re-measure whenever a URL is repointed; a moved file changes both the size
// AND the sha, so this test failing next to a sha change is expected.

import { describe, it, expect } from 'vitest'
import { PIPER_VOICES } from '../../electron/services/piper-models'
import { WHISPER_MODELS, type WhisperModelName } from '../../electron/services/whisper-models'
import { approxBytesFromSizeLabel } from '../../electron/services/util/download-queue'

const MiB = 1_048_576

// ─── The measurement table ───────────────────────────────────────────────────

/** piper voice id → measured Content-Length of each half of the voice. */
const PIPER_MEASURED: Record<string, { onnx: number; config: number }> = {
  'en_US-amy-medium':    { onnx: 63_201_294, config: 4_882 },
  'en_US-lessac-medium': { onnx: 63_201_294, config: 4_885 },
  'en_US-amy-low':       { onnx: 63_104_526, config: 4_164 },
}

/** whisper model name → measured Content-Length of the ggml weight. */
const WHISPER_MEASURED: Record<string, number> = {
  'tiny.en':             77_704_715,
  'base.en':            147_964_211,
  'small.en':           487_614_201,
  'medium.en':        1_533_774_781,
  'large-v3-turbo-q5_0': 574_041_195,
}

/** Whole-voice bytes — the `.onnx` weight plus its `.onnx.json` sidecar. */
const piperTotal = (id: string) => PIPER_MEASURED[id].onnx + PIPER_MEASURED[id].config

/** What piper-installer actually hands the download manager for preflight. */
const piperApproxBytes = (sizeMb: number) => Math.round(sizeMb * MiB)

/** What whisper-installer actually hands the download manager for preflight. */
const whisperApproxBytes = (name: WhisperModelName) =>
  WHISPER_MODELS[name].sizeBytes ?? approxBytesFromSizeLabel(WHISPER_MODELS[name].sizeLabel) ?? 0

// ─── piper voices ────────────────────────────────────────────────────────────

describe('piper-models — declared sizeMb matches the measured Content-Length', () => {
  it('covers every curated voice (no unmeasured row)', () => {
    for (const v of PIPER_VOICES) {
      expect(PIPER_MEASURED[v.id], `no measurement for voice ${v.id}`).toBeDefined()
      expect(PIPER_MEASURED[v.id].onnx, v.id).toBeGreaterThan(0)
      expect(PIPER_MEASURED[v.id].config, v.id).toBeGreaterThan(0)
    }
  })

  it.each(PIPER_VOICES.map(v => [v.id, v] as const))(
    '%s declares ceil((onnx + onnx.json) / 1 MiB)',
    (id, v) => {
      expect(v.sizeMb).toBe(Math.ceil(piperTotal(id) / MiB))
    },
  )

  it('NEVER under-declares — the disk preflight must not reserve too little', () => {
    for (const v of PIPER_VOICES) {
      expect(
        piperApproxBytes(v.sizeMb),
        `${v.id} under-declares: ${piperApproxBytes(v.sizeMb)} < ${piperTotal(v.id)}`,
      ).toBeGreaterThanOrEqual(piperTotal(v.id))
    }
  })

  it('never over-declares by more than 1 MiB either (rounding, not guessing)', () => {
    for (const v of PIPER_VOICES) {
      expect(piperApproxBytes(v.sizeMb) - piperTotal(v.id)).toBeLessThan(MiB)
    }
  })

  it('en_US-amy-low is no longer the 2.15x lie the driver hit', () => {
    const low = PIPER_VOICES.find(v => v.id === 'en_US-amy-low')!
    expect(low.sizeMb).toBe(61)                    // was 28 for a 60.2 MiB file
    expect(low.name).not.toContain('smallest')     // the card claimed that too
  })

  it('the "low" quality tier is NOT a smaller download — every voice is ~60 MiB', () => {
    const totals = PIPER_VOICES.map(v => piperTotal(v.id))
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(MiB)
    expect(new Set(PIPER_VOICES.map(v => v.sizeMb)).size).toBe(1)
  })

  it('every voice ships both URLs and a non-placeholder sha for each half', () => {
    for (const v of PIPER_VOICES) {
      expect(v.onnxUrl, v.id).toMatch(/\.onnx$/)
      expect(v.configUrl, v.id).toBe(`${v.onnxUrl}.json`)
      expect(v.onnxSha, v.id).toMatch(/^[0-9a-f]{64}$/)
      expect(v.configSha, v.id).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

// ─── whisper models ──────────────────────────────────────────────────────────

const WHISPER_ROWS = Object.values(WHISPER_MODELS)

describe('whisper-models — every asset carries its exact measured byte length', () => {
  it('covers every registry model (no unmeasured row)', () => {
    for (const m of WHISPER_ROWS) {
      expect(WHISPER_MEASURED[m.name], `no measurement for ${m.name}`).toBeGreaterThan(0)
    }
  })

  it.each(WHISPER_ROWS.map(m => [m.name, m] as const))(
    '%s declares the exact Content-Length, not a re-parsed label',
    (name, m) => {
      expect(m.sizeBytes).toBe(WHISPER_MEASURED[name])
    },
  )

  it('NEVER under-declares — the disk preflight must not reserve too little', () => {
    for (const m of WHISPER_ROWS) {
      expect(
        whisperApproxBytes(m.name),
        `${m.name} under-declares: ${whisperApproxBytes(m.name)} < ${WHISPER_MEASURED[m.name]}`,
      ).toBeGreaterThanOrEqual(WHISPER_MEASURED[m.name])
    }
  })

  it('the human sizeLabel rounds UP to at most 1 MiB over the real size', () => {
    // Display only — but a label that reads SMALLER than the file is the same
    // lie in a different font, and it is the preflight fallback for any future
    // asset added without a measurement.
    for (const m of WHISPER_ROWS) {
      const fromLabel = approxBytesFromSizeLabel(m.sizeLabel)
      expect(fromLabel, `${m.name} has an unparseable label: ${m.sizeLabel}`).toBeDefined()
      // medium.en's '~1.5 GB' is a coarse but SAFE over-statement of 1462.7 MiB.
      expect(fromLabel!, m.name).toBeGreaterThan(WHISPER_MEASURED[m.name] - MiB)
    }
  })

  it('large-v3-turbo-q5_0 stays smaller than medium.en (the reason it is offered)', () => {
    expect(WHISPER_MEASURED['large-v3-turbo-q5_0']).toBeLessThan(WHISPER_MEASURED['medium.en'])
  })

  it('every model ships a real sha256 (no placeholder shipped by accident)', () => {
    for (const m of WHISPER_ROWS) {
      expect(m.sha256, m.name).toMatch(/^[0-9a-f]{64}$/)
      expect(m.url, m.name).toContain(m.file)
    }
  })
})

// ─── the shared discipline ───────────────────────────────────────────────────

describe('sizes are declared in MEBIbytes everywhere (one unit, no drift)', () => {
  it('piper sizeMb × 1 MiB reproduces the measured byte range', () => {
    // 61 MiB = 63_963_136 — above every measured voice, below 62 MiB.
    for (const v of PIPER_VOICES) {
      expect(piperApproxBytes(v.sizeMb)).toBeGreaterThan(60 * MiB)
      expect(piperApproxBytes(v.sizeMb)).toBeLessThanOrEqual(61 * MiB)
    }
  })

  it('whisper sizeBytes is raw bytes, never a MiB count someone forgot to scale', () => {
    for (const m of WHISPER_ROWS) expect(m.sizeBytes).toBeGreaterThan(1 * MiB)
  })
})
