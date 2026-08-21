// apps/desktop/src/pages/chat/autoModelGather.ts
//
// IMPURE half of the AUTO provider router. Gathers a snapshot of what the
// machine can run right now — already-running local engines, their hardware
// fit, and the connected free provider(s) — and hands it to the PURE
// resolveAutoModel() (src/utils/autoModel.ts) which makes the actual decision.
//
// Conservative by design:
//   • Local engines are surfaced ONLY when already running. We never START
//     llama.cpp/Ollama here — AUTO uses local inference when the user already
//     has it up, otherwise it falls through to free/paid. llama.cpp loads one
//     model at a time and needs an explicit start, so only its RUNNING model
//     qualifies; Ollama loads on demand, so any installed model with a good
//     hardware fit is answer-ready.
//   • Every window.tachi.* call is wrapped in try/catch so a missing/older
//     preload surface or a stopped sidecar degrades to "no candidates"
//     (fail-open) rather than throwing — the resolver then walks to the next
//     rung.
//   • In PRIVATE MODE the free rung is skipped entirely — the local router is
//     a localhost process that PROXIES to cloud upstreams, and "free is a
//     price, not a place". Main-process egress-policy is the second door.

import { estimateFit } from '@tachi/core/src/catalog/fit'
import type { HardwareProfile } from '@tachi/core'
import type { AutoModelInput, AutoLocalModel, AutoProvider, AutoDefault } from '../../utils/autoModel'

/** Already-running local engines + their hardware fit. Never starts anything. */
async function gatherLocalModels(): Promise<AutoLocalModel[]> {
  const out: AutoLocalModel[] = []

  let hw: HardwareProfile | null = null
  try { hw = await window.tachi.catalog.hardware() } catch { /* hardware undetectable → fit stays unknown */ }

  // ── llama.cpp: only the model that is actually loaded/running is auto-usable.
  try {
    const llama = await window.tachi.llamaCpp.status()
    if (llama && (llama.state === 'running' || llama.state === 'loading') && llama.modelId) {
      out.push({ provider: 'llama-cpp', model: llama.modelId, loaded: true })
    }
  } catch { /* engine not installed / preload missing → no llama candidate */ }

  // ── Ollama: only probe when already running (status() does not spawn it).
  try {
    const status = await window.tachi.ollama.status()
    if (status?.running) {
      const res = await window.tachi.ollama.listModels()
      if (res.ok) {
        for (const m of res.models) {
          const fit = hw && m.size > 0 ? estimateFit({ sizeBytes: m.size, hardware: hw }).verdict : undefined
          out.push({ provider: 'ollama-local', model: m.name, loaded: false, fit })
        }
      }
    }
  } catch { /* ollama down / preload missing → no ollama candidates */ }

  return out
}

/**
 * Zero-cost providers for the free rung. ARRAY ORDER IS PREFERENCE — the
 * resolver takes the first free model of the first connected provider.
 *
 * ONE MEMBER, on purpose (2026-08-01). Kilo Gateway briefly sat here as a
 * second rung member while it was a standalone provider. It is no longer a
 * provider at all: Kilo is now an UPSTREAM INSIDE the FreeLLM local router,
 * near the head of the router's own failover chain. So the free rung did not
 * lose Kilo — it stopped naming it twice, and the single entry below now fails
 * over across Kilo, OpenCode Zen and the remaining live free upstreams
 * server-side instead of the caller choosing between two doors.
 *
 * The gap that put Kilo on this rung is real and still open: the freellmapi
 * sidecar needs a Node toolchain, so a machine without one gets nothing from
 * this rung. That is a sidecar-install problem and belongs there, not in a
 * second AUTO entry that bypasses the router's ordering and its disclosure.
 *
 * Reachability probing stays REJECTED for the same reason as before: it would
 * add a network round-trip to EVERY AUTO send to guard a rare state. When the
 * router cannot serve, the send path fails after bounded retries with an
 * explicit message, never a hang.
 */
async function gatherFreeProviders(): Promise<AutoProvider[]> {
  const out: AutoProvider[] = []
  // 1. FreeLLM local router (no key, purpose-built free routing across ~15
  // free cloud providers). Its 'auto' model runs the fallback chain
  // server-side.
  try {
    const free = await window.tachi.freellmapi.listFallbackModels()
    if (free.ok && free.models.length > 0) {
      out.push({ provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] })
    }
  } catch { /* sidecar not installed / preload missing → no freellmapi rung */ }
  return out
}

/**
 * Build the resolver input. `currentDefault` is the caller's paid-default
 * fallback (the store's autoFallback). In private mode the free (cloud) rung is
 * omitted so AUTO stays on-device.
 */
export async function gatherAutoModelInputs(
  currentDefault: AutoDefault,
  opts?: { privateMode?: boolean },
): Promise<AutoModelInput> {
  const [localModels, providers] = await Promise.all([
    gatherLocalModels(),
    opts?.privateMode ? Promise.resolve<AutoProvider[]>([]) : gatherFreeProviders(),
  ])
  return { localModels, providers, currentDefault }
}
