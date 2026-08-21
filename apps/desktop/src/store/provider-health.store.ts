// apps/desktop/src/store/provider-health.store.ts
//
// BACKGROUND PROVIDER HEALTH CHECK + STATUS BADGES.
//
// A tiny Zustand store that tracks per-provider liveness. On mount (and on a
// 5-minute interval) it cheaply validates each provider that exposes a cheap
// "list" bridge in the preload — a successful list call (ok && non-empty) =
// 'ok', an empty/failed/throwing call = 'error'. Providers with no cheap probe
// stay 'unknown' (we never want a red dot for something we can't actually
// measure).
//
// HARD RESILIENCE CONTRACT:
//   - Never throws. Every probe is wrapped; a missing bridge (preload not ready,
//     test env) resolves to 'unknown', never 'error'.
//   - Never blocks render. Probes are fire-and-forget; the store updates
//     reactively as each settles.
//   - Adds NO new IPC. Uses only existing window.tachi bridges.

import { create } from 'zustand'

export type ProviderHealth = 'ok' | 'error' | 'checking' | 'unknown'

/** How often the background sweep re-runs. */
export const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * IDLE HONESTY (lane V): a sweep is five probes, two of them CLOUD round-trips
 * (bankr, surplus). Firing them at a window nobody is looking at buys a badge
 * colour that cannot be read and keeps the radio/CPU awake on a minimised or
 * fully occluded app. Electron marks the page hidden on minimise and on
 * occlusion, so `document.hidden` is the honest signal here.
 *
 * Skipping is safe because it is never the LAST word: `onVisible` below runs a
 * catch-up sweep the moment the window comes back, and only when the readings
 * are actually stale — so coming back to a window shows fresh badges without a
 * redundant sweep on every alt-tab.
 */
export const STALE_AFTER_MS = HEALTH_CHECK_INTERVAL_MS

/** True when the document is currently hidden (minimised / occluded / tabbed away). */
function isHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

// ── Per-provider cheap probes ───────────────────────────────────────────────
// Each probe returns true (healthy), false (configured but failing), or
// null (cannot determine cheaply → leave 'unknown'). A probe MUST NOT throw —
// callers also defensively catch, but probes own their own try/catch so a
// thrown bridge maps to 'error' (reachable but broken) vs. an absent bridge
// (null → 'unknown').

type ProbeResult = boolean | null

function bridge(): any {
  try {
    return (window as unknown as { tachi?: any }).tachi ?? null
  } catch {
    return null
  }
}

async function probeBankr(): Promise<ProbeResult> {
  const t = bridge()
  if (!t?.bankr?.listModels) return null
  const res = await t.bankr.listModels()
  return !!(res?.ok && Array.isArray(res.models) && res.models.length > 0)
}

async function probeSurplus(): Promise<ProbeResult> {
  const t = bridge()
  if (!t?.surplus?.listModels) return null
  const res = await t.surplus.listModels()
  return !!(res?.ok && Array.isArray(res.models) && res.models.length > 0)
}

async function probeFreellmapi(): Promise<ProbeResult> {
  const t = bridge()
  if (!t?.freellmapi?.listFallbackModels) return null
  const res = await t.freellmapi.listFallbackModels()
  return !!(res?.ok && Array.isArray(res.models) && res.models.length > 0)
}

async function probeOllama(): Promise<ProbeResult> {
  const t = bridge()
  if (!t?.ollama?.listModels) return null
  const res = await t.ollama.listModels()
  return !!(res?.ok && Array.isArray(res.models) && res.models.length > 0)
}

async function probeLlamaCpp(): Promise<ProbeResult> {
  const t = bridge()
  if (!t?.llamaCpp?.status) return null
  const res = await t.llamaCpp.status()
  // 'running' = clearly ok; otherwise healthy iff the binary + a model are
  // installed (ready to start). Not installed → configured-but-unusable.
  if (res?.state === 'running') return true
  return !!(res?.installed && Array.isArray(res.downloadedModels) && res.downloadedModels.length > 0)
}

/**
 * Provider id → cheap probe. Provider ids match PROVIDER_OPTIONS in
 * ProviderPicker.tsx. Ids absent from this map have no cheap probe and remain
 * 'unknown' forever (intentional — never show red for the unmeasurable).
 */
