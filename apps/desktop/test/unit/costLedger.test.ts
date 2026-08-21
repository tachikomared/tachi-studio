// apps/desktop/test/unit/costLedger.test.ts
//
// Persistent per-provider token/cost ledger + rolling-window spend query
// (STEAL 2026-06-12 cluster A / strategic #1; Pulse internal/ai/cost/store.go).
// Closes the "no LLM/$ spend cap" gap from the 2026-06-12 security audit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CostLedger,
  registerLiveRateResolver,
  resolveRegisteredLiveRates,
  __clearLiveRateResolversForTests,
} from '../../electron/services/cost-ledger'

const DAY = 86_400_000
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cost-ledger-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

function makeLedger(nowMs: { t: number }) {
  return new CostLedger(join(dir, 'cost-ledger.jsonl'), () => nowMs.t)
}

describe('CostLedger.record', () => {
  it('prices known models and appends a JSONL line', () => {
    const now = { t: 1_718_200_000_000 }
    const ledger = makeLedger(now)
    const ev = ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.priced).toBe(true)
    const lines = readFileSync(join(dir, 'cost-ledger.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ provider: 'anthropic-oauth', model: 'claude-sonnet-4.6' })
  })

  it('records unpriced models with costUsd 0 and priced:false', () => {
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('ollama', 'llama3.2:3b', 5000, 5000)
    expect(ev.costUsd).toBe(0)
    expect(ev.priced).toBe(false)
  })

  it('tags WHY an event is unpriced: local provider = free, missing price = unknown', () => {
    const ledger = makeLedger({ t: 1 })
    expect(ledger.record('ollama', 'llama3.2:3b', 5000, 5000).unpricedReason).toBe('free')
    expect(ledger.record('opengateway', 'auto', 5000, 5000).unpricedReason).toBe('unknown')
    // Priced events carry no reason at all.
    expect('unpricedReason' in ledger.record('opengateway', 'tencent/hy3', 1000, 1000)).toBe(false)
  })

  it('records a :free-suffixed PAID alias as real spend, not $0', () => {
    // tencent/hy3 is paid (live catalog 2026-08-01) but ships a :free alias.
    // The old `/:free$/ → $0` shortcut made this invisible to the spend cap.
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('opengateway', 'tencent/hy3:free', 1_000_000, 1_000_000)
    expect(ev.priced).toBe(true)
    expect(ev.costUsd).toBeGreaterThan(0)
  })

  it('still records a genuinely free model as $0 — now tagged WHY (reason: free)', () => {
    // 2026-08-01: a model VERIFIED free against its provider's catalog gets
    // unpricedReason 'free' (the reason's own doc always promised this case),
    // so a known-$0 event is bookkept like the local/keyless-free providers
    // instead of masquerading as a priced-at-zero cloud call.
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('opengateway', 'nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000, 1_000_000)
    expect(ev.costUsd).toBe(0)
    expect(ev.unpricedReason).toBe('free')
  })

  // ── OpenRouter per-model free signal reaches the ledger (2026-08-01) ───────
  it('an openrouter model live-priced 0/0 records $0 with reason "free"', () => {
    // THE PIN: openrouter-oauth is billing 'paid' at provider level (322 paid
    // models), so the $0 must come from the PER-MODEL verified-free signal —
    // the dated VERIFIED_FREE_MODELS entry mirroring the live catalog's
    // pricing.prompt === "0" && pricing.completion === "0" — never from the
    // provider and never from the :free suffix.
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('openrouter-oauth', 'google/gemma-4-31b-it:free', 1_000_000, 1_000_000)
    expect(ev.costUsd).toBe(0)
    expect(ev.unpricedReason).toBe('free')
    // Contributes NOTHING to the spend cap — not even the unknown estimate.
    expect(ledger.spendBreakdownSince(0).totalUsd).toBe(0)
  })

  it('a PAID openrouter model is unaffected — real spend, no reason tag', () => {
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('openrouter-oauth', 'anthropic/claude-sonnet-4.6', 1_000_000, 1_000_000)
    expect(ev.priced).toBe(true)
    expect(ev.costUsd).toBeGreaterThan(0)
    expect('unpricedReason' in ev).toBe(false)
  })

  it('a LEGACY kilo-gateway ledger row still records, and claims nothing', () => {
    // kilo-gateway was a registry provider with billing 'free' until it became
    // an upstream inside the relay on 2026-08-01. Old ledger rows still carry
    // that id, so recording one must not throw — and with the descriptor gone,
    // providerBilling() falls back to 'paid', the claim-nothing direction. The
    // row reads as unpriced rather than as a fabricated $0.
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('kilo-gateway', 'kilo-auto/free', 500_000, 500_000)
    expect(ev).toBeDefined()
    expect(ev.unpricedReason).not.toBe('free')
    // Whatever the fallback prices it at, it must never be a silent negative or
    // NaN that would corrupt the 30-day spend cap.
    expect(Number.isFinite(ev.costUsd)).toBe(true)
    expect(ev.costUsd).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(ledger.spendBreakdownSince(0).totalUsd)).toBe(true)
  })

  it('the relay itself is still the known-$0 provider-level case', () => {
    // The mechanism the Kilo row used to demonstrate is unchanged and still
    // covered: a registry provider with billing 'free' prices every model it
    // serves at $0, including ids the price table has never heard of.
    const ledger = makeLedger({ t: 1 })
    const ev = ledger.record('freellmapi-local', 'nvidia/nemotron-3-ultra-550b-a55b:free', 500_000, 500_000)
    expect(ev.costUsd).toBe(0)
    expect(ev.unpricedReason).toBe('free')
    expect(ledger.spendBreakdownSince(0).totalUsd).toBe(0)
  })

  // ── cached tokens (2026-08-01) ────────────────────────────────────────────
  //
  // SEMANTICS, PINNED DELIBERATELY: `cachedTokens` is a SUBSET of promptTokens,
  // never additional. Evidence, not assumption:
  //   * ai@7 reports inputTokenDetails = { noCacheTokens, cacheReadTokens, ... }
  //     that SUM to inputTokens (see cachedTokens.test.ts: 700 + 300 = 1000);
  //   * OpenAI's prompt_tokens_details.cached_tokens is a breakdown OF
  //     prompt_tokens;
  //   * cache-stats.cacheHitRatio divides cached BY total input, which is only
  //     meaningful for a subset.
  // So costUsd RE-PRICES that slice at cacheReadPerM — it must never add a
  // fourth term. If a future refactor treats cachedTokens as additional, the
  // "same totals" assertion below fails: total cost would EXCEED the uncached
  // baseline instead of falling under it.
  it('bills cached prompt tokens at the cache-read rate, not full input', () => {
    const ledger = makeLedger({ t: 1 })
    // claude-sonnet-4.6: in $3/M, cacheRead $0.3/M, out $15/M.
    const uncached = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 0)
    const cached   = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 0, undefined, 1_000_000)
    expect(uncached.costUsd).toBeCloseTo(3)
    expect(cached.costUsd).toBeCloseTo(0.3)
    // Same token totals, strictly cheaper — the whole point.
    expect(cached.promptTokens).toBe(uncached.promptTokens)
    expect(cached.costUsd).toBeLessThan(uncached.costUsd)
  })

  it('prices a partial cache hit as the split, and never above the uncached price', () => {
    const ledger = makeLedger({ t: 1 })
    // 600k of 1M input served from cache: 400k × $3/M + 600k × $0.3/M = $1.38.
    const ev = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 0, undefined, 600_000)
    expect(ev.costUsd).toBeCloseTo(1.38)
    expect(ev.costUsd).toBeLessThan(3)   // subset re-priced, NOT an added term
  })

  it('a provider-reported 0 cache hit costs exactly the uncached price', () => {
    const ledger = makeLedger({ t: 1 })
    expect(ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 0, undefined, 0).costUsd)
      .toBeCloseTo(3)
  })
})

