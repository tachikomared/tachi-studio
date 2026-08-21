// apps/desktop/test/unit/progressFormat.test.ts
import { describe, it, expect } from 'vitest'
import { fmtBytesPerSec, fmtEta } from '../../src/utils/progressFormat'

describe('fmtBytesPerSec', () => {
  it('returns empty string for non-positive / non-finite input', () => {
    expect(fmtBytesPerSec(0)).toBe('')
    expect(fmtBytesPerSec(-5)).toBe('')
    expect(fmtBytesPerSec(NaN)).toBe('')
    expect(fmtBytesPerSec(Infinity)).toBe('')
  })

  it('scales across B / KB / MB / GB', () => {
    expect(fmtBytesPerSec(500)).toBe('500 B/s')
    expect(fmtBytesPerSec(3 * 1024)).toBe('3 KB/s')
    expect(fmtBytesPerSec(5 * 1024 * 1024)).toBe('5.0 MB/s')
    expect(fmtBytesPerSec(1.5 * 1024 * 1024)).toBe('1.5 MB/s')
    expect(fmtBytesPerSec(2 * 1024 * 1024 * 1024)).toBe('2.0 GB/s')
  })
})

describe('fmtEta', () => {
  it('returns empty string for non-positive / non-finite input', () => {
    expect(fmtEta(0)).toBe('')
    expect(fmtEta(-1)).toBe('')
    expect(fmtEta(NaN)).toBe('')
  })

  it('formats seconds, minutes, and hours', () => {
    expect(fmtEta(45)).toBe('45s')
    expect(fmtEta(45.4)).toBe('45s') // rounds
    expect(fmtEta(60)).toBe('1m')
    expect(fmtEta(80)).toBe('1m 20s')
    expect(fmtEta(125)).toBe('2m 5s')
    expect(fmtEta(3600)).toBe('1h')
    expect(fmtEta(7325)).toBe('2h 2m')
  })
})
