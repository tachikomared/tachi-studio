// apps/desktop/test/unit/freellmapiFreeRoute.test.ts
//
// The three places the free route lied to the user on the 2026-08-01 packaged
// build. None of them was a crash; all three were a confident claim with
// nothing behind it, which is why they shipped.
//
//   1. EVERY relay model in the composer's pin dropdown rendered with an EMPTY
//      name — "KILO", "OPENROUTER" and then nothing. The relay sends
//      `displayName`; this mapper read `m.name`, a field the relay has never
//      had, so every row arrived undefined.
//   2. The Free Providers card advertised OpenCode Zen as [FREE · NO KEY] for a
//      platform the shipped relay had never heard of. The card rendered a
//      hardcoded expectation instead of asking the thing it describes.
//   3. A model pinned from the composer could not be addressed at all — the
//      composer sends `platform/modelId` and the relay only understood bare
//      ids. Two of those ids also collide across platforms, so a bare form
//      could never have reached the Kilo copy either.
//
// These are contract tests: they pin the field names and the id form that cross
// the process boundary, because that boundary is where all three drifted.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FREELLMAPI_PROVIDERS, relayRowState, isRelayConnected, quotaLabel,
  type RelayPlatformFacts,
} from '../../src/pages/status/freellmapi-providers'

interface Handler { (event: unknown, payload?: unknown): unknown }
const handlers = vi.hoisted(() => new Map<string, Handler>())
const h = vi.hoisted(() => ({ port: 4321 as number | undefined }))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => { handlers.set(ch, fn) } },
}))
vi.mock('../../electron/services/sidecar-manager', () => ({
  getFreellmapiPort: () => h.port,
}))

await import('../../electron/ipc/freellmapi.ipc')

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

/** One row exactly as the relay's GET /api/fallback emits it. */
function relayRow(over: Record<string, unknown> = {}) {
  return {
    modelDbId: 1,
    priority: -20,
    effectivePriority: -20,
    penalty: 0,
    rateLimitHits: 0,
    enabled: true,
    platform: 'kilo',
    modelId: 'kilo-auto/free',
    displayName: 'Kilo Auto (Kilo)',
    intelligenceRank: 12,
    speedRank: 8,
    sizeLabel: 'Large',
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '~2-3M (200/hr)',
    keyCount: 1,
    ...over,
  }
}

function mockJson(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response
}

describe('freellmapi:list-fallback-models — the field name that emptied the dropdown', () => {
  beforeEach(() => { h.port = 4321; vi.restoreAllMocks() })

  it('reads the relay\'s displayName, not a `name` field the relay never sends', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(mockJson([relayRow()]))

    const res = await handlers.get('freellmapi:list-fallback-models')!({}) as {
      ok: boolean; models: Array<{ platform: string; modelId: string; name: string }>
    }

    expect(res.ok).toBe(true)
    expect(res.models).toHaveLength(1)
    expect(res.models[0].name).toBe('Kilo Auto (Kilo)')
    // The bug rendered exactly this: a platform tag and an empty string.
    expect(res.models[0].name).not.toBe('')
    expect(res.models[0].name).not.toBeUndefined()
  })

  it('falls back to the model id rather than rendering a nameless row', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(mockJson([relayRow({ displayName: '' })]))

    const res = await handlers.get('freellmapi:list-fallback-models')!({}) as {
      ok: boolean; models: Array<{ name: string }>
    }
    expect(res.models[0].name).toBe('kilo-auto/free')
  })

  it('still hides rows the router cannot use (no key, or disabled)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(mockJson([
      relayRow({ keyCount: 0 }),
      relayRow({ enabled: false, modelId: 'x' }),
      relayRow({ modelId: 'keep' }),
    ]))
    const res = await handlers.get('freellmapi:list-fallback-models')!({}) as {
      ok: boolean; models: Array<{ modelId: string }>
    }
    expect(res.models.map(m => m.modelId)).toEqual(['keep'])
  })
})