// ── The TACHI harness is not a billing entity (2026-08-01) ───────────────────
//
// runTachiSession is electron-coupled (keychain + sidecar-manager), so the
// wiring itself is asserted against the SOURCE — same convention as
// turnResetWiring.test.ts. The BEHAVIOUR the wiring buys is exercised for real
// against the ledger below.
describe('TACHI runs are recorded under the provider that served them', () => {
  const APP = join(__dirname, '../..')
  const read = (rel: string) => readFileSync(join(APP, rel), 'utf8')

  it('the router publishes the real provider id for every route it can take', () => {
    const src = read('electron/services/tachi/provider.ts')
    expect(src).toContain('providerId: ProviderId')
    for (const id of ['bankr-gateway', 'surplus', 'venice', 'imgnai', 'opengateway', 'freellmapi-local']) {
      expect(src).toContain(`providerId: '${id}'`)
    }
  })

  it('the loop records THAT id, never the literal harness name', () => {
    const src = read('electron/services/tachi/loop.ts')
    expect(src).toContain('ledgerProviderId = routing.providerId')
    expect(src).toContain('ledger.record(ledgerProviderId, modelId')
    expect(src).not.toContain("ledger.record('tachi'")
  })

  it('a local TACHI run charges the spend cap nothing, even on an unpriceable model id', () => {
    // freellmapi routes with modelId 'auto', which no price table can resolve.
    // Labelled 'tachi' it was UNKNOWN → charged the cap an invented estimate.
    // Labelled honestly it is known-FREE → $0.
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    const ev = ledger.record('freellmapi-local', 'auto', 4_000_000, 2_000_000)
    expect(ev.unpricedReason).toBe('free')
    expect(ledger.spendUsdSince(now.t - DAY)).toBe(0)
  })

  it('a local TACHI run on a llama-named model is not billed at llama cloud rates', () => {
    // 'llama3.3' hits the 'llama' keyword fallback ($0.2/M in) in the price
    // table. Under provider 'tachi' that was recorded as REAL spend.
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    expect(ledger.record('ollama-local', 'llama3.3', 5_000_000, 5_000_000).costUsd).toBe(0)
    expect(ledger.spendUsdSince(now.t - DAY)).toBe(0)
  })

  it('a CLOUD TACHI run still bills — the fix must not become a free pass', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    const ev = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 1_000_000)
    expect(ev.priced).toBe(true)
    expect(ev.costUsd).toBeCloseTo(18)
    expect(ledger.spendUsdSince(now.t - DAY)).toBeCloseTo(18)
  })
})

