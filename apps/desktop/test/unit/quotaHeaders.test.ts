// apps/desktop/test/unit/quotaHeaders.test.ts
//
// Rate-limit-header quota parsing (ported from free-coding-models ping.js
// extractQuotaPercent). Pure, no IO — deterministic. Covers all four
// header-name variants, the Headers-object path, clamping, and the miss case.
import { describe, it, expect } from 'vitest'
import { extractQuotaPercent } from '../../electron/services/util/quota-headers'

describe('extractQuotaPercent (plain object)', () => {
  it('parses the x-ratelimit-remaining / x-ratelimit-limit variant', () => {
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '50', 'x-ratelimit-limit': '100' })).toBe(50)
  })

  it('parses the x-ratelimit-remaining-requests / limit-requests variant', () => {
    expect(extractQuotaPercent({
      'x-ratelimit-remaining-requests': '30',
      'x-ratelimit-limit-requests': '120',
    })).toBe(25)
  })

  it('parses the bare ratelimit-remaining / ratelimit-limit variant', () => {
    expect(extractQuotaPercent({ 'ratelimit-remaining': '8', 'ratelimit-limit': '10' })).toBe(80)
  })

  it('parses the bare ratelimit-remaining-requests / limit-requests variant', () => {
    expect(extractQuotaPercent({
      'ratelimit-remaining-requests': '0',
      'ratelimit-limit-requests': '100',
    })).toBe(0)
  })

  it('returns null when no recognized pair is present', () => {
    expect(extractQuotaPercent({ 'content-type': 'application/json' })).toBeNull()
    expect(extractQuotaPercent({})).toBeNull()
  })

  it('returns null when the limit is missing, zero, or non-numeric', () => {
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '5' })).toBeNull()
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': '0' })).toBeNull()
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': 'abc' })).toBeNull()
  })

  it('clamps the result to 0..100', () => {
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '150', 'x-ratelimit-limit': '100' })).toBe(100)
    expect(extractQuotaPercent({ 'x-ratelimit-remaining': '-5', 'x-ratelimit-limit': '100' })).toBe(0)
  })

  it('prefers the first matching variant over later ones', () => {
    // x-ratelimit-* wins over bare ratelimit-* when both are present.
    expect(extractQuotaPercent({
      'x-ratelimit-remaining': '90', 'x-ratelimit-limit': '100',
      'ratelimit-remaining': '1', 'ratelimit-limit': '100',
    })).toBe(90)
  })
})

describe('extractQuotaPercent (Headers object)', () => {
  it('reads from a fetch Headers instance', () => {
    const h = new Headers({ 'x-ratelimit-remaining': '40', 'x-ratelimit-limit': '80' })
    expect(extractQuotaPercent(h)).toBe(50)
  })

  it('returns null for an empty Headers instance', () => {
    expect(extractQuotaPercent(new Headers())).toBeNull()
  })
})
