// apps/desktop/test/unit/ssrfPinnedFetch.test.ts
//
// DNS-rebind TOCTOU coverage for http_fetch.
//
// ssrf-guard validates a URL by resolving DNS, but the subsequent global
// fetch re-resolves — a rebinding DNS server can pass validation and then
// point the connection at 169.254.x / localhost. Since undici's pinned-IP
// dispatcher is not importable in this build (no `undici` dependency), the
// fallback closes the window: resolve+validate once, then re-resolve
// immediately before fetch and FAIL CLOSED if the answer set changed.
//
// Both layers are exercised:
//   1. resolveAndAssertSafe() returns the validated IP set and throws on a
//      non-global address (mocked dns).
//   2. http_fetch fails closed when the pre-fetch re-resolution differs from
//      the validated set, and proceeds when the set is stable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock node:dns so the guard is offline and the resolved set is scriptable.
const lookupMock = vi.fn()
vi.mock('node:dns', () => ({
  default: { promises: { lookup: (...a: unknown[]) => lookupMock(...a) } },
  promises: { lookup: (...a: unknown[]) => lookupMock(...a) },
}))

import { resolveAndAssertSafe, SsrfBlockedError } from '../../electron/services/ssrf-guard'

describe('resolveAndAssertSafe', () => {
  beforeEach(() => { lookupMock.mockReset() })

  it('returns the validated, sorted IP set for a global host', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.33', family: 4 },
    ])
    const ips = await resolveAndAssertSafe('https://example.com/p')
    expect(ips).toEqual(['93.184.216.33', '93.184.216.34']) // sorted, deterministic
  })

  it('returns the literal IP (no DNS) for an IP-literal host', async () => {
    const ips = await resolveAndAssertSafe('http://8.8.8.8/')
    expect(ips).toEqual(['8.8.8.8'])
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('throws SsrfBlockedError when a resolved address is non-global', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(resolveAndAssertSafe('https://rebind.test/')).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('throws on DNS failure (fail-closed)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(resolveAndAssertSafe('https://nope.test/')).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})

// ---------------------------------------------------------------------------
// http_fetch TOCTOU integration: the egress gate is stubbed allowed; the
// pinned re-resolution is the unit under test. We mock node:dns AND
// egress-policy (no-touch shared file) so only fetch.ts's own re-resolve runs.
// ---------------------------------------------------------------------------

vi.mock('../../electron/services/egress-policy', () => ({
  checkUrlEgressSafe: vi.fn(async () => ({ allowed: true })),
}))

import { register } from '../../electron/mcp/tools/fetch'
import { newRegistry } from '../../electron/mcp/registry'

function okResponse(): Response {
  return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
}

describe('http_fetch DNS-rebind fail-closed', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { lookupMock.mockReset() })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  function callTool() {
    const registry = newRegistry()
    register(registry)
    const def = registry.get('http_fetch')!
    return def.handler({ url: 'https://example.com/page' }, 'test') as Promise<{ status: number }>
  }

  it('fails closed when the pre-fetch re-resolution returns a different IP set (rebind)', async () => {
    // First resolution (validation): a global IP. Second resolution (pre-fetch
    // re-check): swapped to the AWS metadata IP — classic DNS rebind.
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    globalThis.fetch = vi.fn(async () => okResponse()) as typeof fetch

    await expect(callTool()).rejects.toThrow(/rebind|changed|SSRF/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the second resolution adds a non-global address', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
    globalThis.fetch = vi.fn(async () => okResponse()) as typeof fetch

    await expect(callTool()).rejects.toThrow(/rebind|changed|SSRF/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the set swaps to a DIFFERENT global IP (pure comparison path)', async () => {
    // Both addresses are globally routable, so the SSRF classifier passes on
    // each — only the set-equality comparison catches the rebind here.
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // global
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])        // also global, different
    globalThis.fetch = vi.fn(async () => okResponse()) as typeof fetch
    await expect(callTool()).rejects.toThrow(/changed|rebind/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('proceeds when both resolutions agree on the same global IP set', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    globalThis.fetch = vi.fn(async () => okResponse()) as typeof fetch

    const res = await callTool()
    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not re-resolve (and proceeds) for an IP-literal URL', async () => {
    const registry = newRegistry()
    register(registry)
    const def = registry.get('http_fetch')!
    globalThis.fetch = vi.fn(async () => okResponse()) as typeof fetch
    const res = await def.handler({ url: 'https://93.184.216.34/page' }, 'test') as { status: number }
    expect(res.status).toBe(200)
    expect(lookupMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SSRF redirect re-check (STEAL 2026-07-08, firecrawl pattern): a clean URL
// that 30x's to an internal host must be screened BEFORE the redirect is
// followed. redirect:'manual' + per-hop assertUrlEgressSafe is the mechanism.
// ---------------------------------------------------------------------------

describe('http_fetch redirect re-check', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { lookupMock.mockReset() })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } })
  }

  it('blocks a 302 to an internal host before connecting to it', async () => {
    // Hop 0 (example.com) resolves global on both validation reads; the 302
    // target (rebind.test) resolves to the AWS metadata IP → SSRF block.
    lookupMock.mockImplementation(async (host: string) => {
      if (host === 'example.com') return [{ address: '93.184.216.34', family: 4 }]
      return [{ address: '169.254.169.254', family: 4 }] // internal redirect target
    })
    const fetchMock = vi.fn(async () => redirect('http://rebind.test/secret')) as typeof fetch
    globalThis.fetch = fetchMock

    const registry = newRegistry(); register(registry)
    const def = registry.get('http_fetch')!
    await expect(def.handler({ url: 'https://example.com/go' }, 'test')).rejects.toThrow(/redirect|SSRF|blocked/i)
    // Only hop 0 was fetched; the internal target was NEVER connected to.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to another global host and returns its body', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) // every host global+stable
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect('https://cdn.example.net/final'))
      .mockResolvedValueOnce(new Response('landed', { status: 200, headers: { 'content-type': 'text/plain' } }))
    globalThis.fetch = fetchMock as typeof fetch

    const registry = newRegistry(); register(registry)
    const def = registry.get('http_fetch')!
    const res = await def.handler({ url: 'https://example.com/go' }, 'test') as { status: number; body: string }
    expect(res.status).toBe(200)
    expect(res.body).toContain('landed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