// ── Nor is the Fusion re-run, nor the OpenClaude sidecar (2026-08-01) ─────────
//
// The same defect, twice more: a harness recording ITSELF as the provider. The
// remaining two sites are closed here, same convention as above — source-level
// assertions for the electron-coupled wiring, real ledger runs for the money.
describe('the other two harness self-labels are gone', () => {
  const APP = join(__dirname, '../..')
  const read = (rel: string) => readFileSync(join(APP, rel), 'utf8')
  /** Drop comments, so an assertion about CODE is never satisfied — or, as here,
   *  DEFEATED — by prose. A fix whose comment quotes the expression it removed
   *  failed a `not.toContain` against its own explanation. */
  const code = (rel: string) =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('getChatBackend publishes the canonical id it resolved (the caller may pass an alias)', () => {
    const src = read('electron/services/provider-service.ts')
    expect(src).toContain('providerId: ProviderId')
    expect(src).toContain("providerId: 'bankr-gateway'")
  })

  it('the fusion re-run records THAT id, never the harness name', () => {
    const src = read('electron/ipc/fusion.ipc.ts')
    expect(src).toContain('ledger.record(resolved.providerId,')
    expect(src).not.toContain("ledger.record('tachi'")
  })

  // FIXED 2026-08-01 (second half): the gateway is now captured AT SPAWN in
  // sidecar-manager.startOpenClaude() — a tagged routing tuple picks the env
  // and its ledger provider id in ONE expression, the slot stores it, and
  // getOpenClaudeLedgerProviderId() exposes it. Routing is fixed at spawn, so
  // reading getAgentProviderOverride() at request time would describe the
  // NEXT spawn's gateway, not the running process's — which is why the client
  // could never fix this alone.
  it('the routing tuple carries a ledger id for every gateway the spawn can take', () => {
    const src = read('electron/services/sidecar-manager.ts')
    for (const id of ['bankr-gateway', 'surplus', 'venice', 'imgnai', 'opengateway', 'freellmapi-local']) {
      expect(src).toContain(`providerId: '${id}'`)
    }
    expect(src).toContain('slot.ledgerProviderId = routing.providerId')
    expect(src).toContain('export function getOpenClaudeLedgerProviderId')
    // The MODEL is captured from the same tuple, for the same reason.
    expect(src).toContain('slot.ledgerModelId = routing.env.OPENAI_MODEL')
    expect(src).toContain('export function getOpenClaudeLedgerModelId')
  })

  // The provider column's defect had a twin in the model column, undisclosed:
  // `modelId || 'openclaude'` wrote the HARNESS NAME where a model belongs.
  // It fired live once — a venice row reading `"model":"openclaude"`.
  it('never writes the harness name into the MODEL column', () => {
    expect(code('electron/services/openclaude-client.ts')).not.toContain("modelId || 'openclaude'")
    expect(read('electron/services/openclaude-client.ts')).toContain("getOpenClaudeLedgerModelId() || 'unknown'")
  })

  // The chat path had the SAME defect in a seventh place: seven provider
  // branches substitute a real model when the picker says 'auto', send that,
  // and then recorded the picker's value. `auto` matches no rate row, so on a
  // PAID provider the event lands unpriced and invisible to the 30-day cap —
  // 47 such rows already exist under bankr-gateway.
  it('chat attributes usage to the model the REQUEST was sent with', () => {
    const src = code('electron/services/chat-service.ts')
    // The recorder takes the served model…
    expect(src).toContain('const recordUsageChunk = (chunk: ChatChunk, servedModel?: string): void =>')
    expect(src).toContain('servedModel || effectiveModel')
    // …and the shared dispatcher supplies it from the very argument that
    // decides what goes on the wire, so no future branch can forget to.
    expect(src).toContain('const recordServed = (chunk: ChatChunk) => recordUsageChunk(chunk, model)')
    expect(src).toContain('recordUsageChunk: recordServed')
  })

  it("'auto' is a routing category, and pricing it proves why the fix matters", () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    // What the seven branches used to write on a PAID provider: unpriced, so
    // the cap cannot see it…
    const asCategory = ledger.record('bankr-gateway', 'auto', 1_000_000, 500_000)
    expect(asCategory.priced).toBe(false)
    // …versus the model that actually served it.
    const asServed = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 500_000)
    expect(asServed.priced).toBe(true)
    expect(asServed.costUsd).toBeGreaterThan(0)
  })

  // A model captured from the wrong event is a different model. 'system' also
  // covers retries and compaction; only init states what backs the run.
  it('reads the model from the INIT event, not from any system event', () => {
    const src = read('electron/services/openclaude-client.ts')
    expect(src).toContain("msg.type === 'system' && msg.subtype === 'init'")
  })

  // 'unknown' must stay UNPRICED-and-estimated rather than silently free: an
  // unknown model that priced as $0 would hide real spend from the cap, which
  // is the one direction this ledger may never err in.
  it('an unknown model over-counts instead of vanishing', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    const ev = ledger.record('bankr-gateway', 'unknown', 1_000_000, 1_000_000)
    expect(ev.priced).toBe(false)
    expect(ev.unpricedReason).toBe('unknown')
    expect(ledger.spendBreakdownSince(now.t - DAY).estimatedUnknownUsd).toBeGreaterThan(0)
  })

  // HANDOFF FORCING FUNCTION — deliberately RED until openclaude-client.ts
  // consumes the getter at its recordSpend call site (one dynamic import; that
  // file belongs to the ledger lane, handed off 2026-08-01). This used to pin
  // the WRONG behaviour ("COSTS THE CAP AN INVENTED $5"): provider 'openclaude'
  // matches no registry entry, so a run on the FREE local router priced model
  // 'auto' as 'unknown' and charged llmBudgetUsd30d ~$5 of invented spend
  // (4M × $0.25/M + 2M × $2/M) for work that cost nothing.
  it('records the SPAWN-CAPTURED gateway — free work costs the cap $0, not an invented $5', () => {
    const src = read('electron/services/openclaude-client.ts')
    expect(src).toContain('getOpenClaudeLedgerProviderId')
    expect(src).not.toContain("recordSpend('openclaude',")

    // The money the right label stops inventing: the SAME tokens that charged
    // the cap ~$5 under 'openclaude'/'auto' are free under the captured id.
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    expect(ledger.record('freellmapi-local', 'auto', 4_000_000, 2_000_000).unpricedReason).toBe('free')
    expect(ledger.spendUsdSince(now.t - DAY)).toBe(0)
  })

  it('a CLOUD openclaude run still bills, cache hits included at the cheaper rate', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    // Reported usage now reaches the ledger: 1M input of which 900k was a cache
    // read → 100k × $3/M + 900k × $0.3/M + 1M × $15/M.
    const ev = ledger.record('bankr-gateway', 'claude-sonnet-4.6', 1_000_000, 1_000_000, undefined, 900_000)
    expect(ev.priced).toBe(true)
    expect(ev.costUsd).toBeCloseTo(0.3 + 0.27 + 15)
    expect(ledger.spendUsdSince(now.t - DAY)).toBeGreaterThan(0)
  })
})

