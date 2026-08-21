// apps/desktop/src/pages/nodes/useProviderModels.ts
//
// One hook, ALL graph providers → a real model dropdown (never hand-typed).
// Given a provider id (legacy or canonical), it returns the available models —
// live-fetched per provider with a curated static fallback so the dropdown is
// never empty. Shared by the canvas Prompt node AND the Configure side panel so
// model selection is identical everywhere.
//
// Live sources (same IPC the chat / ProviderNode pickers use):
//   bankr-gateway    → window.tachi.bankr.listModels
//   surplus          → window.tachi.surplus.listModels
//   venice           → window.tachi.venice.listModels   (carries vision + caps)
//   freellmapi-local → window.tachi.freellmapi.listFallbackModels
//   ollama-local     → window.tachi.ollama.listModels
//   llama-cpp        → window.tachi.llamaCpp.status().downloadedModels
//   opengateway/…    → static fallback only (no live catalog endpoint)
import { useEffect, useState } from 'react'
import { canonicalProviderId } from './providerCompat'
// Subpath import keeps the Node-only @tachi/core barrel out of the renderer bundle.
import { isVisionModel } from '@tachi/core/src/providers/vision'

export interface ProviderModelOption {
  id: string
  label: string
  /** Venice capability tags (vision · reasoning · tools · web · code). */
  caps?: string[]
  /** Venice: model accepts image input. */
  vision?: boolean
}

// ── THE curated fallback catalog, keyed by CANONICAL provider id ─────────────
//
// One copy. It used to be two: ProviderNode.tsx held a byte-for-byte MIRROR of
// this table whose own comment admitted it ("mirrors ProviderNode.STATIC_MODELS"
// / "mirrors bankr-service.ts::FALLBACK_CATALOG"), and the two had already
// drifted — imgnai existed here and not there, so an imgnai provider node
// rendered no model dropdown at all. A silent mirror of a list that goes stale
// (model ids change monthly: see the 2026-08-01 `tencent/hy3:free` note below)
// is a bug waiting for someone to update one side.
//
// ProviderNode now imports `staticModelIds` from here. What it still owns is
// its own live-fetch effects, because those also WRITE node data (Ollama
// resolves an unusable 'auto' seed off a LIVE list; llama.cpp prefers the
// loaded model) — behaviour a read-only catalog hook cannot express. That split
// is deliberate; the CATALOG is not duplicated.
//
// Remaining third copy, deliberately not merged: ImgnaiModelPicker.tsx (chat
// surface, different shape — it derives a `family` per id). It is pinned
// against this table by providerNodeModel.test.ts, so the two cannot diverge
// silently.
const STATIC_MODELS: Record<string, string[]> = {
  'bankr-gateway':    ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8', 'claude-sonnet-4.6', 'gemini-3-pro', 'gemini-3-flash', 'gpt-5.2', 'llama-3.3-70b'],
  // OpenGateway 2026-07: pay-as-you-go. A ':free' SUFFIX IS NOT A PRICE — as of
  // 2026-08-01 tencent/hy3 is paid yet still ships a `tencent/hy3:free` alias;
  // nemotron-3-ultra is the only unconditionally-free model. Ids require the
  // FULL provider/model form; 'auto' = smart routing (billed at the served rate).
  'opengateway':      ['nvidia/nemotron-3-ultra-550b-a55b:free', 'tencent/hy3', 'auto', 'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5', 'google/gemini-3.1-flash-lite', 'minimax/minimax-m3', 'qwen/qwen3.7-max', 'z-ai/glm-5.2'],
  // (non-listed catalog rows are paid). Imported, never re-typed here.
  'surplus':          ['claude-sonnet-4.5', 'claude-opus-4.6', 'gpt-5.4', 'gemini-3.1-pro', 'deepseek-v3.2', 'llama-3.3-70b-instruct'],
  'ollama-local':     ['aya-expanse:8b', 'llama3.3', 'qwen2.5-coder:7b', 'gemma2:9b'],
  'anthropic-oauth':  ['claude-opus-4.8', 'claude-sonnet-4.6', 'claude-haiku-4.5'],
  'freellmapi-local': ['auto'],
  'venice':           ['zai-org-glm-4.7', 'claude-opus-4-8', 'llama-3.3-70b', 'qwen3-235b-a22b-thinking-2507'],
  'imgnai':           ['glm-5-2', 'q-naifu-a3b', 'gpt-5-6-luna', 'gpt-5-6-sol', 'gpt-5-6-terra', 'grok-4-5', 'deepseek-v4-flash', 'deepseek-v4-pro', 'claude-fable-5', 'claude-opus-4-8'],
}

