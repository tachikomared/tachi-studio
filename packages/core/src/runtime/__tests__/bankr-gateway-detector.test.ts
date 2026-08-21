// packages/core/src/runtime/__tests__/bankr-gateway-detector.test.ts
//
// PINS the status mapping in createBankrGatewayDetector, which is the second
// half of the 2026-08-01 fix: apps/desktop/electron/services/runtime-detect.ts
// used to ask the keychain for the wrong id ('bankr' instead of 'bankr-gateway'),
// so apiKey here was always undefined and every branch below except the
// `!apiKey` early return was dead code — determineBankrHealth was NEVER CALLED.
//
// Fixing the id newly activates this mapping, and one branch used to lie:
// `degraded` (a 429/5xx from Bankr, or "gateway is up but the authenticated
// call never completed") was folded into 'unreachable'. A rate-limited-but-
// working gateway is not the same fact as a dead one, and RuntimeStatus has no
// dedicated "reachable but degraded" state — so this reuses 'unknown', which
// no other detector emits and which the Studio/Sidebar cards render neutrally
// (dim dot, plain label) rather than red or green.

import { describe, it, expect, vi } from 'vitest'
import { createBankrGatewayDetector } from '../detectors/bankr-gateway.js'

/** A Response-shaped stub; only `ok` and `status` are read by determineBankrHealth. */
const res = (status: number) => ({ ok: status >= 200 && status < 300, status })

describe('createBankrGatewayDetector — status mapping', () => {
  it('no key at all → needs_login WITHOUT ever calling the health function', async () => {
    const fetchMock = vi.fn()
    const detector = createBankrGatewayDetector(undefined, fetchMock as never)
    const result = await detector.detect()
    expect(result.status).toBe('needs_login')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a working key → healthy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200))
    const detector = createBankrGatewayDetector('bk_live', fetchMock as never)
    const result = await detector.detect()
    expect(result.status).toBe('healthy')
  })

  it('a rejected key (401/403) → needs_login, not unreachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(401))
    const detector = createBankrGatewayDetector('bk_bad', fetchMock as never)
    const result = await detector.detect()
    expect(result.status).toBe('needs_login')
  })

  it('a genuine network failure (nothing answers, including /health) → unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const detector = createBankrGatewayDetector('bk_live', fetchMock as never)
    const result = await detector.detect()
    expect(result.status).toBe('unreachable')
  })

  it('THE REGRESSION GUARD: a 429/5xx from the gateway is degraded, and must render as unknown — NOT unreachable', async () => {
    for (const status of [429, 500, 503]) {
      const fetchMock = vi.fn().mockResolvedValue(res(status))
      const detector = createBankrGatewayDetector('bk_live', fetchMock as never)
      const result = await detector.detect()
      expect(result.status, `status ${status}`).toBe('unknown')
      expect(result.status, `status ${status}`).not.toBe('unreachable')
      expect(result.status, `status ${status}`).not.toBe('healthy')
      expect(result.error).toContain(String(status))
    }
  })

  it('gateway up but the authenticated call could not complete → unknown, carrying the "key unchecked" message', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) throw new Error('ECONNRESET')
      return res(200) // /health
    })
    const detector = createBankrGatewayDetector('bk_live', fetchMock as never)
    const result = await detector.detect()
    expect(result.status).toBe('unknown')
    expect(result.error).toMatch(/could not be checked/i)
  })

  it('includes checkedAt and the runtime identity fields regardless of status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200))
    const detector = createBankrGatewayDetector('bk_live', fetchMock as never)
    const result = await detector.detect()
    expect(result.runtimeId).toBe('bankr-gateway')
    expect(result.kind).toBe('cloud_gateway')
    expect(new Date(result.checkedAt).getTime()).toBeGreaterThan(0)
  })
})