describe('CostLedger.spendUsdSince', () => {
  it('sums only events inside the window', () => {
    // First event 40 days before the second — outside a 30-day window.
    const now = { t: 80 * DAY }
    const ledger = makeLedger(now)
    ledger.record('a', 'claude-sonnet-4.6', 1_000_000, 0) // $3 at t=80d
    now.t = 120 * DAY
    ledger.record('a', 'claude-sonnet-4.6', 1_000_000, 0) // $3 at t=120d
    // 30d window from t=120d (= [90d, 120d]) → only the second event
    expect(ledger.spendUsdSince(now.t - 30 * DAY)).toBeCloseTo(3)
    // 30d window ending later → none
    now.t = 200 * DAY
    expect(ledger.spendUsdSince(now.t - 30 * DAY)).toBeCloseTo(0)
  })

  it('does NOT let unknown-price usage read to the cap as free', () => {
    // The spend-cap half of the 2026-08-01 fix. An unpriced CLOUD call used to
    // add exactly $0 to the figure the budget gate compares against.
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    ledger.record('opengateway', 'auto', 2_000_000, 1_000_000)
    const b = ledger.spendBreakdownSince(now.t - DAY)
    expect(b.pricedUsd).toBe(0)              // nothing KNOWN was spent
    expect(b.unknownEvents).toBe(1)
    expect(b.estimatedUnknownUsd).toBeCloseTo(2 * 0.25 + 1 * 2)  // UNKNOWN_PRICE_ESTIMATE
    expect(ledger.spendUsdSince(now.t - DAY)).toBeGreaterThan(0)
  })

  it('never charges known-free usage against the cap', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    ledger.record('ollama', 'some-local-gguf', 5_000_000, 5_000_000)              // local
    ledger.record('opengateway', 'nvidia/nemotron-3-ultra-550b-a55b:free', 5_000_000, 5_000_000)
    expect(ledger.spendUsdSince(now.t - DAY)).toBe(0)
  })

  it('keeps the displayed summary honest — the cap estimate is not shown as money', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    ledger.record('opengateway', 'auto', 1_000_000, 1_000_000)
    expect(ledger.summary(30).totalUsd).toBe(0)            // honest: nothing KNOWN
    expect(ledger.summary(30).byProvider['opengateway']).toMatchObject({ unpricedEvents: 1 })
    expect(ledger.spendUsdSince(now.t - DAY)).toBeGreaterThan(0)  // but the cap sees it
  })

  it('legacy events with no unpricedReason keep the old no-charge behaviour', () => {
    // Pre-2026-08-01 lines on disk have priced:false and no reason. They must
    // not retroactively start charging (they age out of the 30-day window).
    const file = join(dir, 'legacy.jsonl')
    writeFileSync(file, JSON.stringify({
      ts: 10 * DAY, provider: 'opengateway', model: 'auto',
      promptTokens: 9_000_000, completionTokens: 9_000_000, costUsd: 0, priced: false,
    }) + '\n', 'utf8')
    const ledger = new CostLedger(file, () => 10 * DAY)
    expect(ledger.spendUsdSince(0)).toBe(0)
  })
})

