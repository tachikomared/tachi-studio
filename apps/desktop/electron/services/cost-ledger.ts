// apps/desktop/electron/services/cost-ledger.ts
//
// Persistent per-provider token/cost ledger (STEAL 2026-06-12 cluster A,
// strategic #1; Pulse internal/ai/cost/store.go). Closes the audit gap
// "agents can spend unbounded $ via cloud LLM calls with no cap":
//   - every usage event (chat-service chunk, TACHI loop finish) is appended
//     to ${userData}/cost-ledger.jsonl
//   - sendChatMessage / runTachiSession consult spendUsdSince() against the
//     llmBudgetUsd30d setting BEFORE starting a new request
//
// The class is electron-free (path injected) for vitest; getCostLedger() is
// the electron-coupled singleton accessor (lazy require, mirroring the
// dynamic-import convention in tachi/loop.ts).

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { costUsd, costUsdFromRates, isVerifiedFreeModel, type ModelRates } from './cost-pricing'
import { PROVIDER_LIST, type TaskType } from '@tachi/core'

/**
 * Supplies the rate a provider is charging RIGHT NOW, when one is known.
 * Injected (rather than imported) so CostLedger stays electron-free for vitest,
 * and so this module never acquires a network dependency: implementations must
 * be cache-only and synchronous — see openrouter-service.ts::liveOpenrouterRates.
 * Publishers register through registerLiveRateResolver() at the bottom of this
 * file; the contract they must honour is written there.
 */
export type LiveRateResolver = (provider: string, model: string) => ModelRates | null

export interface UsageEvent {
  ts: number
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  /** false = model not in the price table; tokens recorded, $ counted as 0. */
  priced: boolean
  /**
   * Why costUsd is 0 when priced=false. Splits the two very different cases the
   * boolean alone conflated (added 2026-08-01):
   *   'free'    — known $0: a local/keyless-free provider, or a model verified
   *               free against its provider's catalog. No money moved.
   *   'unknown' — no price is available for this model. Money MAY have moved,
   *               so the 30-day spend cap must NOT read it as free.
   * Absent on priced events, and on events written before 2026-08-01 — those
   * legacy events keep the old no-charge behaviour and age out of the 30-day
   * window on their own.
   */
  unpricedReason?: 'free' | 'unknown'
  /**
   * WHERE the rate behind `costUsd` came from (added 2026-08-02). Absent on
   * unpriced events and on events written before that date.
   *   'live-catalog' — the provider's own published rate, read at the moment
   *                    this event was recorded.
   *   'price-table'  — the bundled dated snapshot (packages/core/src/pricing.ts).
   *
   * Recorded so a stored cost can be audited back to its source. It is NOT an
   * instruction to re-price: `costUsd` above is final, stamped at record time
   * from the rate then in force. Nothing in this file recomputes it.
   */
  rateSource?: 'live-catalog' | 'price-table'
  /** Coarse task category (zero-LLM classifier over the message/task). Optional — old events lack it. */
  taskType?: TaskType
  /**
   * Provider prompt-cache HITS — input tokens the gateway served from its cache
   * (SUBSET of promptTokens, not additional). Omitted when the provider reported
   * nothing; a provider-reported 0 is recorded as 0. Never fabricated.
   * (CACHE-ALIGN 2026-07-21.)
   *
   * Since 2026-08-01 this is also PRICED: costUsd re-prices this slice at the
   * model's cacheReadPerM (default 0.1× input) instead of full input rate.
   */
  cachedTokens?: number
}

export interface ProviderCostSummary {
  usd: number
  promptTokens: number
  completionTokens: number
  events: number
  unpricedEvents: number
  /** Σ provider prompt-cache hits (cached input tokens) over the window. */
  cachedTokens: number
}

export interface TaskTypeCostSummary {
  usd: number
  promptTokens: number
  completionTokens: number
  events: number
}

