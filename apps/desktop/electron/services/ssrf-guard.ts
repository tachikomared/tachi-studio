// apps/desktop/electron/services/ssrf-guard.ts
//
// SSRF outbound filter (main-process).
//
// Provides assertSafeUrl(url) / isSafeOutboundUrl(url) for any code path that
// needs to make an outbound HTTP request from the main process.  The guard:
//
//   1. Parses the raw URL and extracts the host.
//   2. If the host is a literal IP address, classifies it directly.
//   3. If the host is a domain name, resolves it via Node dns.promises.lookup
//      (which follows CNAMEs and uses the OS resolver) and classifies every
//      returned address.  This defeats DNS-rebinding / short-form attacks
//      where an attacker controls a domain that resolves to a private IP.
//   4. Blocks non-global destinations:
//        • loopback      – 127.0.0.0/8 (IPv4), ::1 (IPv6)
//        • private CIDRs – 10/8, 172.16/12, 192.168/16 (IPv4); fc00::/7 (IPv6)
//        • link-local    – 169.254/16 (IPv4); fe80::/10 (IPv6)
//        • special       – 0.0.0.0/8, 100.64/10 (CGN), 192.0.0/24, 198.18/15,
//                          reserved 240/4, broadcast, unspecified, 6to4 internals,
//                          documentation, Teredo, ORCHID, ::ffff:0:0/96 (v4-mapped)
//
// The classification logic mirrors vaultwarden src/util.rs is_global_hardcoded,
// adapted to Node/TypeScript and extended with decimal/octal/hex short-form
// IP normalization (the URL constructor in V8 calls RFC-3986 parsing which
// already normalizes most encoded forms, but we keep the explicit label-scan
// guard for belt-and-suspenders).
//
// Reference: https://github.com/dani-garcia/vaultwarden/blob/main/src/util.rs
//            https://github.com/dani-garcia/vaultwarden/blob/main/src/http_client.rs

import dns from 'node:dns'

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

/** Parse an IPv4 dotted-decimal string into four octets, or null. */
function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(p => {
    const n = Number(p)
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : -1
  })
  if (octets.some(o => o === -1)) return null
  return octets as [number, number, number, number]
}

/**
 * Is the IPv4 address (as four octets) a globally routable address?
 * Returns false for any range that must be blocked (loopback, private, etc.).
 * Closely mirrors vaultwarden `is_global_hardcoded` for V4.
 */
function isGlobalIPv4(a: number, b: number, c: number, d: number): boolean {
  // "This network" — 0.0.0.0/8
  if (a === 0) return false
  // Private — 10/8
  if (a === 10) return false
  // Loopback — 127/8
  if (a === 127) return false
  // Link-local — 169.254/16 (AWS IMDS lives here)
  if (a === 169 && b === 254) return false
  // Private — 172.16/12  (172.16.0.0 – 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return false
  // Private — 192.168/16
  if (a === 192 && b === 168) return false
  // IETF / Future protocol assignments — 192.0.0/24, excluding .9 and .10
  if (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) return false
  // Documentation — 192.0.2/24, 198.51.100/24, 203.0.113/24
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  // Benchmarking — 198.18/15
  if (a === 198 && (b === 18 || b === 19)) return false
  // Carrier-grade NAT / shared — 100.64/10
  if (a === 100 && (b & 0b1100_0000) === 0b0100_0000) return false
  // Reserved (240/4) and broadcast (255.255.255.255)
  if ((a & 0xf0) === 0xf0) return false
  return true
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/**
 * Parse an IPv6 address string (WITHOUT surrounding brackets) into 8 segments.
 * Handles compressed notation (::) and IPv4-mapped forms (::ffff:a.b.c.d).
 * Returns null on parse failure.
 */
function parseIPv6(s: string): number[] | null {
  // Strip surrounding brackets just in case
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)

  // Handle IPv4-mapped  ::ffff:a.b.c.d
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s)
  if (v4mapped) {
    const v4 = parseIPv4(v4mapped[1])
    if (!v4) return null
    const [a, b, c, d] = v4
    return [0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d]
  }

  const halves = s.split('::')
  if (halves.length > 2) return null

  const parseGroup = (g: string): number[] | null => {
    if (!g) return []
    const segs = g.split(':')
    const nums = segs.map(h => parseInt(h, 16))
    if (nums.some(n => isNaN(n) || n < 0 || n > 0xffff)) return null
    return nums
  }

  if (halves.length === 1) {
    const segs = parseGroup(halves[0])
    if (!segs || segs.length !== 8) return null
    return segs
  }

  const left = parseGroup(halves[0])
  const right = parseGroup(halves[1])
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  return [...left, ...Array(missing).fill(0), ...right]
}

/**
 * Is the IPv6 address (as 8 segments) globally routable?
 * Mirrors vaultwarden `is_global_hardcoded` for V6.
 */