describe('CostLedger persistence', () => {
  it('a new instance over the same file sees prior spend', () => {
    const now = { t: 50 * DAY }
    // claude-opus-4.6 input is $5/M (Anthropic pricing page, read 2026-08-02).
    // This assertion said $15 while the table still carried the Opus 4.1-era
    // rate; the 2026-08-02 audit corrected the row, so it corrects here too.
    makeLedger(now).record('a', 'claude-opus-4.6', 1_000_000, 0) // $5
    const reloaded = makeLedger(now)
    expect(reloaded.spendUsdSince(now.t - DAY)).toBeCloseTo(5)
  })
})

describe('CostLedger.summary', () => {
  it('aggregates per provider over the window', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0)  // $3
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 0, 1_000_000)  // $15
    ledger.record('ollama', 'llama3.2:3b', 9000, 1000)                   // $0 unpriced
    const s = ledger.summary(30)
    expect(s.totalUsd).toBeCloseTo(18)
    expect(s.byProvider['anthropic-oauth']).toMatchObject({ usd: 18, events: 2 })
    expect(s.byProvider['ollama']).toMatchObject({ usd: 0, events: 1, unpricedEvents: 1 })
    expect(s.byProvider['anthropic-oauth']!.promptTokens).toBe(1_000_000)
    expect(s.byProvider['anthropic-oauth']!.completionTokens).toBe(1_000_000)
  })

  it('aggregates by task type, bucketing untyped events under "other"', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0, 'debugging') // $3
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0, 'debugging') // $3
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0, 'feature')   // $3
    ledger.record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0)              // untyped → other
    const s = ledger.summary(30)
    expect(s.byTaskType['debugging']).toMatchObject({ usd: 6, events: 2 })
    expect(s.byTaskType['feature']).toMatchObject({ events: 1 })
    expect(s.byTaskType['other']).toMatchObject({ events: 1 })
  })
})