export interface CostSummary {
  windowDays: number
  /**
   * KNOWN spend only — Σ recorded costUsd. Deliberately excludes the spend-cap
   * estimate for unknown-price usage (see spendBreakdownSince), so the dashboard
   * never displays an invented number as money. `unpricedEvents` is how the
   * unknown portion surfaces here.
   */
  totalUsd: number
  byProvider: Record<string, ProviderCostSummary>
  /** Spend split by coarse task category. Events with no taskType land under 'other'. */
  byTaskType: Record<string, TaskTypeCostSummary>
}

const DAY_MS = 86_400_000
/** Events older than this are dropped at load time (file rewritten). */
const RETENTION_DAYS = 90

// Providers that run on the user's own hardware or a keyless free tier — they
// cost $0 regardless of the model NAME. Without this guard, the expanded price
// table (STEAL 2026-07-09) would mis-price a LOCAL `llama3.2` or a keyless
// free-router `deepseek` at cloud rates. Recorded as priced:false (no metered
// cloud spend applies) with cost 0.
//
// DERIVED, not hand-maintained (2026-08-01): "does it cost anything" is a
// registry fact (`billing`), so a provider added there is billed correctly here
// without anyone remembering this file. The literals below are LEGACY ledger
// ids only — short forms that were written into cost-ledger.jsonl before the
// canonical vocabulary landed, and which no registry entry carries.
const LOCAL_FREE_PROVIDERS = new Set<string>([
  ...PROVIDER_LIST.filter(p => p.billing === 'free').map(p => p.id),
  'ollama', 'llama-cpp-local',
])

/**
 * Conservative placeholder $/M rate charged to UNKNOWN-price usage when
 * evaluating a spend cap (2026-08-01).
 *
 * The cap previously summed `costUsd`, which is 0 for anything the price table
 * misses — so an unpriced cloud call (an unlisted gateway model, or a routing
 * id like OpenGateway's `auto`, whose own catalog says it is "billed at the
 * serving model's rate") consumed real money while reading to the cap as free.
 * Between over-counting and under-counting against a SPEND CAP, under-counting
 * is the dangerous direction, so unknown usage is now charged something.
 *
 * This IS an estimate and is deliberately labelled as one. Its only job is to
 * not be zero. The figure is the cheapest general-purpose cloud tier the price
 * table ships (gpt-5-mini class), chosen because the commonest unknown in
 * practice is a cheap-routing `auto`. It is used ONLY for the cap comparison —
 * it is never written to the ledger and never shown as spend by summary().
 */
export const UNKNOWN_PRICE_ESTIMATE = { inputPerM: 0.25, outputPerM: 2 } as const

export interface SpendBreakdown {
  /** Real, known spend — the only figure safe to display as money. */
  pricedUsd: number
  /** UNKNOWN_PRICE_ESTIMATE applied to unpriced-unknown usage. An estimate. */
  estimatedUnknownUsd: number
  /** How many events contributed to estimatedUnknownUsd. */
  unknownEvents: number
  /** pricedUsd + estimatedUnknownUsd — what the spend cap compares against. */
  totalUsd: number
}

export class CostLedger {
  private events: UsageEvent[] = []
  private loaded = false

