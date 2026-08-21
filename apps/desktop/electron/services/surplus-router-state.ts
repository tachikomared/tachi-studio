// apps/desktop/electron/services/surplus-router-state.ts
//
// Runtime state for the Surplus smart router — the STATEFUL half the pure
// surplus-router.ts deliberately doesn't hold. The caller (chat-service) updates
// it on each request outcome and injects the signals back into routeSurplus():
//
//   - COOLDOWN  : a model that just errored is parked for a TTL (per-error-type,
//                 LiteLLM/ClawRouter-style) and pushed to the END of the chain.
//   - RELIABILITY: per-model success/error tally → a 0..1 score; flaky models sink
//                 in the chain (optimistic cold-start = 1.0).
//   - MOMENTUM  : the last few routed tiers per conversation (length-graded blend
//                 in the classifier for terse follow-ups).
//   - BANDIT    : per-(category:tier) Beta(α,β) outcome store — TELEMETRY/scaffold
//                 for future auto-tuning (recorded now; not yet overriding routing).
//
// Reliability + bandit persist to userData JSON; cooldown + momentum are ephemeral.

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { SurplusTier } from './surplus-router'
import { recordSample, getStabilityScoreForKey } from './util/latency-stats'

// `soft_quota` is a PREEMPTIVE park: a model whose rate-limit headers show it is
// nearly exhausted is deprioritized before it actually 429s. Shorter than the
// reactive 429 `rate_limit` cooldown — quota recovers and we don't want to bury
// a model for two minutes on a single low-headroom reading.
export type CooldownKind = 'rate_limit' | 'overload' | 'error' | 'timeout' | 'degraded' | 'soft_quota'

// Per-error-type TTL (ms). 429 parks longest; 529/503 overloads recover fast;
// the preemptive soft-quota park is the shortest (a hint, not a failure).
const COOLDOWN_MS: Record<CooldownKind, number> = {
  rate_limit: 120_000,
  overload:    15_000,
  timeout:     45_000,
  error:       30_000,
  degraded:    30_000,
  soft_quota:  20_000,
}

const cooldowns = new Map<string, number>()         // model id → expiry timestamp (ms)
const recentTiersByConv = new Map<string, SurplusTier[]>()

interface Stat { ok: number; err: number }
const reliabilityMap = new Map<string, Stat>()
const banditMap = new Map<string, { a: number; b: number }>()  // bucket → Beta(α,β)

// Routed-request tally per tier — the substrate of the "what did smart routing
// save vs always-TOP" breakdown in the Observability tab. Persisted.
export interface RouteStats { SIMPLE: number; MID: number; TOP: number }
const routeStats: RouteStats = { SIMPLE: 0, MID: 0, TOP: 0 }

// ── Persistence (reliability + bandit only) ───────────────────────────────────

let loaded = false
function statePath(): string {
  return join(app.getPath('userData'), 'surplus-router-state.json')
}
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(statePath(), 'utf-8')
    const j = JSON.parse(raw) as {
      reliability?: Record<string, Stat>
      bandit?: Record<string, { a: number; b: number }>
      routes?: Partial<RouteStats>
    }
    for (const [k, v] of Object.entries(j.reliability ?? {})) {
      if (v && typeof v.ok === 'number' && typeof v.err === 'number') reliabilityMap.set(k, { ok: v.ok, err: v.err })
    }
    for (const [k, v] of Object.entries(j.bandit ?? {})) {
      if (v && typeof v.a === 'number' && typeof v.b === 'number') banditMap.set(k, { a: v.a, b: v.b })
    }
    for (const t of ['SIMPLE', 'MID', 'TOP'] as const) {
      const n = j.routes?.[t]
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) routeStats[t] = n
    }
  } catch { /* no prior state — start fresh */ }
}
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistSoon(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const out = {
        reliability: Object.fromEntries(reliabilityMap),
        bandit: Object.fromEntries(banditMap),
        routes: routeStats,
      }
      writeFileSync(statePath(), JSON.stringify(out), 'utf-8')
    } catch { /* best-effort */ }
  }, 1500)
}

// ── Cooldown ──────────────────────────────────────────────────────────────────

/** Map an HTTP status / error to a cooldown kind. */
export function cooldownKindForStatus(status: number): CooldownKind {
  if (status === 429) return 'rate_limit'
  if (status === 503 || status === 529) return 'overload'
  if (status === 408 || status === 504) return 'timeout'
  return 'error'
}

export function markCooldown(modelId: string, kind: CooldownKind): void {
  if (!modelId) return
  cooldowns.set(modelId, Date.now() + (COOLDOWN_MS[kind] ?? COOLDOWN_MS.error))
}

/** Currently-cooling model ids (prunes expired entries). */
export function cooledDownSet(): Set<string> {
  const now = Date.now()
  for (const [id, exp] of cooldowns) if (exp <= now) cooldowns.delete(id)
  return new Set(cooldowns.keys())
}