// ── The live-rate seam (2026-08-02) ──────────────────────────────────────────
// A provider that publishes what it is charging today beats a bundled snapshot
// that drifts. But a LEDGER prices a run at the rate in force WHEN IT RAN, so
// the live rate is read exactly once — at record() time — and the resulting
// dollar figure is stamped onto the event and never re-derived.
describe('CostLedger — live rates beat the static table, at record time only', () => {
  const liveOnly = (rates: { inputPerM: number; outputPerM: number } | null) =>
    (nowMs: { t: number }) =>
      new CostLedger(join(dir, 'cost-ledger.jsonl'), () => nowMs.t, () => rates)

  it('prices from the live rate when one is supplied', () => {
    const now = { t: 10 * DAY }
    // The static table prices claude-sonnet-4.6 at $3/M in. The live rate says
    // $9/M, and the live rate wins.
    const ev = liveOnly({ inputPerM: 9, outputPerM: 0 })(now)
      .record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(9)
    expect(ev.priced).toBe(true)
    expect(ev.rateSource).toBe('live-catalog')
  })

  it('falls back to the static table when no live rate is available', () => {
    const now = { t: 10 * DAY }
    const ev = liveOnly(null)(now).record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.rateSource).toBe('price-table')
  })

  it('a resolver that THROWS never costs the ledger an event', () => {
    // The ledger is the spend cap's data. A live-rate lookup may improve
    // accuracy; it must never be the reason a usage event goes unpriced.
    const now = { t: 10 * DAY }
    const ledger = new CostLedger(join(dir, 'cost-ledger.jsonl'), () => now.t, () => {
      throw new Error('catalog exploded')
    })
    const ev = ledger.record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.priced).toBe(true)
    expect(ev.rateSource).toBe('price-table')
  })

  it('a nonsensical live rate degrades to the table rather than to $0', () => {
    const now = { t: 10 * DAY }
    const ev = liveOnly({ inputPerM: -5, outputPerM: 2 })(now)
      .record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.rateSource).toBe('price-table')
  })

  it('THE LEDGER RULE: a later rate change cannot re-price a stored event', () => {
    // Record at $9/M, then reload with a resolver quoting $100/M. The stored
    // cost must be untouched — summary() and spendUsdSince() only ever SUM the
    // persisted costUsd. This is what makes the ledger an audit trail rather
    // than a re-evaluation of history at today's prices.
    const now = { t: 10 * DAY }
    liveOnly({ inputPerM: 9, outputPerM: 0 })(now)
      .record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)

    const reloaded = liveOnly({ inputPerM: 100, outputPerM: 100 })(now)
    expect(reloaded.spendUsdSince(now.t - DAY)).toBeCloseTo(9)
    expect(reloaded.summary(30).totalUsd).toBeCloseTo(9)
  })

  it('a live rate of $0/$0 is honoured as free, not treated as missing', () => {
    const now = { t: 10 * DAY }
    const ev = liveOnly({ inputPerM: 0, outputPerM: 0 })(now)
      .record('openrouter-oauth', 'some/genuinely-free-row', 1_000_000, 1_000_000)
    expect(ev.costUsd).toBe(0)
    // priced:true — we KNOW it is zero, which is not the same as not knowing.
    expect(ev.priced).toBe(true)
    expect(ev.rateSource).toBe('live-catalog')
    // …and a known-$0 event contributes nothing to the cap's unknown estimate.
    const b = new CostLedger(join(dir, 'cost-ledger.jsonl'), () => now.t)
      .spendBreakdownSince(now.t - DAY)
    expect(b.unknownEvents).toBe(0)
    expect(b.totalUsd).toBe(0)
  })

  it('a local/free provider still short-circuits before any live lookup', () => {
    const now = { t: 10 * DAY }
    const resolver = vi.fn(() => ({ inputPerM: 99, outputPerM: 99 }))
    const ledger = new CostLedger(join(dir, 'cost-ledger.jsonl'), () => now.t, resolver)
    const ev = ledger.record('ollama', 'llama3.2:3b', 1_000_000, 1_000_000)
    expect(ev.costUsd).toBe(0)
    expect(ev.unpricedReason).toBe('free')
    expect(resolver).not.toHaveBeenCalled()
  })
})

