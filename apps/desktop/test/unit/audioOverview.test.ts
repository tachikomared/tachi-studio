// apps/desktop/test/unit/audioOverview.test.ts
//
// Pure parts of the AUDIO OVERVIEW panel (src/pages/media/audioOverviewHelpers):
// the strict-JSON podcast-script parser (fence tolerance, host normalization,
// stage-direction cleanup) and the renderer-side WAV pipeline (gap concat +
// PCM16 encoder header/payload).
import { describe, it, expect } from 'vitest'
import {
  buildScriptPrompt,
  parsePodcastScript,
  cleanTurnText,
  concatWithGaps,
  encodeWavPcm16,
  base64ToBytes,
  MAX_SOURCE_CHARS,
} from '../../src/pages/media/audioOverviewHelpers'

// ── parsePodcastScript ────────────────────────────────────────────────────────

const VALID = JSON.stringify({
  title: 'Test Show',
  turns: [
    { host: 'A', text: 'Welcome to the show.' },
    { host: 'B', text: 'Glad to be here.' },
  ],
})

describe('parsePodcastScript', () => {
  it('parses plain strict JSON', () => {
    const s = parsePodcastScript(VALID)
    expect(s.title).toBe('Test Show')
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0]).toEqual({ host: 'A', text: 'Welcome to the show.' })
  })

  it('tolerates markdown fences and surrounding prose', () => {
    const wrapped = 'Sure! Here is your script:\n```json\n' + VALID + '\n```\nHope that helps!'
    const s = parsePodcastScript(wrapped)
    expect(s.turns).toHaveLength(2)
    expect(s.turns[1].host).toBe('B')
  })

  it('normalizes lowercase hosts and drops unknown hosts / empty turns', () => {
    const raw = JSON.stringify({
      title: 'X',
      turns: [
        { host: 'a', text: 'first' },
        { host: 'b', text: 'second' },
        { host: 'C', text: 'dropped — unknown host' },
        { host: 'A', text: '   ' },
        { host: 'B' },
      ],
    })
    const s = parsePodcastScript(raw)
    expect(s.turns).toEqual([
      { host: 'A', text: 'first' },
      { host: 'B', text: 'second' },
    ])
  })

  it('falls back to the provided title when the model omits it', () => {
    const raw = JSON.stringify({ turns: [{ host: 'A', text: 'x' }, { host: 'B', text: 'y' }] })
    expect(parsePodcastScript(raw, 'My Notes').title).toBe('My Notes')
    expect(parsePodcastScript(raw).title).toBe('Audio overview')
  })

  it('throws on garbage, non-JSON, missing turns, and <2 usable turns', () => {
    expect(() => parsePodcastScript('')).toThrow(/empty/)
    expect(() => parsePodcastScript('no braces here')).toThrow(/no JSON/)
    expect(() => parsePodcastScript('{not json}')).toThrow(/not valid JSON/)
    expect(() => parsePodcastScript('{"title":"x"}')).toThrow(/turns/)
    expect(() => parsePodcastScript('{"turns":[{"host":"A","text":"only one"}]}')).toThrow(/1 usable/)
    expect(() => parsePodcastScript('[1,2]')).toThrow() // array, not an object
  })
})

describe('cleanTurnText', () => {
  it('strips host prefixes, [stage directions], and markdown emphasis', () => {
    expect(cleanTurnText('Host A: Hello there')).toBe('Hello there')
    expect(cleanTurnText('B: quick reply')).toBe('quick reply')
    expect(cleanTurnText('So [laughs] this is **great** news')).toBe('So this is great news')
    expect(cleanTurnText('  spaced   out\n text ')).toBe('spaced out text')
  })

  it('does not eat a leading word that merely starts with a/b', () => {
    expect(cleanTurnText('Basically it works')).toBe('Basically it works')
    expect(cleanTurnText('And so on')).toBe('And so on')
  })
})

describe('buildScriptPrompt', () => {
  it('embeds the source, trims it to the cap, and stays under the 4000-char IPC cap', () => {
    const long = 'y'.repeat(MAX_SOURCE_CHARS + 5000)
    const p = buildScriptPrompt(long, 'T', 'standard')
    expect(p).toContain('y'.repeat(100))
    expect(p.length).toBeLessThan(4000)
    expect(p).toContain('TITLE HINT: T')
    expect(p).toContain('"host": "A"')
  })

  it('prepends the corrective reminder only in strict mode', () => {
    expect(buildScriptPrompt('src', '', 'short', true)).toMatch(/^REMINDER/)
    expect(buildScriptPrompt('src', '', 'short', false)).not.toMatch(/REMINDER/)
  })
})

// ── WAV pipeline ─────────────────────────────────────────────────────────────

describe('concatWithGaps', () => {
  it('inserts gapMs of silence between chunks but not at the ends', () => {
    const a = new Float32Array([0.5, 0.5])
    const b = new Float32Array([-0.5])
    const out = concatWithGaps([a, b], 1000, 350) // 1kHz → 350 gap samples
    expect(out.length).toBe(2 + 350 + 1)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(0.5)
    expect(out[2]).toBe(0)              // gap start
    expect(out[2 + 349]).toBe(0)        // gap end
    expect(out[out.length - 1]).toBeCloseTo(-0.5)
  })

  it('handles a single chunk (no gaps) and empty input', () => {
    const only = concatWithGaps([new Float32Array([1, -1])], 44100)
    expect(only.length).toBe(2)
    expect(concatWithGaps([], 44100).length).toBe(0)
  })
})

describe('encodeWavPcm16', () => {
  it('writes a canonical 44-byte mono PCM16 RIFF header', () => {
    const rate = 22050
    const wav = encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1]), rate)
    const view = new DataView(wav.buffer)
    const ascii = (off: number, len: number) => String.fromCharCode(...wav.slice(off, off + len))

    expect(wav.length).toBe(44 + 4 * 2)
    expect(ascii(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 8)      // RIFF size
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)         // fmt size
    expect(view.getUint16(20, true)).toBe(1)          // PCM
    expect(view.getUint16(22, true)).toBe(1)          // mono
    expect(view.getUint32(24, true)).toBe(rate)
    expect(view.getUint32(28, true)).toBe(rate * 2)   // byte rate
    expect(view.getUint16(32, true)).toBe(2)          // block align
    expect(view.getUint16(34, true)).toBe(16)         // bits/sample
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)          // data size
  })

  it('encodes samples as little-endian int16 and clamps out-of-range values', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]), 44100)
    const view = new DataView(wav.buffer)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(0x7fff)      // 1 → max
    expect(view.getInt16(48, true)).toBe(-0x8000)     // -1 → min
    expect(view.getInt16(50, true)).toBe(0x7fff)      // clamped
    expect(view.getInt16(52, true)).toBe(-0x8000)     // clamped
    expect(view.getInt16(54, true)).toBe(Math.trunc(0.5 * 0x7fff)) // 16383 — setInt16 truncates
  })
})

describe('base64ToBytes', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const b64 = Buffer.from(bytes).toString('base64')
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes))
  })
})