// ── Latency stability + header-quota (router-intel) ────────────────────────────
//
// p95/jitter consistency telemetry (latency-stats ring) + rate-limit-header
// quota parsing. Stability is injected into routeSurplus as a LATE tiebreaker
// (deprioritize "spiky" models within their tier); a low quota reading parks the
// model in a SHORT preemptive cooldown so we route around it before it 429s.

// Headroom (remaining-quota %) at/below which a model gets a preemptive soft park.
const SOFT_QUOTA_PCT = 5

/** Record an observed request round-trip (ms) for a model's stability ring. */
export function recordLatencySample(modelKey: string, ms: number): void {
  if (!modelKey) return
  recordSample(modelKey, ms)
}

/** 0..100 consistency score for a model (-1 until it has any latency sample). */
export function getStabilityScore(modelKey: string): number {
  return modelKey ? getStabilityScoreForKey(modelKey) : -1
}

/**
 * Note a model's remaining-quota percentage (from rate-limit headers). A
 * near-exhausted model (pct <= SOFT_QUOTA_PCT) is parked in a short preemptive
 * `soft_quota` cooldown so the router deprioritizes it before it actually 429s.
 * Higher readings are a no-op (we don't clear other cooldowns on a quota hint).
 */
export function noteQuotaPercent(modelKey: string, pct: number | null): void {
  if (!modelKey || pct === null || !Number.isFinite(pct)) return
  if (pct <= SOFT_QUOTA_PCT) markCooldown(modelKey, 'soft_quota')
}

// ── Reliability ─────────────────────────────────────────────────────────────-─

/** 0..1 reliability for a model (optimistic 1.0 until it has ≥3 observations). */
export function reliability(modelId: string): number {
  ensureLoaded()
  const s = reliabilityMap.get(modelId)
  if (!s) return 1
  const total = s.ok + s.err
  if (total < 3) return 1
  return s.ok / total
}

// ── Outcome recording (reliability + bandit) ───────────────────────────────────

/** Record a request outcome for a model (and optionally its routing bucket). */
export function recordOutcome(modelId: string, ok: boolean, bucket?: string): void {
  ensureLoaded()
  if (modelId) {
    const s = reliabilityMap.get(modelId) ?? { ok: 0, err: 0 }
    if (ok) s.ok++; else s.err++
    reliabilityMap.set(modelId, s)
    if (ok) cooldowns.delete(modelId)  // a success clears any cooldown
  }
  if (bucket) {
    const b = banditMap.get(bucket) ?? { a: 1, b: 1 }
    if (ok) b.a++; else b.b++
    banditMap.set(bucket, b)
    // Per-(bucket|model) ARM — the granularity the router's bandit re-rank
    // needs (the bucket-level entry above stays for dashboard telemetry).
    if (modelId) {
      const armKey = `${bucket}|${modelId}`
      const arm = banditMap.get(armKey) ?? { a: 1, b: 1 }
      if (ok) arm.a++; else arm.b++
      banditMap.set(armKey, arm)
    }
  }
  persistSoon()
}

/**
 * Beta(α,β) arm for a (bucket, modelId) pair — undefined until the pair has at
 * least one recorded outcome. Injected into routeSurplus (opts.banditArm) for
 * the C1 bandit re-rank; staying a lookup keeps the router itself pure.
 */
export function banditArm(bucket: string, modelId: string): { a: number; b: number } | undefined {
  ensureLoaded()
  return banditMap.get(`${bucket}|${modelId}`)
}

/** Count one routed request at its decided tier (savings breakdown substrate). */
export function recordRouteStat(tier: SurplusTier): void {
  ensureLoaded()
  routeStats[tier] = (routeStats[tier] ?? 0) + 1
  persistSoon()
}

/** Per-tier routed-request tally (copy). */
export function getRouteStats(): RouteStats {
  ensureLoaded()
  return { ...routeStats }
}

/** Bandit stats snapshot (telemetry / future tuning). */
export function banditStats(): Record<string, { a: number; b: number; mean: number }> {
  ensureLoaded()
  const out: Record<string, { a: number; b: number; mean: number }> = {}
  for (const [k, v] of banditMap) out[k] = { a: v.a, b: v.b, mean: v.a / (v.a + v.b) }
  return out
}

// ── Momentum (recent tiers per conversation) ───────────────────────────────────

export function pushTier(conversationId: string, tier: SurplusTier): void {
  if (!conversationId) return
  const arr = recentTiersByConv.get(conversationId) ?? []
  arr.push(tier)
  while (arr.length > 5) arr.shift()
  recentTiersByConv.set(conversationId, arr)
}

export function recentTiers(conversationId: string): SurplusTier[] {
  return conversationId ? (recentTiersByConv.get(conversationId) ?? []) : []
}
