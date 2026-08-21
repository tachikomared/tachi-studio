// apps/desktop/src/pages/nodes/useMediaModels.ts
//
// One hook for MEDIA model catalogs — shared by the canvas MediaNode and the
// Configure side panel so media model selection is a real dropdown everywhere
// (never hand-typed), exactly like useProviderModels does for text providers.
//
// Given (provider, modality) it loads the provider's catalog filtered to the
// modality (same IPC surfaces MediaPage uses):
//   surplus → window.tachi.surplusMedia.listModels
//   venice  → window.tachi.venice.listMediaModels
//   imgnai  → window.tachi.imgnaiMedia.listModels   (image + video only)
//   local   → sd.cpp downloaded models (image/video) or piper voices (tts)
//
// Pass provider=null to disable loading (panel rendering a non-media node).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaNodeModality } from './types'
import type { SurplusMediaModelInfo } from '../../types/electron'

export type MediaProvider = 'surplus' | 'venice' | 'local' | 'imgnai' | 'pollinations'

/** Providers offered for a modality — imgnai is image+video; pollinations is
 *  image only (keyless cloud); local covers image/video (sd.cpp) + tts
 *  (piper). Surplus/Venice cover everything. */
export function mediaProvidersFor(modality: MediaNodeModality): MediaProvider[] {
  const out: MediaProvider[] = ['surplus', 'venice']
  if (modality === 'image' || modality === 'video') out.push('imgnai')
  if (modality === 'image') out.push('pollinations')
  if (modality === 'image' || modality === 'video' || modality === 'tts') out.push('local')
  return out
}

/** Coerce whatever is stored on node data into a provider valid for the modality. */
export function normalizeMediaProvider(raw: unknown, modality: MediaNodeModality): MediaProvider {
  const p = typeof raw === 'string' ? raw : 'surplus'
  return (mediaProvidersFor(modality) as string[]).includes(p) ? (p as MediaProvider) : 'surplus'
}

/** A local checkpoint's DECLARED row: family + its own generation recipe. */
export interface LocalSdRowInfo {
  family:         string
  steps:          number
  cfgScale:       number
  samplingMethod: string
}

export function useMediaModels(
  provider: MediaProvider | null,
  modality: MediaNodeModality,
): {
  models: SurplusMediaModelInfo[]
  error: string | null
  /**
   * id → the INSTALLED row, for LOCAL models only (empty for every other
   * provider). The canvas node used to guess the family from the id string
   * (`includes('xl')` → sdxl), which mediaLocalModelTruth pins as "the trap":
   * `civitai-812345` (an SDXL checkpoint) got SD 1.5 presets and any id
   * containing "xl" claimed SDXL. sd-cpp:status has carried the declared family
   * since the MediaPage fix; the node simply never read it.
   */
  localRows: Record<string, LocalSdRowInfo>
} {
  const { t } = useTranslation('nodes')
  const [models, setModels] = useState<SurplusMediaModelInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [localRows, setLocalRows] = useState<Record<string, LocalSdRowInfo>>({})

  useEffect(() => {
    if (provider !== 'local') setLocalRows({})
    if (provider === null) { setModels([]); setError(null); return }
    let cancelled = false
    setError(null)
    type CatalogResult = { ok: boolean; models: SurplusMediaModelInfo[]; error?: string }
    const asInfo = (ms: Array<{ id: string; label?: string }>): SurplusMediaModelInfo[] =>
      ms.map(m => ({ id: m.id, label: m.label || m.id })) as unknown as SurplusMediaModelInfo[]
    const load: Promise<CatalogResult> = provider === 'local'
      ? (modality === 'tts'
          // Piper AND STUDIO (kokoro) voices, merged into ONE list (audit
          // 3D-1): unlike MediaPage, the canvas node has no engine-toggle —
          // it renders a single model dropdown — so both local TTS engines'
          // voices have to live in it together. `window.tachi.kokoro` is
          // absent on a pre-sidecar build; caught the same way the composer's
          // own optional-chained reads of it are.
          ? Promise.all([
              window.tachi.piper.status(),
              window.tachi.kokoro?.status().catch(() => undefined) ?? Promise.resolve(undefined),
            ]).then(([piper, kokoro]) => {
              const piperModels = asInfo(piper.voices.map(v => ({ id: v.id })))
              // kokoro.status().voices is the STATIC curated list regardless
              // of download state (the voice style vectors ship inside the
              // npm package) — gated on `installed` (the ~92MB ONNX weights)
              // so the node never offers a voice id it cannot synthesize yet,
              // the same installed-gate piper's own voices already get.
              const kokoroModels = kokoro?.installed
                ? asInfo(kokoro.voices.map(v => ({ id: v.id, label: v.label })))
                : []
              const models = [...kokoroModels, ...piperModels]
              const anyInstalled = piper.installed || (kokoro?.installed ?? false)
              return {
                ok: anyInstalled,
                models,
                error: models.length > 0
                  ? undefined
                  : anyInstalled ? t('mediaNode.noLocalVoices') : t('mediaNode.installPiper'),
              }
            })
          : window.tachi.sdCpp.status().then(s => {
              const want = modality === 'video' ? 'video' : 'image'
              const ms = s.models.filter(m => m.kind === want)
              if (!cancelled) {
                setLocalRows(Object.fromEntries(s.models.map(m => [m.id, {
                  family: m.family ?? '', steps: m.steps ?? 20, cfgScale: m.cfgScale ?? 7, samplingMethod: m.samplingMethod ?? 'euler',
                }])))
              }
              // label = the row's NAME (the media NODE showed raw ids too, so a
              // user-installed model read 'civitai-812345' on the canvas).
              return { ok: s.installed, models: asInfo(ms.map(m => ({ id: m.id, label: m.name }))), error: s.installed ? (ms.length ? undefined : t('mediaNode.noLocalModels', { kind: want })) : t('mediaNode.installSdCpp') }
            }))
      : provider === 'venice'
        ? window.tachi.venice.listMediaModels({ modality }).then(r => ({ ok: r.ok, models: r.models as SurplusMediaModelInfo[], error: r.error }))
        : provider === 'imgnai'
          ? ((modality === 'image' || modality === 'video')
              ? window.tachi.imgnaiMedia.listModels({ modality }).then(r => ({ ok: r.ok, models: asInfo(r.models), error: r.error }))
              : Promise.resolve({ ok: false, models: [], error: t('mediaNode.noModels') }))
          : provider === 'pollinations'
            // Keyless + image-only; main's static fallback guarantees a model
            // even offline, so a fresh-install node is never an empty dropdown.
            ? (modality === 'image'
                ? window.tachi.pollinationsMedia.listModels({}).then(r => ({ ok: r.ok, models: asInfo(r.models), error: r.error }))
                : Promise.resolve({ ok: false, models: [], error: t('mediaNode.noModels') }))
            : window.tachi.surplusMedia.listModels({ modality })
    load
      .then(res => {
        if (cancelled) return
        if (res.ok && res.models.length > 0) setModels(res.models)
        else { setModels([]); if (res.error) setError(res.error) }
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [modality, provider])

  return { models, error, localRows }
}