  constructor(
    private filePath: string,
    private now: () => number = Date.now,
    /**
     * Optional live-rate source, consulted ONCE per event at record() time.
     * Omitted in tests and wherever no provider publishes a live rate, in which
     * case pricing falls back to the bundled table exactly as before.
     */
    private liveRates: LiveRateResolver | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    const cutoff = this.now() - RETENTION_DAYS * DAY_MS
    let dropped = 0
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as UsageEvent
          if (typeof ev.ts === 'number' && ev.ts >= cutoff) this.events.push(ev)
          else dropped++
        } catch { dropped++ }
      }
      if (dropped > 0) {
        // Compact: rewrite without expired/corrupt lines.
        writeFileSync(this.filePath, this.events.map(e => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : ''), 'utf8')
      }
    } catch (e) {
      // unreadable ledger = start fresh in memory; appends still work, but surface
      // it so a corrupt/locked ledger isn't an invisible spend-tracking gap.
      console.warn('[cost-ledger] could not read/compact the ledger (starting fresh in memory):', (e as Error).message)
    }
  }

  record(provider: string, model: string, promptTokens: number, completionTokens: number, taskType?: TaskType, cachedTokens?: number): UsageEvent {
    this.load()
    // Local / keyless-free providers never incur cloud spend, whatever the
    // model name resolves to in the price table.
    //
    // A model VERIFIED free against its provider's catalog (pricing 0/0 — e.g.
    // OpenRouter's live-priced free rows, mirrored into the dated
    // VERIFIED_FREE_MODELS table) is the same known-$0 case at model granularity:
    // it gets unpricedReason 'free' rather than a bare zero-priced event, which
    // is what the 'free' reason's own doc promised ("or a model verified free
    // against its provider's catalog"). A PAID model on the same provider is
    // untouched — it still prices normally below. Derived from catalog data,
    // never from a `:free` id suffix (see pricing.ts).
    const localFree = LOCAL_FREE_PROVIDERS.has(provider) || isVerifiedFreeModel(model, this.now())
    // cachedTokens are prompt-cache HITS and are a SUBSET of promptTokens — the
    // extractors that produce them prove it: ai@7's inputTokenDetails splits
    // inputTokens into noCacheTokens + cacheReadTokens, and OpenAI's
    // prompt_tokens_details.cached_tokens is a breakdown of prompt_tokens (see
    // cache-stats.ts::extractCachedInputTokens and cacheHitRatio, which divides
    // cached BY total input). costUsd therefore RE-PRICES that slice at the
    // model's cache-read rate instead of adding it — passing it here is a
    // discount, never an extra charge. Before 2026-08-01 this argument was
    // dropped on the floor and every cache hit billed at full input rate.
    //
    // A LIVE RATE BEATS A STATIC ONE — BUT ONLY NOW, AND ONLY ONCE.
    // The bundled table is a dated snapshot that drifts (the 2026-08-02 audit
    // found rows wrong in both directions, including gpt-5.5 under-priced ~4×,
    // which let real spend past the cap). Where a provider publishes what it is
    // charging today, that number is simply better.
    //
    // The correctness rule for a LEDGER, though, is that a run is priced at the
    // rate in force WHEN IT RAN. So the live rate is read exactly here, at the
    // moment of the event, and the resulting dollar figure is written to the
    // event and to disk. Nothing recomputes it afterwards — summary() and
    // spendBreakdownSince() only ever SUM the stored `costUsd`, so a catalog
    // that changes next week cannot retro-reprice this week's usage, and a
    // catalog that is unreachable cannot erase it.
    //
    // Fail-soft in both directions: a resolver that throws, or returns a rate
    // costUsdFromRates rejects as nonsensical, falls straight back to the static
    // table. A live rate can improve accuracy here; it can never be the reason a
    // usage event goes unpriced.
    let live: ModelRates | null = null
    if (!localFree && this.liveRates) {
      try { live = this.liveRates(provider, model) } catch { live = null }
    }
    const livePriced = live ? costUsdFromRates(live, promptTokens, completionTokens, cachedTokens ?? 0) : null
    const priced = localFree
      ? null
      : livePriced ?? costUsd(model, promptTokens, completionTokens, cachedTokens ?? 0)
    const ev: UsageEvent = {
      ts: this.now(),
      provider, model, promptTokens, completionTokens,
      costUsd: priced ?? 0,
      priced: priced !== null,
      // Provenance for the stored number — audit only, never re-priced.
      ...(priced !== null ? { rateSource: (livePriced !== null ? 'live-catalog' : 'price-table') as 'live-catalog' | 'price-table' } : {}),
      // Record WHY it was unpriced. 'unknown' is what stops the spend cap from
      // reading an unpriced cloud call as a free one.
      ...(priced === null ? { unpricedReason: (localFree ? 'free' : 'unknown') as 'free' | 'unknown' } : {}),
      ...(taskType ? { taskType } : {}),
      // Additive: only record a cache figure the provider actually reported
      // (undefined omits the field entirely; a reported 0 is kept as 0).
      ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
    }
    this.events.push(ev)
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, JSON.stringify(ev) + '\n', 'utf8')
    } catch (e) {
      // persistence best-effort; the in-memory state still enforces the cap THIS
      // run, but a write failure means spend won't survive a restart — surface it
      // rather than silently under-counting the 30-day cap.
      console.warn('[cost-ledger] failed to persist usage event (spend cap may under-count after restart):', (e as Error).message)
    }
    return ev
  }

  /**
   * Known spend vs estimated-unknown spend for events with ts >= sinceMs.
   * Only events explicitly tagged unpricedReason:'unknown' are estimated —
   * known-free usage (local providers, verified-free models) and pre-2026-08-01
   * legacy events without the tag contribute nothing.
   */
  spendBreakdownSince(sinceMs: number): SpendBreakdown {
    this.load()
    let pricedUsd = 0
    let estimatedUnknownUsd = 0
    let unknownEvents = 0
    for (const e of this.events) {
      if (e.ts < sinceMs) continue
      pricedUsd += e.costUsd
      if (!e.priced && e.unpricedReason === 'unknown') {
        // No cache discount here on purpose: an unknown model has no known
        // cache-read rate either, and over-counting is the safe direction for a
        // cap. Priced events DO get the discount (see record()).
        estimatedUnknownUsd +=
          (e.promptTokens / 1_000_000) * UNKNOWN_PRICE_ESTIMATE.inputPerM +
          (e.completionTokens / 1_000_000) * UNKNOWN_PRICE_ESTIMATE.outputPerM
        unknownEvents++
      }
    }
    return { pricedUsd, estimatedUnknownUsd, unknownEvents, totalUsd: pricedUsd + estimatedUnknownUsd }
  }

  /**
   * What the 30-day spend cap compares against: known spend PLUS a conservative
   * estimate for unknown-price usage (see UNKNOWN_PRICE_ESTIMATE). This can read
   * higher than summary().totalUsd, which stays strictly honest for display.
   */
  spendUsdSince(sinceMs: number): number {
    return this.spendBreakdownSince(sinceMs).totalUsd
  }

  summary(windowDays = 30): CostSummary {
    this.load()
    const since = this.now() - windowDays * DAY_MS
    const byProvider: Record<string, ProviderCostSummary> = {}
    const byTaskType: Record<string, TaskTypeCostSummary> = {}
    let totalUsd = 0
    for (const e of this.events) {
      if (e.ts < since) continue
      const p = byProvider[e.provider] ?? (byProvider[e.provider] = { usd: 0, promptTokens: 0, completionTokens: 0, events: 0, unpricedEvents: 0, cachedTokens: 0 })
      p.usd += e.costUsd
      p.promptTokens += e.promptTokens
      p.completionTokens += e.completionTokens
      p.events++
      if (!e.priced) p.unpricedEvents++
      if (typeof e.cachedTokens === 'number') p.cachedTokens += e.cachedTokens
      // by task type — events without a taskType bucket under 'other'.
      const tt = e.taskType ?? 'other'
      const t = byTaskType[tt] ?? (byTaskType[tt] = { usd: 0, promptTokens: 0, completionTokens: 0, events: 0 })
      t.usd += e.costUsd
      t.promptTokens += e.promptTokens
      t.completionTokens += e.completionTokens
      t.events++
      totalUsd += e.costUsd
    }
    return { windowDays, totalUsd, byProvider, byTaskType }
  }
}

