// apps/desktop/test/unit/edgeRunInfo.test.ts
//
// EDGE RUN-INFO — the execution overlay ON the wires. After a node runs, each of
// its outgoing edges shows a mid-edge chip with the size of the data that flowed
// (char count → approx-token tooltip); an error-edge that carried an error reads
// 'ERR'. All of that is DERIVED at render time from the source node's
// lastOutput/lastError — nothing is persisted, so the serialized flow JSON is
// untouched (proven separately by the stableFlowJson suite). Here we pin the
// pure formatting + decision rules.
import { describe, it, expect } from 'vitest'
import {
  charCountLabel,
  approxTokens,
  edgeRunChip,
  edgeRunTooltip,
} from '../../src/pages/nodes/canvas/edgeRunInfo'

describe('charCountLabel', () => {
  it('returns empty for empty / non-positive / non-finite input', () => {
    expect(charCountLabel(0)).toBe('')
    expect(charCountLabel(-5)).toBe('')
    expect(charCountLabel(NaN)).toBe('')
    expect(charCountLabel(Infinity)).toBe('')
    expect(charCountLabel(-Infinity)).toBe('')
  })

  it('shows a plain count below 1000', () => {
    expect(charCountLabel(1)).toBe('1 ch')
    expect(charCountLabel(42)).toBe('42 ch')
    expect(charCountLabel(842)).toBe('842 ch')
    expect(charCountLabel(999)).toBe('999 ch')
  })

  it('rounds a fractional length to a whole character count', () => {
    expect(charCountLabel(41.4)).toBe('41 ch')
    expect(charCountLabel(41.6)).toBe('42 ch')
  })

  it('switches to compact "k" at 1000 and drops a trailing .0', () => {
    expect(charCountLabel(1000)).toBe('1k ch')
    expect(charCountLabel(1200)).toBe('1.2k ch')
    expect(charCountLabel(1234)).toBe('1.2k ch')
    expect(charCountLabel(1500)).toBe('1.5k ch')
    expect(charCountLabel(9949)).toBe('9.9k ch')
  })

  it('drops the decimal once >= 10k', () => {
    expect(charCountLabel(10000)).toBe('10k ch')
    expect(charCountLabel(12345)).toBe('12k ch')
    expect(charCountLabel(42000)).toBe('42k ch')
    expect(charCountLabel(999499)).toBe('999k ch')
  })
})

describe('approxTokens', () => {
  it('is zero for empty / invalid input', () => {
    expect(approxTokens(0)).toBe(0)
    expect(approxTokens(-3)).toBe(0)
    expect(approxTokens(NaN)).toBe(0)
  })

  it('estimates ~4 chars per token, never zero for real content', () => {
    expect(approxTokens(1)).toBe(1) // clamped up from 0.25
    expect(approxTokens(4)).toBe(1)
    expect(approxTokens(400)).toBe(100)
    expect(approxTokens(1234)).toBe(309) // round(308.5)
  })
})

describe('edgeRunChip', () => {
  it('normal edge with no output → no chip', () => {
    expect(edgeRunChip({ isError: false, hasError: false, outLen: 0 })).toBeNull()
  })

  it('normal edge with output → a size chip in the default color', () => {
    expect(edgeRunChip({ isError: false, hasError: false, outLen: 1234 }))
      .toEqual({ text: '1.2k ch', danger: false })
  })

  it('normal edge ignores an upstream error (it carries the OUTPUT, not the error)', () => {
    // A node that errors clears its lastOutput, so in practice outLen is 0 here;
    // but even if both were present, a NORMAL edge reports the output size.
    expect(edgeRunChip({ isError: false, hasError: true, outLen: 512 }))
      .toEqual({ text: '512 ch', danger: false })
  })

  it('error edge with no error → no chip (a successful run routed nothing down it)', () => {
    expect(edgeRunChip({ isError: true, hasError: false, outLen: 999 })).toBeNull()
  })

  it('error edge that carried an error → the ERR chip in the danger color', () => {
    expect(edgeRunChip({ isError: true, hasError: true, outLen: 0 }))
      .toEqual({ text: 'ERR', danger: true })
  })

  it('error edge ignores output size when it carried an error', () => {
    expect(edgeRunChip({ isError: true, hasError: true, outLen: 4321 }))
      .toEqual({ text: 'ERR', danger: true })
  })
})

describe('edgeRunTooltip', () => {
  it('size chip → char count plus an approx-token estimate, pure units', () => {
    expect(edgeRunTooltip({ text: '1.2k ch', danger: false }, 1234))
      .toBe('1234 ch · ~309 tok')
  })

  it('error chip → ERR plus the error-text length', () => {
    expect(edgeRunTooltip({ text: 'ERR', danger: true }, 87))
      .toBe('ERR · 87 ch')
  })

  it('guards a non-positive length to zero', () => {
    expect(edgeRunTooltip({ text: 'ERR', danger: true }, 0)).toBe('ERR · 0 ch')
    expect(edgeRunTooltip({ text: '', danger: false }, -1)).toBe('0 ch · ~0 tok')
  })
})