describe('freellmapi:list-platforms — the card stops guessing', () => {
  beforeEach(() => { h.port = 4321; vi.restoreAllMocks() })

  it('reports what the relay carries, including a platform with models but no key', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/api/fallback')) {
        return mockJson([
          relayRow({ platform: 'kilo' }),
          relayRow({ platform: 'kilo', modelId: 'b' }),
          relayRow({ platform: 'zen', modelId: 'deepseek-v4-flash-free' }),
        ])
      }
      return mockJson({
        platforms: [
          { platform: 'kilo', hasProvider: true, totalKeys: 1, healthyKeys: 1, invalidKeys: 0, enabledKeys: 1 },
          { platform: 'openrouter', hasProvider: true, totalKeys: 1, healthyKeys: 0, invalidKeys: 1, enabledKeys: 1 },
        ],
      })
    })

    const res = await handlers.get('freellmapi:list-platforms')!({}) as {
      ok: boolean
      platforms: Array<{ platform: string; modelCount: number; keyCount: number; invalidKeys: number }>
    }

    expect(res.ok).toBe(true)
    const by = new Map(res.platforms.map(p => [p.platform, p]))

    expect(by.get('kilo')).toMatchObject({ modelCount: 2, keyCount: 1 })
    // Present in the catalog, never seeded a key — the router skips it before
    // it opens a socket, so the card must not call it ready.
    expect(by.get('zen')).toMatchObject({ modelCount: 1, keyCount: 0 })
    // A key whose provider rejected it. This is the state that used to render
    // as "✓ Connected" while every send through it 401'd.
    expect(by.get('openrouter')).toMatchObject({ invalidKeys: 1, healthyKeys: 0 })
  })

  it('says it does not know rather than inventing a list when the relay is down', async () => {
    h.port = undefined
    const res = await handlers.get('freellmapi:list-platforms')!({}) as { ok: boolean; platforms: unknown[] }
    expect(res.ok).toBe(false)
    expect(res.platforms).toEqual([])
  })
})

describe('the composer/relay model-id contract', () => {
  const inputBar = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'pages', 'chat', 'InputBar.tsx'), 'utf8')
  const patch    = readFileSync(join(REPO_ROOT, 'scripts', 'patches', 'freellmapi-kilo-zen-freeroute.patch'), 'utf8')

  it('the composer pins with a PLATFORM-QUALIFIED id', () => {
    expect(inputBar).toContain('`${m.platform}/${m.modelId}`')
  })

  it('the relay patch teaches the proxy to resolve that form', () => {
    // Bare-first, then split on the FIRST slash. Both halves matter: bare-first
    // keeps vendor-prefixed ids (`nvidia/...`, `cohere/...`) working even though
    // those prefixes are also platform names.
    expect(patch).toContain('function resolveRequestedModel')
    expect(patch).toContain("requestedModel.indexOf('/')")
    expect(patch).toContain("WHERE platform = ? AND model_id = ? AND enabled = 1")
  })

  it('the relay patch fails over past a rejected credential instead of surfacing it', () => {
    expect(patch).toContain('function isCredentialError')
    expect(patch).toContain('user not found')
    // Retry alone would loop forever (the 429 penalty caps), so the key is
    // condemned as well — that is what makes the recovery permanent.
    expect(patch).toContain("status = 'invalid'")
  })

  it('the collision that made Kilo unaddressable is pinned by the relay\'s own suite', () => {
    expect(patch).toContain('proxy-model-addressing.test.ts')
    expect(patch).toContain('nvidia/nemotron-3-super-120b-a12b:free')
  })
})

describe('the Free Providers card renders the relay, not an expectation', () => {
  const card = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'pages', 'status', 'ProvidersCard.tsx'), 'utf8')

  it('asks the relay what it carries', () => {
    expect(card).toContain('listPlatforms')
  })

  it('the [FREE · NO KEY] badge is conditional on the relay actually having the platform', () => {
    // The badge used to be emitted unconditionally for every `noKey` row, which
    // is how OpenCode Zen was advertised on a relay that had never heard of it.
    const badgeIdx = card.indexOf('style={anonBadge}>[FREE · NO KEY]')
    expect(badgeIdx, 'the anon badge JSX moved — re-point this guard').toBeGreaterThan(-1)
    const guard = card.slice(Math.max(0, badgeIdx - 400), badgeIdx)
    expect(guard).toContain("relayStatus")
  })

  it('an expected-but-absent platform is shown, not hidden', () => {
    expect(card).toContain('[NOT IN THIS BUILD]')
    expect(card).toContain('[NO KEY SEEDED]')
    // And "we could not check" is its own state — never rendered as success.
    expect(card).toContain('[UNVERIFIED]')
  })

  it('a credential the provider rejected does not read as Connected', () => {
    expect(card).toContain('Key rejected')
    // The rejection is one of the states the shared derivation returns, so the
    // badge, the header count and the row copy cannot disagree about it.
    expect(card).toContain('rowState')
    expect(card).toContain("st === 'rejected'")
  })

  // ── ONE denominator ────────────────────────────────────────────────────────
  //
  // Driver, 2026-08-02 packaged build: header "12 / 16 connected", 16 rows with
  // 6 connected badges, relay registry 18 platforms / 6 healthy. Three numbers,
  // one install. The 12 was `connectedIds.size` — every credential in Tachi's
  // keychain, Brave Search and Civitai included — printed over a denominator of
  // free-router platforms.
  it('the header counts the SAME rows it renders, with the same predicate', () => {
    // Numerator: the listed platforms that pass the shared predicate.
    expect(card).toContain('FREELLMAPI_PROVIDERS.filter(p => isRelayConnected(rowState(p.id))).length')
    // The keychain size must never be the numerator again.
    expect(card).not.toContain('const connected = connectedIds.size')
  })

  it('says what the denominator MEANS, where it is printed', () => {
    expect(card).toContain('RELAY_DENOMINATOR')
  })

  it('the ✓ Connected badge is emitted by the same predicate the header counts', () => {
    // Badge and count cannot drift while both call isRelayConnected on the
    // state of the same row.
    expect(card).toContain('isRelayConnected(st)')
    expect(card).toContain('isRelayConnected(rowState(p.id))')
  })

  it('claims no count at all when the relay did not answer', () => {
    // "0 / 16 connected" would be a measurement; we did not take one.
    expect(card).toContain("{relayAnswered ? connected : '—'}")
  })

  it('discloses the platforms the router carries beyond this list', () => {
    expect(card).toContain('router carries {relayCarries}')
  })

  it('a quota value that already says "free" is not given a second one', () => {
    // The row template printed `{p.dailyFree} free` → "20 req/day free free".
    expect(card).not.toContain('{p.dailyFree} free')
    expect(card).toContain('quotaLabel(p)')
  })
})

