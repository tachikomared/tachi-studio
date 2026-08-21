// apps/desktop/test/unit/ssrfGuard.test.ts
//
// Security boundary: outbound SSRF filter. These tests exercise ONLY the
// synchronous, no-DNS paths (literal IPv4 AND bracketed IPv6 literals, the
// `localhost` special-case, and invalid / empty-host URLs), so they are fully
// offline and deterministic. Domain-name resolution (dns.lookup) is not
// exercised here.
import { describe, it, expect } from 'vitest'
import { isSafeOutboundUrl, assertSafeUrl, SsrfBlockedError } from '../../electron/services/ssrf-guard'

describe('isSafeOutboundUrl — literal IPv4', () => {
  it('allows globally-routable addresses', async () => {
    expect(await isSafeOutboundUrl('http://8.8.8.8/')).toBe(true)
    expect(await isSafeOutboundUrl('https://1.1.1.1/path')).toBe(true)
    expect(await isSafeOutboundUrl('http://172.32.0.1/')).toBe(true) // just outside 172.16/12
  })

  it('blocks loopback / private / link-local / special ranges', async () => {
    for (const ip of [
      '127.0.0.1',        // loopback
      '10.0.0.1',         // private 10/8
      '192.168.1.10',     // private 192.168/16
      '172.16.0.1',       // private 172.16/12 (low)
      '172.31.255.255',   // private 172.16/12 (high)
      '169.254.169.254',  // link-local — AWS IMDS, the classic SSRF target
      '0.0.0.0',          // "this network"
      '100.64.0.1',       // carrier-grade NAT
      '255.255.255.255',  // broadcast / reserved 240/4
      '192.0.2.1',        // documentation
      '203.0.113.5',      // documentation
    ]) {
      expect(await isSafeOutboundUrl(`http://${ip}/`), ip).toBe(false)
    }
  })

  it('respects allowLoopback for local-provider traffic', async () => {
    expect(await isSafeOutboundUrl('http://127.0.0.1:8080/v1', { allowLoopback: true })).toBe(true)
    // allowLoopback does NOT unblock private LAN addresses
    expect(await isSafeOutboundUrl('http://192.168.0.1/', { allowLoopback: true })).toBe(false)
  })
})

describe('isSafeOutboundUrl — literal IPv6 (bracketed)', () => {
  it('allows globally-routable IPv6 literals', async () => {
    expect(await isSafeOutboundUrl('http://[2606:4700:4700::1111]/')).toBe(true) // Cloudflare
    expect(await isSafeOutboundUrl('https://[2001:4860:4860::8888]/')).toBe(true) // Google DNS
  })

  it('blocks loopback / link-local / ULA / unspecified / documentation', async () => {
    for (const ip of [
      '[::1]',            // loopback
      '[fe80::1]',        // link-local
      '[fc00::1]',        // unique-local (ULA)
      '[fd12:3456::1]',   // unique-local (ULA)
      '[::]',             // unspecified
      '[2001:db8::1]',    // documentation
    ]) {
      expect(await isSafeOutboundUrl(`http://${ip}/`), ip).toBe(false)
    }
  })

  it('honours allowLoopback for ::1', async () => {
    expect(await isSafeOutboundUrl('http://[::1]:11434/', { allowLoopback: true })).toBe(true)
    // allowLoopback does not unblock a ULA address
    expect(await isSafeOutboundUrl('http://[fd00::1]/', { allowLoopback: true })).toBe(false)
  })
})

describe('isSafeOutboundUrl — hostnames & malformed', () => {
  it('treats localhost as loopback (gated by allowLoopback, no DNS)', async () => {
    expect(await isSafeOutboundUrl('http://localhost/')).toBe(false)
    expect(await isSafeOutboundUrl('http://localhost:3000/', { allowLoopback: true })).toBe(true)
  })

  it('rejects invalid URLs and empty-host schemes', async () => {
    expect(await isSafeOutboundUrl('not a url')).toBe(false)
    expect(await isSafeOutboundUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('assertSafeUrl', () => {
  it('throws SsrfBlockedError(non-global-ip) for a private address', async () => {
    await expect(assertSafeUrl('http://192.168.0.1/')).rejects.toBeInstanceOf(SsrfBlockedError)
    try {
      await assertSafeUrl('http://10.1.2.3/')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfBlockedError)
      expect((e as SsrfBlockedError).kind).toBe('non-global-ip')
    }
  })

  it('throws SsrfBlockedError(invalid-url) for a malformed URL', async () => {
    try {
      await assertSafeUrl('http://')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfBlockedError)
      expect((e as SsrfBlockedError).kind).toBe('invalid-url')
    }
  })

  it('resolves (no throw) for a global address', async () => {
    await expect(assertSafeUrl('http://8.8.8.8/')).resolves.toBeUndefined()
  })
})
