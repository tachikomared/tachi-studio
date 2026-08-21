// packages/core/src/tachi/loop/__tests__/error-breaker.test.ts
import { describe, it, expect } from 'vitest'
import { errorSignature, detectErrorLoop, buildRepeatedErrorNudge } from '../error-breaker.js'

describe('errorSignature', () => {
  it('collapses the same failure across different concrete paths', () => {
    const a = errorSignature('Error: ENOENT: no such file or directory "/home/u/src/a.ts"')
    const b = errorSignature("Error: ENOENT: no such file or directory '/var/www/b.tsx'")
    expect(a).toBe(b)
    expect(a).not.toBe('')
  })

  it('collapses Windows paths, line:col, numbers and hashes', () => {
    const a = errorSignature('build failed at C:\\proj\\x.ts:12:5 (exit 2) sha 9f8e7d6c5b4a')
    const b = errorSignature('build failed at C:\\other\\y.ts:99:1 (exit 7) sha 001122334455')
    expect(a).toBe(b)
  })

  it('distinguishes genuinely different failure classes', () => {
    const enoent = errorSignature('ENOENT: no such file "/a"')
    const eacces = errorSignature('EACCES: permission denied "/a"')
    expect(enoent).not.toBe(eacces)
  })

  it('returns empty for blank/non-string input', () => {
    expect(errorSignature('')).toBe('')
    expect(errorSignature('   ')).toBe('')
    expect(errorSignature(undefined as unknown as string)).toBe('')
  })
})

describe('detectErrorLoop', () => {
  const sig = (n: number, s: string) => Array.from({ length: n }, () => s)

  it('does not trip below threshold', () => {
    expect(detectErrorLoop(sig(2, 'x')).stalled).toBe(false)
  })

  it('trips at threshold on identical trailing signatures', () => {
    const v = detectErrorLoop(sig(3, 'x'))
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(3)
  })

  it('ignores empty signatures (successes omitted upstream, defensive here)', () => {
    expect(detectErrorLoop(['x', '', 'x', '', 'x']).stalled).toBe(true)
  })

  it('resets the run when a different signature appears at the tail', () => {
    expect(detectErrorLoop(['x', 'x', 'y']).stalled).toBe(false)
    expect(detectErrorLoop(['x', 'x', 'y']).repeats).toBe(1)
  })

  it('threshold <= 0 never trips', () => {
    expect(detectErrorLoop(sig(5, 'x'), 0).stalled).toBe(false)
  })

  it('catches "same failure via different tools" — the stall.ts blind spot', () => {
    // Three DIFFERENT tool calls (read/grep/edit) each fail ENOENT on a path.
    const sigs = [
      errorSignature('ENOENT "/a/x.ts"'),
      errorSignature('ENOENT "/b/y.ts"'),
      errorSignature('ENOENT "/c/z.ts"'),
    ]
    expect(new Set(sigs).size).toBe(1)          // all one signature
    expect(detectErrorLoop(sigs).stalled).toBe(true)
  })
})

describe('buildRepeatedErrorNudge', () => {
  it('names the failure, the distinct tools tried, and demands a strategy change', () => {
    const msg = buildRepeatedErrorNudge('enoent no such file <q>', 3, ['read', 'grep', 'read', 'edit'])
    expect(msg).toContain('enoent no such file')
    expect(msg).toMatch(/read/); expect(msg).toMatch(/grep/); expect(msg).toMatch(/edit/)
    expect(msg.toLowerCase()).toMatch(/step back|change|honestly/)
  })

  it('omits the "tried via" clause when only one tool was used', () => {
    const msg = buildRepeatedErrorNudge('boom', 3, ['bash', 'bash', 'bash'])
    expect(msg).not.toMatch(/tried this via/)
  })
})
