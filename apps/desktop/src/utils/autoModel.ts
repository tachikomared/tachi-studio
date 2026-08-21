// apps/desktop/src/utils/autoModel.ts
//
// AUTO provider router — the PURE decision core. Given a snapshot of what the
// machine can run right now, it picks a provider+model by walking a fixed
// preference LADDER:
//
//   1. local-fit   — a truly-local model (llama.cpp / Ollama) that is loaded or
//                    fits in the detected hardware → answer on-device (free,
//                    private, no network).
//   2. free        — a connected provider offering a genuinely free model
//                    (e.g. the FreeLLM local router / an OpenRouter `:free`
//                    tier) → answer at zero token cost.
//   3. paid-default— neither of the above is available → fall back to the
//                    caller's `currentDefault` (whatever concrete provider the
//                    chat would otherwise have used).
//
// CONTRACT
//   • PURE + DETERMINISTIC: no Date/Math.random/IO, no reliance on object-key
//     iteration order. The same input always yields the same output. Ties are
//     broken by INPUT ARRAY ORDER (the caller decides preference by ordering).
//   • FAIL-OPEN: any missing / empty / malformed slice of the input simply
//     skips that rung. If the ladder produces nothing, we return
//     `currentDefault`. If even that is absent we return a documented constant
//     so the function is total and never throws.
//
// The IMPURE gathering (calling window.tachi.* for llama.cpp/Ollama status,
// hardware fit, the FreeLLM catalog, stored keys) lives in the caller
// (pages/chat) — this module only reasons over the gathered snapshot, which is
// what makes it trivially unit-testable.

import type { FitVerdict } from '@tachi/core'

export type AutoReason = 'local-fit' | 'free' | 'paid-default'

/** A local (on-device) model candidate for the local-fit rung. */
export interface AutoLocalModel {
  /** Provider id that serves it, e.g. 'llama-cpp' | 'ollama-local'. */
  provider: string
  /** Model id to send. */
  model: string
  /**
   * The engine currently has it loaded/running. A resident model is usable
   * immediately (zero load cost) and definitionally fits, so it qualifies
   * regardless of the fit verdict.
   */
  loaded?: boolean
  /**
   * Hardware fit verdict from the catalog heuristic (estimateFit). Undefined =
   * unknown/unmeasured. 'too-big' never qualifies unless the model is loaded.
   */
  fit?: FitVerdict
}

/** One model offered by a connected provider, tagged free vs paid. */
export interface AutoProviderModel {
  model: string
  /** Genuinely free to run (no per-token cost). */
  free: boolean
}

/** A connected provider and the models it currently offers. */
export interface AutoProvider {
  /** Provider id, e.g. 'freellmapi-local'. */
  provider: string
  /**
   * The provider can actually be called right now (credential present / sidecar
   * up). Disconnected providers are ignored by the free rung.
   */
  connected: boolean
  models: AutoProviderModel[]
}

/** The last-resort default: returned whenever the ladder produces nothing. */
export interface AutoDefault {
  provider: string
  model: string
}

export interface AutoModelInput {
  /** Local-engine candidates for the local-fit rung (order = preference on ties). */
  localModels?: AutoLocalModel[] | null
  /** Connected providers for the free rung (order = preference on ties). */
  providers?: AutoProvider[] | null
  /** Fallback used when neither local nor free applies. */
  currentDefault?: AutoDefault | null
}

export interface AutoModelResult {
  provider: string
  model: string
  reason: AutoReason
}

/**
 * Ultimate fallback when the caller supplies no `currentDefault` at all. Mirrors
 * the app's baseline chat default (freellmapi-local · auto) so the function is
 * total. In practice the caller always passes a real `currentDefault`.
 */
export const AUTO_HARD_FALLBACK: AutoDefault = { provider: 'freellmapi-local', model: 'auto' }

/** Higher = better hardware fit. Unknown/absent verdicts score 0. */
const FIT_RANK: Record<FitVerdict, number> = {
  'gpu': 3,
  'cpu': 2,
  'tight': 1,
  'too-big': 0,
}

/**
 * True when a local candidate can serve a turn: it is resident (loaded), or its
 * measured fit is anything other than 'too-big'. Unmeasured + unloaded models do
 * NOT qualify (fail-open: we don't gamble on unknown hardware fit).
 */
function localQualifies(m: AutoLocalModel): boolean {
  if (m.loaded === true) return true
  return m.fit === 'gpu' || m.fit === 'cpu' || m.fit === 'tight'
}

/**
 * Preference score for a qualifying local model. A loaded/resident model always
 * outranks a merely-fitting one (+100); among equals, a better hardware verdict
 * wins. Ties (identical score) are left to input order by the caller of reduce.
 */
function localScore(m: AutoLocalModel): number {
  const loadedBonus = m.loaded === true ? 100 : 0
  const fitRank = m.fit ? FIT_RANK[m.fit] : 0
  return loadedBonus + fitRank
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Walk the AUTO ladder (local-fit → free → paid-default) over a gathered
 * snapshot and return the concrete provider+model to send. Deterministic and
 * fail-open — see the file header for the full contract.
 */
export function resolveAutoModel(input: AutoModelInput | null | undefined): AutoModelResult {
  const currentDefault =
    input && input.currentDefault && isNonEmptyString(input.currentDefault.provider) && isNonEmptyString(input.currentDefault.model)
      ? input.currentDefault
      : null
  const fallback: AutoModelResult = {
    provider: currentDefault?.provider ?? AUTO_HARD_FALLBACK.provider,
    model: currentDefault?.model ?? AUTO_HARD_FALLBACK.model,
    reason: 'paid-default',
  }

  if (!input) return fallback

  // ── Rung 1: local-fit ─────────────────────────────────────────────────────
  const locals = Array.isArray(input.localModels) ? input.localModels : []
  let best: AutoLocalModel | null = null
  let bestScore = -1
  for (const m of locals) {
    if (!m || !isNonEmptyString(m.provider) || !isNonEmptyString(m.model)) continue
    if (!localQualifies(m)) continue
    const score = localScore(m)
    // Strictly-greater replacement keeps the FIRST candidate on ties → the
    // caller's array order is the deterministic tie-breaker.
    if (score > bestScore) {
      best = m
      bestScore = score
    }
  }
  if (best) {
    return { provider: best.provider, model: best.model, reason: 'local-fit' }
  }

  // ── Rung 2: free ──────────────────────────────────────────────────────────
  const providers = Array.isArray(input.providers) ? input.providers : []
  for (const p of providers) {
    if (!p || p.connected !== true || !isNonEmptyString(p.provider) || !Array.isArray(p.models)) continue
    for (const pm of p.models) {
      if (pm && pm.free === true && isNonEmptyString(pm.model)) {
        return { provider: p.provider, model: pm.model, reason: 'free' }
      }
    }
  }

  // ── Rung 3: paid-default (fail-open) ──────────────────────────────────────
  return fallback
}