const toOptions = (ids: string[]): ProviderModelOption[] => ids.map(id => ({ id, label: id, vision: isVisionModel(id) }))

/**
 * The curated fallback ids for a CANONICAL provider id (empty when we ship no
 * guess — llama.cpp's models are whatever this machine downloaded). The single
 * source for every static model list on the Nodes surface.
 */
export function staticModelIds(providerId: string): string[] {
  return STATIC_MODELS[providerId] ?? []
}

export function useProviderModels(providerId: string | undefined | null): {
  models: ProviderModelOption[]
  loading: boolean
} {
  const pid = canonicalProviderId(providerId)
  const [models, setModels] = useState<ProviderModelOption[]>(() => toOptions(staticModelIds(pid)))
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setModels(toOptions(staticModelIds(pid)))
    const tachi = window.tachi
    if (!tachi) return
    const finish = () => { if (!cancelled) setLoading(false) }
    const apply = (opts: ProviderModelOption[]) => { if (!cancelled && opts.length > 0) setModels(opts) }
    setLoading(true)

    if (pid === 'bankr-gateway') {
      ;(tachi.bankr?.listModels?.({ force: true }) ?? Promise.resolve(null))
        .then((r: { ok: boolean; models: Array<{ id: string; label?: string }> } | null) => {
          if (r?.ok) apply(r.models.map(m => ({ id: m.id, label: m.label || m.id, vision: isVisionModel(m.id) })))
        }).catch(() => {}).finally(finish)
    } else if (pid === 'surplus') {
      ;(tachi.surplus?.listModels?.({ force: true }) ?? Promise.resolve(null))
        .then((r: { ok: boolean; models: Array<{ id: string; label?: string }> } | null) => {
          if (r?.ok) apply(r.models.map(m => ({ id: m.id, label: m.label || m.id, vision: isVisionModel(m.id) })))
        }).catch(() => {}).finally(finish)
    } else if (pid === 'venice') {
      ;(tachi.venice?.listModels?.({ force: true }) ?? Promise.resolve(null))
        .then((r: { ok: boolean; models: Array<{ id: string; label?: string; vision?: boolean; caps?: string[] }> } | null) => {
          // Venice carries an explicit vision flag; OR it with the heuristic so a
          // mislabelled-but-clearly-vision id still flags.
          if (r?.ok) apply(r.models.map(m => ({ id: m.id, label: m.label || m.id, vision: m.vision || isVisionModel(m.id), caps: m.caps })))
        }).catch(() => {}).finally(finish)
    } else if (pid === 'freellmapi-local') {
      ;(tachi.freellmapi?.listFallbackModels?.() ?? Promise.resolve(null))
        .then((r: { ok: boolean; models: Array<{ modelId: string; name: string; platform: string }> } | null) => {
          if (r?.ok && r.models.length > 0) {
            apply([{ id: 'auto', label: 'auto (best available)' }, ...r.models.map(m => ({ id: m.modelId, label: `${m.name} · ${m.platform}` }))])
          }
        }).catch(() => {}).finally(finish)
    } else if (pid === 'ollama-local') {
      ;(tachi.ollama?.listModels?.() ?? Promise.resolve(null))
        .then((r: { ok: boolean; models: Array<{ id?: string; name?: string }> } | null) => {
          if (r?.ok) apply(r.models.map(m => ({ id: m.id ?? m.name ?? '', label: m.name ?? m.id ?? '', vision: isVisionModel(m.id ?? m.name ?? '') })).filter(o => o.id))
        }).catch(() => {}).finally(finish)
    } else if (pid === 'llama-cpp') {
      ;(tachi.llamaCpp?.status?.() ?? Promise.resolve(null))
        .then((s: { downloadedModels?: string[] } | null) => {
          if (Array.isArray(s?.downloadedModels)) apply(toOptions(s!.downloadedModels))
        }).catch(() => {}).finally(finish)
    } else if (pid === 'imgnai') {
      // Generic discovery surface — returns ModelInfo[] (kat.imgnai.com
      // /v1/models responds even keyless).
      ;(tachi.provider?.listModels?.('imgnai') ?? Promise.resolve(null))
        .then((r: Array<{ id: string; displayName?: string }> | null) => {
          if (Array.isArray(r) && r.length > 0) apply(r.map(m => ({ id: m.id, label: m.displayName || m.id, vision: isVisionModel(m.id) })))
        }).catch(() => {}).finally(finish)
    } else {
      finish()
    }
    return () => { cancelled = true }
  }, [pid])

  return { models, loading }
}

/** Format a model option's display label with its capability tags appended. */
export function modelOptionLabel(m: ProviderModelOption): string {
  return m.caps && m.caps.length > 0 ? `${m.label} · ${m.caps.join(' · ')}` : m.label
}
