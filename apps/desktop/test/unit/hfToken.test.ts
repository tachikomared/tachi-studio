// apps/desktop/test/unit/hfToken.test.ts
//
// The HuggingFace token: a second credential built to the SAME law the Civitai
// one was built to (d24056e / 9599ef5), because that law is the only reason the
// Civitai key is safe to ship:
//
//   ORIGIN-SCOPED   the Authorization header goes to huggingface.co and to
//                   NOTHING ELSE. HF's `/resolve/` URLs 302 to a signed CDN
//                   host (measured 2026-07-31: `us.aws.cdn.hf.co`, a CloudFront
//                   presign carrying Policy/Signature/Key-Pair-Id). Forwarding
//                   a Bearer across that hop leaks the token to a third-party
//                   host — installer-kit's same-origin guard drops it, and the
//                   host table here is what decides where it is attached at all.
//   NEVER PERSISTED downloads.json is plaintext under userData; the token's
//                   home is the DPAPI-encrypted keychain. The manager
//                   re-attaches per run from the keychain instead.
//   OPTIONAL        search and public downloads work with no token at all. It
//                   raises rate limits and unlocks repos THIS USER has accepted
//                   the terms for. "Required" would be a lie.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// vi.hoisted, not a bare const: vi.mock factories are hoisted ABOVE these
// declarations, so a factory closing over a plain `const` reads it in its
// temporal dead zone. (The same hoisting downloadManagerState/
// downloadRestartResume needed on 2026-08-02.)
const USERDATA = vi.hoisted(() => 'C:\\FakeUserData')

// download-manager's graph reaches storage-root → settings-store, and nothing
// under test here touches electron: the token lives in the keychain (stubbed
// below) and the host table is a pure function. Stub `app` so the graph loads
// whether or not settings-store reads userData eagerly.
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class { static getAllWindows() { return [] } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => String(b),
  },
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

const SETTINGS_PAGE = 'src/pages/settings/SettingsPage.tsx'
const SETTINGS_IPC = 'electron/ipc/settings.ipc.ts'

// The keychain is the unit under test's only real dependency; stub it so the
// token value is controllable and no OS keyring is touched.
let stored: string | null = null
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: (id: string) => (id === 'huggingface' ? stored : null),
  hasKey: (id: string) => id === 'huggingface' && stored !== null,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  HF_KEY_ID,
  hfAuthHeaders,
  hfTokenStored,
  validateHfToken,
  searchHuggingFace,
} from '../../electron/services/hf-search'
import { credentialKeyIdForDownloadUrl } from '../../electron/services/download-manager'
import { isSameDownloadOrigin } from '../../electron/services/util/installer-kit'

