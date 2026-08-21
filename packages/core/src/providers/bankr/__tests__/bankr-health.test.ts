// packages/core/src/providers/bankr/__tests__/bankr-health.test.ts
//
// THE RULE UNDER TEST, and it is the whole point of the 2026-08-01 rewrite:
//
//     only the AUTHENTICATED /v1/models request may ever produce 'healthy'.
//
// What this file used to assert, and why that was wrong: the first case below
// read "returns healthy when health endpoint returns 200" and passed a mock that
// answered 200 to everything. It pinned the bug rather than the behaviour.
// `GET https://llm.bankr.bot/health` (no `/v1`) is a PUBLIC liveness page —
// measured 2026-08-01, it answers 200 with no Authorization header at all — so
// the old level-1 early return fired on every call and the authenticated block
// beneath it was dead code. `determineBankrHealth` returned 'healthy' for any
// string, and that verdict reaches provider-service's healthCheck/testKey, the
// provider:test-key IPC and the onboarding ProviderStep "Test" button. The old
// first case is kept here, inverted, as the regression guard.

import { describe, it, expect, vi } from 'vitest'
import { determineBankrHealth } from '../bankr-health.js'

/** A Response-shaped stub; only `ok` and `status` are read. */
const res = (status: number) => ({ ok: status >= 200 && status < 300, status })

describe('determineBankrHealth', () => {
  it('asks the AUTHENTICATED models endpoint FIRST, and that alone decides healthy', async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(200))
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('healthy')
    // One request on the happy path, and it is the authenticated one.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://llm.bankr.bot/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bk_test')
  })

  it('A 200 FROM /health CAN NEVER MAKE A KEY HEALTHY — the regression this file exists for', async () => {
    // The exact shipped bug: /health answers 200 to anyone, so a garbage key
    // used to come back 'healthy'. Now the authenticated call rejects it and
    // /health is not even consulted, because that call completed.
    const mockFetch = vi.fn(async (url: string) =>
      (String(url).endsWith('/health') ? res(200) : res(401)))
    const result = await determineBankrHealth('this-is-not-a-real-key', mockFetch as never)
    expect(result.status).toBe('reachable_auth_invalid')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://llm.bankr.bot/v1/models')
  })

  it('an empty key is a rejected key, not a healthy one', async () => {
    // testKey('bankr-gateway', '') from the onboarding Test button lands here.
    const mockFetch = vi.fn().mockResolvedValue(res(401))
    await expect(determineBankrHealth('', mockFetch as never))
      .resolves.toEqual({ status: 'reachable_auth_invalid' })
  })

  it('returns reachable_auth_invalid on 401 from /v1/models', async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(401))
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('reachable_auth_invalid')
  })

  it('returns reachable_auth_invalid on 403 too — accepted but not permitted', async () => {
    const mockFetch = vi.fn().mockResolvedValue(res(403))
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('reachable_auth_invalid')
  })

  it('a 429 or a 5xx is the GATEWAY\'s problem — degraded, never rejected or healthy', async () => {
    for (const status of [429, 500, 503]) {
      const mockFetch = vi.fn().mockResolvedValue(res(status))
      const result = await determineBankrHealth('bk_test', mockFetch as never)
      expect(result.status, String(status)).toBe('degraded')
      expect((result as { message: string }).message).toContain(String(status))
    }
  })

  // ── /health's ONLY remaining job ───────────────────────────────────────────

  it('when the authenticated call cannot complete, a live /health softens unreachable to degraded', async () => {
    // A genuinely useful distinction: the gateway is up, so this is the network
    // or their edge rather than their outage — and the key is still UNKNOWN.
    const mockFetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) throw new Error('ECONNRESET')
      return res(200)
    })
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('degraded')
    expect((result as { message: string }).message).toMatch(/could not be checked/i)
    // …and it says nothing about the key being good.
    expect((result as { message: string }).message).not.toMatch(/valid|healthy|connected/i)
    // The authenticated call was still attempted first.
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://llm.bankr.bot/v1/models')
    expect(String(mockFetch.mock.calls[1]![0])).toBe('https://llm.bankr.bot/health')
  })

  it('a non-200 /health after a failed authenticated call leaves it unreachable', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) throw new Error('ECONNRESET')
      return res(503)
    })
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('unreachable')
  })

  it('returns unreachable on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await determineBankrHealth('bk_test', mockFetch as never)
    expect(result.status).toBe('unreachable')
    // Both were tried: the verdict, then the reachability question.
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('never sends the key to the unauthenticated liveness page', async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      void init
      if (String(url).endsWith('/v1/models')) throw new Error('offline')
      return res(200)
    })
    await determineBankrHealth('bk_secret', mockFetch as never)
    const healthCall = mockFetch.mock.calls.find(c => String(c[0]).endsWith('/health'))
    expect(healthCall).toBeDefined()
    const init = (healthCall![1] ?? {}) as RequestInit
    expect(init.headers).toBeUndefined()
  })
})