const PROBES: Record<string, () => Promise<ProbeResult>> = {
  'bankr-gateway':     probeBankr,
  'surplus':           probeSurplus,
  'freellmapi-local':  probeFreellmapi,
  'ollama-local':      probeOllama,
  'llama-cpp':         probeLlamaCpp,
}

/** True if a provider id has a cheap probe (drives badge visibility). */
export function isProbeable(providerId: string): boolean {
  return providerId in PROBES
}

// ── Store ───────────────────────────────────────────────────────────────────

interface ProviderHealthStore {
  /** providerId → health. Missing key === 'unknown'. */
  health: Record<string, ProviderHealth>
  /** epoch ms of the last completed sweep (0 = never). */
  lastChecked: number
  /** Read a single provider's health (defaults to 'unknown'). */
  get: (providerId: string) => ProviderHealth
  /** Probe one provider now. Resilient: never throws. */
  checkOne: (providerId: string) => Promise<void>
  /** Probe every probeable provider now. Resilient: never throws. */
  checkAll: () => Promise<void>
  /**
   * Start the background sweep (immediate + every HEAD_CHECK_INTERVAL_MS).
   * Idempotent — repeated calls reuse the single live interval and return the
   * same disposer. Call the returned fn to stop. Safe to call from many
   * mounted components.
   */
  start: () => () => void
}

// Module-scoped interval handle + refcount so multiple ProviderPicker mounts
// share ONE timer and the last unmount tears it down.
let intervalHandle: ReturnType<typeof setInterval> | null = null
let starters = 0
// Paired with the interval: the same refcount owns the visibility listener, so
// the last unmount leaves nothing attached to document.
let visibilityListener: (() => void) | null = null

export const useProviderHealthStore = create<ProviderHealthStore>((set, getState) => ({
  health: {},
  lastChecked: 0,

  get(providerId) {
    return getState().health[providerId] ?? 'unknown'
  },

  async checkOne(providerId) {
    const probe = PROBES[providerId]
    if (!probe) {
      // No cheap probe → stays 'unknown'. Don't even mark 'checking'.
      return
    }
    set((s) => ({ health: { ...s.health, [providerId]: 'checking' } }))
    let next: ProviderHealth
    try {
      const r = await probe()
      next = r === null ? 'unknown' : r ? 'ok' : 'error'
    } catch {
      // Bridge present but threw → reachable-but-broken.
      next = 'error'
    }
    set((s) => ({ health: { ...s.health, [providerId]: next } }))
  },

  async checkAll() {
    const ids = Object.keys(PROBES)
    // Run in parallel; each checkOne owns its own try/catch so Promise.all
    // can never reject.
    await Promise.all(ids.map((id) => getState().checkOne(id)))
    set({ lastChecked: Date.now() })
  },

  start() {
    starters += 1
    // Kick an immediate sweep (fire-and-forget — never blocks the caller).
    void getState().checkAll()
    if (intervalHandle === null) {
      intervalHandle = setInterval(() => {
        // Idle honesty: a hidden window cannot show a badge, so it does not pay
        // for one. onVisible catches up.
        if (isHidden()) return
        void getState().checkAll()
      }, HEALTH_CHECK_INTERVAL_MS)
    }
    if (visibilityListener === null && typeof document !== 'undefined' && document.addEventListener) {
      visibilityListener = () => {
        if (isHidden()) return
        // Only sweep if the readings actually went stale while we were away —
        // an alt-tab a second after a sweep must not re-probe five providers.
        if (Date.now() - getState().lastChecked < STALE_AFTER_MS) return
        void getState().checkAll()
      }
      document.addEventListener('visibilitychange', visibilityListener)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      starters = Math.max(0, starters - 1)
      if (starters === 0) {
        if (intervalHandle !== null) {
          clearInterval(intervalHandle)
          intervalHandle = null
        }
        if (visibilityListener !== null) {
          try { document.removeEventListener('visibilitychange', visibilityListener) } catch { /* no document */ }
          visibilityListener = null
        }
      }
    }
  },
}))