describe('relayRowState / quotaLabel — the shared derivations', () => {
  const facts = (over: Partial<RelayPlatformFacts> = {}): RelayPlatformFacts => ({
    modelCount: 3, keyCount: 1, healthyKeys: 1, invalidKeys: 0, ...over,
  })

  it('ready ⇔ the router carries the platform AND holds an enabled key', () => {
    expect(relayRowState({ row: facts(), relayAnswered: true, hasSavedKey: true })).toBe('ready')
    expect(isRelayConnected('ready')).toBe(true)
  })

  it('a key the provider rejected is not connected, however saved it is', () => {
    const st = relayRowState({
      row: facts({ healthyKeys: 0, invalidKeys: 1 }), relayAnswered: true, hasSavedKey: true,
    })
    expect(st).toBe('rejected')
    expect(isRelayConnected(st)).toBe(false)
  })

  it('carried but unseeded, and not carried at all, are different and neither is connected', () => {
    expect(relayRowState({ row: facts({ keyCount: 0, healthyKeys: 0 }), relayAnswered: true, hasSavedKey: true })).toBe('unseeded')
    expect(relayRowState({ relayAnswered: true, hasSavedKey: true })).toBe('missing')
    expect(relayRowState({ row: facts({ modelCount: 0 }), relayAnswered: true, hasSavedKey: false })).toBe('missing')
    expect(isRelayConnected('unseeded')).toBe(false)
    expect(isRelayConnected('missing')).toBe(false)
  })

  it('a silent relay yields a claim about the keychain only — never "connected"', () => {
    expect(relayRowState({ relayAnswered: false, hasSavedKey: true })).toBe('key-saved')
    expect(relayRowState({ relayAnswered: false, hasSavedKey: false })).toBe('unknown')
    expect(isRelayConnected('key-saved')).toBe(false)
    expect(isRelayConnected('unknown')).toBe(false)
  })

  it('counts exactly the healthy platforms the relay reported (the driver\'s 6)', () => {
    // The relay's own registry: 18 platforms, 6 with a usable key. The header
    // must land on 6, not on 12 keychain entries.
    const healthy = new Set(['github', 'kilo', 'llm7', 'nvidia', 'openrouter', 'zen'])
    const count = FREELLMAPI_PROVIDERS.filter(p => isRelayConnected(relayRowState({
      ...(healthy.has(p.id) ? { row: facts() } : { row: facts({ keyCount: 0, healthyKeys: 0 }) }),
      relayAnswered: true,
      // Every listed platform has a key saved — the old numerator's population.
      hasSavedKey: true,
    }))).length
    expect(count).toBe(6)
  })

  it('appends "free" only to a quota phrase that does not already say it', () => {
    const by = (id: string) => FREELLMAPI_PROVIDERS.find(p => p.id === id)!
    expect(quotaLabel(by('google'))).toBe('20 req/day free')      // was "20 req/day free free"
    expect(quotaLabel(by('ollama'))).toBe('GPU-time quota (free)') // was "… (free) free"
    expect(quotaLabel(by('groq'))).toBe('1,000 req/day free')      // still gets the word
  })
})

describe('the anon key seed is no longer swallowed', () => {
  const mgr = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'electron', 'services', 'sidecar-manager.ts'), 'utf8')

  it('a rejected anon seed is logged as an error, with the platform named', () => {
    expect(mgr).toContain('ANON SEED REJECTED')
  })

  it('a key seeded from Tachi\'s keychain is validated before it can occupy a slot', () => {
    // The dead OpenRouter key sat at status='unknown', which the router treats
    // as usable. One check turns it into status='invalid', which the router
    // filters before it opens a socket.
    expect(mgr).toContain('/api/health/check/')
  })

  it('startup says out loud whether the relay carries its vendor patches', () => {
    expect(mgr).toContain('logPatchVerdicts')
  })
})