let singleton: CostLedger | null = null

// ── The live-rate wiring: REGISTRATION, not lookup ───────────────────────────
//
// This was `require('./openrouter-service')` inside the resolver, and that was
// a PACKAGED-BUILD BUG, not a style question. electron-vite bundles all of
// electron/ into one out/main/index.js, so './openrouter-service' does not
// exist at runtime inside app.asar: the require throws "Cannot find module" in
// every shipped installer while working perfectly in `pnpm dev`. Same shape as
// the lazy relative require that once silently killed chat in every installer
// (noRuntimeRelativeRequire.test.ts is the net over the whole class).
//
// The obvious repair — a top-level `import` — fixes the build and breaks the
// tests: openrouter-service imports the keychain, which imports electron, so
// every vitest run of THIS file would need an electron mock, and the ledger
// would acquire the catalog service as a permanent import-graph dependency.
//
// So the edge is REMOVED rather than re-routed: the arrow now points the other
// way. cost-ledger knows nothing about any provider's catalog; a service that
// publishes live rates hands its resolver over at its own init
// (openrouter-service.ts, bottom of file). The class seam this feeds — the
// injected `liveRates` constructor argument — already existed; nothing new was
// invented, it just gets its value from a registration instead of a require.
//
// WHAT IT COSTS: an init-ordering requirement. A ledger write that lands before
// the publishing service's module has loaded sees no resolver and prices from
// the bundled table. That is (a) exactly what the lazy require did too — an
// unloaded catalog has an empty cache, so liveOpenrouterRates returned null —
// and (b) moot in main, where main.ts statically imports openrouter.ipc →
// openrouter-service during bundle init, long before a chat can record an
// event. The degraded case is the pre-existing behaviour, never $0.