// ── How the resolver GETS here (2026-08-02) ──────────────────────────────────
//
// The seam above takes an injected resolver. Where the shipped ledger's copy
// comes from used to be `require('./openrouter-service')` inside this module —
// a relative require, which electron-vite's single-file main bundle turns into
// "Cannot find module" inside app.asar: perfect in `pnpm dev`, dead in every
// installer. The edge is now inverted: a service that publishes live rates
// REGISTERS its cache-only lookup, and cost-ledger imports no service at all.
//
// This block pins the registry itself. The end-to-end wiring — that
// openrouter-service really does register, and that a ledger write really does
// price off its live catalog — is pinned in openrouterFreeSignal.test.ts, which
// is the file that can import the service.
describe('the live-rate registry — what getCostLedger() hands the ledger', () => {
  beforeEach(() => { __clearLiveRateResolversForTests() })
  afterEach(() => { __clearLiveRateResolversForTests() })

  const ledgerOnRegistry = (now: { t: number }) =>
    new CostLedger(join(dir, 'cost-ledger.jsonl'), () => now.t, resolveRegisteredLiveRates)

  it('with NOTHING registered, a write prices from the static table', () => {
    // The degraded case, and it is the pre-existing behaviour — never $0.
    const now = { t: 10 * DAY }
    const ev = ledgerOnRegistry(now).record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.priced).toBe(true)
    expect(ev.rateSource).toBe('price-table')
  })

  it('with a source registered, the same write prices from the live rate', () => {
    const now = { t: 10 * DAY }
    registerLiveRateResolver((provider, model) =>
      provider.startsWith('openrouter') && model === 'claude-sonnet-4.6'
        ? { inputPerM: 9, outputPerM: 0 }
        : null)
    const ev = ledgerOnRegistry(now).record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(9)
    expect(ev.rateSource).toBe('live-catalog')
  })

  it('REGISTRATION ORDER DOES NOT MATTER — the ledger holds a stable reference', () => {
    // The cost of inverting the edge is an ordering requirement, so prove it is
    // only about the WRITE, not about construction: a source that publishes
    // after the ledger was built is still consulted on the next record().
    const now = { t: 10 * DAY }
    const ledger = ledgerOnRegistry(now)
    expect(ledger.record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0).rateSource)
      .toBe('price-table')
    registerLiveRateResolver(() => ({ inputPerM: 9, outputPerM: 0 }))
    expect(ledger.record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0).rateSource)
      .toBe('live-catalog')
  })

  it('a resolver returning null hands off to the next one, then to the table', () => {
    const abstains = vi.fn(() => null)
    registerLiveRateResolver(abstains)
    registerLiveRateResolver((p: string) => (p === 'someone-else' ? { inputPerM: 7, outputPerM: 0 } : null))
    const now = { t: 10 * DAY }
    expect(ledgerOnRegistry(now).record('someone-else', 'claude-sonnet-4.6', 1_000_000, 0).costUsd)
      .toBeCloseTo(7)
    expect(abstains).toHaveBeenCalled()
    // Nobody claims this one → the bundled table, not $0.
    expect(ledgerOnRegistry(now).record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0).costUsd)
      .toBeCloseTo(3)
  })

  it('one THROWING publisher cannot hide a good one behind it', () => {
    registerLiveRateResolver(() => { throw new Error('catalog exploded') })
    registerLiveRateResolver(() => ({ inputPerM: 9, outputPerM: 0 }))
    const now = { t: 10 * DAY }
    const ev = ledgerOnRegistry(now).record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(9)
    expect(ev.rateSource).toBe('live-catalog')
  })

  it('registering the same function twice does not double it up', () => {
    const fn = vi.fn(() => null)
    registerLiveRateResolver(fn)
    registerLiveRateResolver(fn)
    resolveRegisteredLiveRates('openrouter-oauth', 'x')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
