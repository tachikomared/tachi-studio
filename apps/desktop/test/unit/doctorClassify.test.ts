// apps/desktop/test/unit/doctorClassify.test.ts
//
// Pure classification for the doctor health probe: exit codes, spawn errors,
// and detail-line extraction. The Windows NTSTATUS cases are the load-bearing
// ones — a binary with a missing DLL "runs" but exits 0xC0000135, which naive
// existence checks (and naive exit!=0 handling) both misread.
import { describe, it, expect } from 'vitest'
import { classifyExit, classifySpawnError, pickDetailLine } from '../../electron/services/util/doctor-classify'

describe('classifyExit', () => {
  it('exit 0 is ok', () => {
    expect(classifyExit(0)).toBe('ok')
  })

  it('accepts extra ok codes (help text exiting 1 on some tools)', () => {
    expect(classifyExit(1, [0, 1])).toBe('ok')
    expect(classifyExit(1)).toBe('error')
  })

  it('126/127 are broken (shell not-executable / not-found)', () => {
    expect(classifyExit(126)).toBe('broken')
    expect(classifyExit(127)).toBe('broken')
  })

  it('Windows NTSTATUS crash codes are broken — unsigned and signed forms', () => {
    expect(classifyExit(3221225781)).toBe('broken')   // 0xC0000135 STATUS_DLL_NOT_FOUND
    expect(classifyExit(-1073741515)).toBe('broken')  // same, signed 32-bit
    expect(classifyExit(3221225785)).toBe('broken')   // 0xC0000139 entry point not found
  })

  it('ordinary nonzero exits are error, not broken', () => {
    expect(classifyExit(2)).toBe('error')
    expect(classifyExit(64)).toBe('error')
  })
})

describe('classifySpawnError', () => {
  it('ENOENT is missing', () => {
    expect(classifySpawnError({ code: 'ENOENT' })).toBe('missing')
  })

  it('EACCES/EPERM are broken', () => {
    expect(classifySpawnError({ code: 'EACCES' })).toBe('broken')
    expect(classifySpawnError({ code: 'EPERM' })).toBe('broken')
  })

  it('killed/SIGTERM is timeout (execFile timeout kill)', () => {
    expect(classifySpawnError({ killed: true, signal: 'SIGTERM' })).toBe('timeout')
    expect(classifySpawnError({ signal: 'SIGTERM' })).toBe('timeout')
  })

  it('numeric code defers to classifyExit (returns null)', () => {
    expect(classifySpawnError({ code: 1 })).toBeNull()
    expect(classifySpawnError({ code: 3221225781 })).toBeNull()
  })
})

describe('pickDetailLine', () => {
  it('takes the first non-empty line across stdout then stderr', () => {
    expect(pickDetailLine('\n\nyt-dlp 2026.06.30\nextra', '')).toBe('yt-dlp 2026.06.30')
    expect(pickDetailLine('', '  Chromium 138.0.7204.49  ')).toBe('Chromium 138.0.7204.49')
  })

  it('truncates long lines with an ellipsis', () => {
    const long = 'x'.repeat(300)
    const out = pickDetailLine(long, '')
    expect(out.length).toBe(100)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string when there is no output', () => {
    expect(pickDetailLine('', '')).toBe('')
  })
})