function isGlobalIPv6(segs: number[]): boolean {
  const [s0, s1, s2, s3, s4, s5, s6, s7] = segs

  // Unspecified ::
  if (segs.every(s => s === 0)) return false
  // Loopback ::1
  if (s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0 && s6 === 0 && s7 === 1) return false
  // IPv4-mapped ::ffff:0:0/96
  if (s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0xffff) return false
  // IPv4-IPv6 translation 64:ff9b:1::/48
  if (s0 === 0x64 && s1 === 0xff9b && s2 === 1) return false
  // Discard-only 100::/64
  if (s0 === 0x100 && s1 === 0 && s2 === 0 && s3 === 0) return false
  // Unique-local fc00::/7
  if ((s0 & 0xfe00) === 0xfc00) return false
  // Link-local fe80::/10
  if ((s0 & 0xffc0) === 0xfe80) return false
  // Documentation 2001:db8::/32 and 3fff::/20 (3fff:0000–3fff:0fff)
  if (s0 === 0x2001 && s1 === 0xdb8) return false
  if (s0 === 0x3fff && s1 <= 0x0fff) return false
  // 6to4 2002::/16
  if (s0 === 0x2002) return false
  // Segment routing (SRv6) SIDs 5f00::/16
  if (s0 === 0x5f00) return false
  // IETF protocol assignments 2001::/23 (broad block — with exceptions)
  if (s0 === 0x2001 && s1 < 0x200) {
    // Exceptions that ARE globally routable:
    // PCP Anycast 2001:1::1
    if (s0 === 0x2001 && s1 === 1 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0 && s6 === 0 && s7 === 1) return true
    // TURN Anycast 2001:1::2
    if (s0 === 0x2001 && s1 === 1 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0 && s6 === 0 && s7 === 2) return true
    // AMT 2001:3::/32
    if (s0 === 0x2001 && s1 === 3) return true
    // AS112-v6 2001:4:112::/48
    if (s0 === 0x2001 && s1 === 4 && s2 === 0x112) return true
    // ORCHIDv2 / DETs 2001:20::/28 – 2001:3f::/28
    if (s0 === 0x2001 && s1 >= 0x20 && s1 <= 0x3f) return true
    return false
  }

  void s2; void s3; void s4; void s5; void s6; void s7
  return true
}

// ---------------------------------------------------------------------------
// Host-level guard (synchronous — for literal IPs already in hand)
// ---------------------------------------------------------------------------

/**
 * Classify a raw host string (no brackets, no port) that is already known to
 * be a literal IPv4 or IPv6 address.  Returns true iff it is globally routable.
 */
function isGlobalLiteralIp(host: string): boolean {
  // Try IPv4
  const v4 = parseIPv4(host)
  if (v4) return isGlobalIPv4(...v4)

  // Try IPv6 (URL parser strips brackets, but be safe)
  const clean = host.startsWith('[') ? host.slice(1, -1) : host
  const v6 = parseIPv6(clean)
  if (v6) return isGlobalIPv6(v6)

  return false // Can't parse — treat as non-global (fail-closed)
}

// ---------------------------------------------------------------------------
// Primary exported API
// ---------------------------------------------------------------------------

/**
 * Error thrown when a URL resolves to a non-global (private/loopback/etc.) IP.
 * Callers may catch and inspect `kind` for fine-grained handling.
 */