const liveRateResolvers: LiveRateResolver[] = []

/**
 * Publish a live-rate source to the ledger. Called by whichever service OWNS a
 * provider catalog, from its own module init.
 *
 * CONTRACT for an implementation, and it is not negotiable — this runs inside a
 * ledger write, which sits on the chat hot path and IS the spend cap's data:
 *   · CACHE-ONLY and SYNCHRONOUS. Never fetch. A slow or down catalog must not
 *     be able to stall or fail a ledger write.
 *   · Return null for any (provider, model) you do not own; the next registered
 *     resolver is then asked, and the bundled table answers if none claim it.
 *   · Throwing is survivable but pointless: record() and the walk below both
 *     fail soft, so a throw degrades to the static table exactly like a null.
 */
export function registerLiveRateResolver(resolve: LiveRateResolver): void {
  if (!liveRateResolvers.includes(resolve)) liveRateResolvers.push(resolve)
}

/** TEST-ONLY: drop every registered resolver (module state outlives a test). */
export function __clearLiveRateResolversForTests(): void { liveRateResolvers.length = 0 }

/**
 * The resolver handed to the singleton: the first registered source that claims
 * this (provider, model). A stable function reference, so registration order
 * relative to the ledger's construction does not matter — a service that loads
 * after the singleton was built is still consulted on the next write.
 *
 * Exported so a test can prove the WIRING (rates flow when the publishing
 * service is loaded, static table when it is not), not just the class seam.
 */
export function resolveRegisteredLiveRates(provider: string, model: string): ModelRates | null {
  for (const resolve of liveRateResolvers) {
    let hit: ModelRates | null
    // Per-resolver, so one bad publisher cannot hide a good one behind it.
    try { hit = resolve(provider, model) } catch { hit = null }
    if (hit) return hit
  }
  return null
}

/** Electron-coupled accessor — lazy so vitest can import this module. */
export function getCostLedger(): CostLedger {
  if (!singleton) {
    // Bare specifiers only: 'electron' and 'node:path' are externals that
    // resolve at runtime. A RELATIVE require here would not survive bundling —
    // see the note above.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path') as typeof import('node:path')
    singleton = new CostLedger(join(app.getPath('userData'), 'cost-ledger.jsonl'), Date.now, resolveRegisteredLiveRates)
  }
  return singleton
}