beforeEach(() => { stored = null; vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE KEYCHAIN ID
// ═══════════════════════════════════════════════════════════════════════════

describe('the keychain id', () => {
  it('is the one string every surface agrees on', () => {
    expect(HF_KEY_ID).toBe('huggingface')
  })

  it('is listed as a NON-provider key, or Settings can never say "key stored"', () => {
    // The exact shipped imgnai bug, and then the Civitai one: list-keys builds
    // provider ids FROM THE REGISTRY, and HuggingFace is a weights host with no
    // registry row — so it has to be named literally here.
    const src = stripComments(read(SETTINGS_IPC))
    expect(src).toMatch(/NON_PROVIDER_KEY_IDS\s*=\s*\[[^\]]*'huggingface'/)
  })

  it('reports storage without ever handing the secret back to the renderer', () => {
    expect(hfTokenStored()).toBe(false)
    stored = 'hf_abc123'
    expect(hfTokenStored()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. WHERE THE TOKEN IS — AND IS NOT — SENT
// ═══════════════════════════════════════════════════════════════════════════

describe('hfAuthHeaders', () => {
  it('is EMPTY with no token — anonymous, not broken', () => {
    expect(hfAuthHeaders()).toEqual({})
  })

  it('is a Bearer when one is stored', () => {
    stored = 'hf_abc123'
    expect(hfAuthHeaders()).toEqual({ Authorization: 'Bearer hf_abc123' })
  })
})

describe('the download host table', () => {
  it('attaches the HF token to huggingface.co', () => {
    expect(credentialKeyIdForDownloadUrl('https://huggingface.co/org/repo/resolve/main/f.gguf'))
      .toBe('huggingface')
  })

  it('does NOT attach it to the signed CDN the resolve URL redirects to', () => {
    // MEASURED: huggingface.co/.../resolve/main/... → 302 →
    // https://us.aws.cdn.hf.co/xet-bridge-us/...?Policy=...&Signature=...
    // The presign authenticates the URL; a Bearer there is pure leakage.
    for (const cdn of [
      'https://us.aws.cdn.hf.co/xet-bridge-us/abc?Signature=x',
      'https://cdn-lfs.hf.co/repos/aa/bb/file.safetensors',
      'https://cas-bridge.xethub.hf.co/xet-bridge-us/abc',
    ]) {
      expect(credentialKeyIdForDownloadUrl(cdn), cdn).toBeNull()
    }
  })

  it('is an EXACT host match — no suffix trick gets the token', () => {
    expect(credentialKeyIdForDownloadUrl('https://huggingface.co.evil.test/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://nothuggingface.co/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('http://huggingface.co/x')).toBeNull()  // https only
  })

  it('the second line of defence agrees: the CDN hop is cross-origin', () => {
    // Even if the table were wrong, installer-kit drops the header here.
    expect(isSameDownloadOrigin(
      'https://huggingface.co/org/repo/resolve/main/f.gguf',
      'https://us.aws.cdn.hf.co/xet-bridge-us/abc',
    )).toBe(false)
    expect(isSameDownloadOrigin(
      'https://huggingface.co/a', 'https://huggingface.co/b',
    )).toBe(true)
  })

  it('leaves the Civitai row exactly as it was', () => {
    expect(credentialKeyIdForDownloadUrl('https://civitai.com/api/download/models/1')).toBe('civitai')
  })
})

describe('searchHuggingFace attaches the token to its own API calls', () => {
  it('sends Bearer on the list request when a token is stored', async () => {
    stored = 'hf_tok'
    const seen: Array<{ url: string; auth?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), auth: h.Authorization })
      return { ok: true, json: async () => [] } as unknown as Response
    }))
    await searchHuggingFace('llama')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]!.url).toContain('huggingface.co')
    expect(seen[0]!.auth).toBe('Bearer hf_tok')
  })

  it('sends NO Authorization header at all when none is stored', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return { ok: true, json: async () => [] } as unknown as Response
    }))
    await searchHuggingFace('llama')
    expect(seen[0]).not.toHaveProperty('Authorization')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE VALIDATION PING
// ═══════════════════════════════════════════════════════════════════════════

describe('validateHfToken — GET /api/whoami-v2', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response

  it('returns the username on success, so the card can prove WHOSE token it is', async () => {
    const spy = vi.fn(async () => okResponse({ name: 'dmitry', type: 'user' }))
    vi.stubGlobal('fetch', spy)
    await expect(validateHfToken('hf_live')).resolves.toEqual({ ok: true, name: 'dmitry' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://huggingface.co/api/whoami-v2')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hf_live')
  })

  it('validates the TYPED token, never the stored one', async () => {
    // The card pings before it saves; pinging the keychain copy would report
    // success for a token the user is about to replace.
    stored = 'hf_old'
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ name: 'x' })))
    await validateHfToken('hf_new')
    const spy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const init = spy.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hf_new')
  })

  it('a 401 is a REJECTION — the one answer that stops the card storing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response))
    await expect(validateHfToken('bad'))
      .resolves.toEqual({ ok: false, verdict: 'rejected', status: 401 })
  })

  it('a 403 or a 5xx is UNVERIFIED, not a rejection', async () => {
    // On HF a 403 is a SCOPE problem, not a bad token, and a 503 is not about
    // the token at all. Blocking the save on either used to strand a working
    // credential while telling the user it was bad.
    for (const status of [403, 429, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status }) as unknown as Response))
      await expect(validateHfToken('hf_x'), String(status))
        .resolves.toEqual({ ok: false, verdict: 'unverified', status })
    }
  })

  it('never throws on a network failure — and that is unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(validateHfToken('hf_x')).resolves.toEqual({ ok: false, verdict: 'unverified' })
  })

  it('refuses an empty token without touching the network', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateHfToken('   ')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. DISCOVERABILITY — the thing the owner actually asked for
// ═══════════════════════════════════════════════════════════════════════════

describe('Settings — the API keys group', () => {
  const src = stripComments(read(SETTINGS_PAGE))

  it('puts the weights-host keys in their OWN rail section, not under "Search"', () => {
    // The report was "I don't see where I can add my civitai / huggingface API
    // keys". The Civitai card existed — filed under Search, next to Brave and
    // Tavily, which is where nobody looks for a model-host credential.
    expect(src).toMatch(/id: 'api-keys'/)
    expect(src).toContain("connections.rail.apiKeys")
  })

  it('lists both cards in it, with searchable titles', () => {
    const section = src.slice(src.indexOf("id: 'api-keys'"), src.indexOf("id: 'api-keys'") + 900)
    expect(section).toContain('<CivitaiCard />')
    expect(section).toContain('<HuggingFaceCard />')
    // The connections filter matches on the card TITLE, so the words a user
    // would actually type have to be in it.
    expect(section).toMatch(/API key/i)
  })

  it('the HF card stores under the id main reads, and can remove it', () => {
    expect(src).toMatch(/const HF_KEY_ID = 'huggingface'/)
    expect(src).toContain('window.tachi.settings.saveKey(HF_KEY_ID')
    expect(src).toContain('window.tachi.settings.deleteKey(HF_KEY_ID)')
  })

  it('the HF input is masked — a token is never rendered in the clear', () => {
    const card = src.slice(src.indexOf('function HuggingFaceCard'))
    expect(card.slice(0, 4000)).toContain("type=\"password\"")
  })

  it('pings whoami and shows the username', () => {
    const card = src.slice(src.indexOf('function HuggingFaceCard'))
    expect(card.slice(0, 4000)).toContain('window.tachi.hf.validateToken(')
  })
})

describe('Catalog — the pointer TO settings', () => {
  const src = stripComments(read('src/pages/catalog/CatalogPage.tsx'))

  it('tells the user where the key lives when Civitai rate-limits or errors', () => {
    // 503s are routine on this API. An error with no next step trains people to
    // conclude the feature is broken.
    expect(src).toContain('civitai.keyHint')
  })
})