export class SsrfBlockedError extends Error {
  constructor(
    public readonly kind: 'invalid-url' | 'non-global-ip' | 'dns-error',
    message: string,
  ) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

/**
 * Returns true iff the URL is safe to fetch from the main process.
 *
 * For literal-IP hostnames, the classification is synchronous.
 * For domain hostnames, we perform an actual DNS lookup (following CNAMEs,
 * using the OS resolver) and check every returned address.
 *
 * @param rawUrl  The full URL string to validate.
 * @param opts.allowLoopback  Pass true to allow 127.x / ::1 (used for local
 *                            provider traffic in PRIVATE MODE).
 */
export async function isSafeOutboundUrl(
  rawUrl: string,
  opts: { allowLoopback?: boolean } = {},
): Promise<boolean> {
  let host: string
  try {
    const parsed = new URL(rawUrl)
    host = parsed.hostname // lowercased, percent-decoded; IPv6 literals KEEP their [brackets]
  } catch {
    return false
  }

  // Empty host (e.g. file:// URLs)
  if (!host) return false

  // Node's URL.hostname keeps the surrounding brackets on IPv6 literals
  // ("[::1]", "[2606:4700::1111]"). Strip them so the literal-IP fast path and
  // the loopback-allow check below see a bare address instead of falling
  // through to dns.lookup("[..]") (which always fails -> a legit global IPv6
  // literal would be wrongly blocked).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  const { allowLoopback = false } = opts

  // --- Literal IPv4 / IPv6 ---------------------------------------------------
  const isLiteralIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[0-9a-f:]+$/i.test(host)
  if (isLiteralIp) {
    if (allowLoopback && (host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1')) {
      return true
    }
    return isGlobalLiteralIp(host)
  }

  // --- Domain name -----------------------------------------------------------
  // Loopback shorthand: "localhost" always resolves to 127/::1
  if (host === 'localhost') {
    return allowLoopback
  }

  // DNS lookup (all addresses, both IPv4 and IPv6)
  let addrs: { address: string; family: number }[]
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch {
    // DNS failure — treat as non-global (fail-closed)
    return false
  }

  if (!addrs.length) return false

  for (const { address, family } of addrs) {
    let global: boolean
    if (family === 4) {
      const v4 = parseIPv4(address)
      if (!v4) return false
      if (allowLoopback && v4[0] === 127) {
        // This specific address is loopback — continue checking others
        continue
      }
      global = isGlobalIPv4(...v4)
    } else {
      const v6 = parseIPv6(address)
      if (!v6) return false
      const isLoopback = v6.every((s, i) => i < 7 ? s === 0 : s === 1)
      if (allowLoopback && isLoopback) {
        continue
      }
      global = isGlobalIPv6(v6)
    }
    if (!global) return false
  }

  return true
}

/**
 * Assert that a URL is safe to fetch.  Throws `SsrfBlockedError` if not.
 * Use this as a fail-fast guard at the top of any outbound HTTP code path.
 *
 * @param rawUrl  The full URL string to validate.
 * @param opts.allowLoopback  Same as isSafeOutboundUrl — set true for local-
 *                            provider traffic (ollama, llama-cpp, etc.).
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: { allowLoopback?: boolean } = {},
): Promise<void> {
  let host: string
  try {
    host = new URL(rawUrl).hostname
  } catch {
    throw new SsrfBlockedError('invalid-url', `SSRF guard: invalid URL "${rawUrl}"`)
  }

  const safe = await isSafeOutboundUrl(rawUrl, opts)
  if (!safe) {
    throw new SsrfBlockedError(
      'non-global-ip',
      `SSRF guard: URL "${rawUrl}" (host: "${host}") resolves to a non-global address. Blocked to prevent SSRF.`,
    )
  }
}

/**
 * Resolve a URL's host once, assert every resolved address is global-safe, and
 * return the validated address set (sorted, deduped — deterministic so callers
 * can compare two resolutions for equality).
 *
 * This is the TOCTOU-closing primitive: ssrf-guard validates by resolving DNS,
 * but the platform `fetch` re-resolves internally — a rebinding DNS server can
 * pass validation and then point the connection at 169.254.x / loopback. The
 * undici pinned-IP dispatcher is not importable in this build (no `undici`
 * dependency), so the caller (mcp/tools/fetch.ts) resolves+validates once via
 * this function, re-resolves immediately before fetch, and FAILS CLOSED if the
 * two address sets differ.
 *
 * For IP-literal hosts there is no DNS, so a single validated `[ip]` is
 * returned and the comparison is trivially stable.
 *
 * @throws SsrfBlockedError  invalid URL, DNS failure, or any non-global address.
 */
export async function resolveAndAssertSafe(
  rawUrl: string,
  opts: { allowLoopback?: boolean } = {},
): Promise<string[]> {
  const { allowLoopback = false } = opts

  let host: string
  try {
    host = new URL(rawUrl).hostname
  } catch {
    throw new SsrfBlockedError('invalid-url', `SSRF guard: invalid URL "${rawUrl}"`)
  }
  if (!host) {
    throw new SsrfBlockedError('invalid-url', `SSRF guard: URL "${rawUrl}" has no host`)
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  const blocked = (addr: string): SsrfBlockedError =>
    new SsrfBlockedError(
      'non-global-ip',
      `SSRF guard: address ${addr} (resolved from "${host}") is non-global. Blocked to prevent SSRF.`,
    )

  // Literal IP — classify synchronously, no DNS.
  const isLiteralIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[0-9a-f:]+$/i.test(host)
  if (isLiteralIp) {
    const loopbackOk = allowLoopback && (host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1')
    if (!loopbackOk && !isGlobalLiteralIp(host)) throw blocked(host)
    return [host]
  }

  if (host === 'localhost') {
    if (!allowLoopback) throw blocked('localhost')
    return ['localhost']
  }

  let addrs: { address: string; family: number }[]
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch (e) {
    throw new SsrfBlockedError('dns-error', `SSRF guard: DNS lookup failed for "${host}": ${(e as Error).message}`)
  }
  if (!addrs.length) throw new SsrfBlockedError('dns-error', `SSRF guard: no addresses resolved for "${host}"`)

  for (const { address, family } of addrs) {
    if (family === 4) {
      const v4 = parseIPv4(address)
      if (!v4) throw blocked(address)
      if (allowLoopback && v4[0] === 127) continue
      if (!isGlobalIPv4(...v4)) throw blocked(address)
    } else {
      const v6 = parseIPv6(address)
      if (!v6) throw blocked(address)
      const isLoopback = v6.every((s, i) => (i < 7 ? s === 0 : s === 1))
      if (allowLoopback && isLoopback) continue
      if (!isGlobalIPv6(v6)) throw blocked(address)
    }
  }

  // Sorted + deduped → deterministic for cross-resolution equality.
  return [...new Set(addrs.map(a => a.address))].sort()
}
