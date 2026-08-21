// apps/desktop/src/pages/chat/samplerPresets.ts
//
// PER-CHAT SAMPLER PRESETS (USER-PAINS T19). A conversation carries an optional
// sampler setting that maps to the OpenAI-compatible `temperature` / `top_p`
// request params. Three named presets keep beginners safe (BALANCED is the
// default and sends NOTHING — the provider's own defaults apply), while an
// ADVANCED mode exposes the exact knobs for power users who today leave for
// LM Studio just to set a temperature.
//
// Pure + framework-free so it is unit-tested (test/unit/samplerPresets.test.ts)
// and shared by the composer (resolve → send) and the SamplerChip UI. The
// main-process request build receives ALREADY-RESOLVED params, never the raw
// preset — see chat-service.ts. The golden rule lives here: BALANCED (and an
// absent sampler) resolves to `{}` so we never surprise a provider with an
// explicit default it didn't ask for.

/** Named sampler presets. `balanced` = provider defaults (send nothing). */
export type SamplerPresetId = 'fast' | 'balanced' | 'creative' | 'advanced'

/**
 * Per-conversation sampler setting, persisted on the Conversation. Migration
 * safe: an ABSENT value is treated as BALANCED everywhere. `temperature` /
 * `topP` are only meaningful (and only read) when preset === 'advanced'.
 */
export interface SamplerSettings {
  preset: SamplerPresetId
  /** ADVANCED only: explicit temperature, 0–2. */
  temperature?: number
  /** ADVANCED only: explicit top-p, 0–1. */
  topP?: number
}

/** OpenAI-compatible sampler params. An EMPTY object = send provider defaults. */
export interface SamplerParams {
  temperature?: number
  top_p?: number
}

/** The safe default adopted by every conversation that hasn't set a preset. */
export const DEFAULT_SAMPLER: SamplerSettings = { preset: 'balanced' }

/** The ordered presets the chip cycles / lists (BALANCED in the middle). */
export const SAMPLER_PRESETS: readonly SamplerPresetId[] = ['fast', 'balanced', 'creative', 'advanced']

// Fixed values for the named presets.
export const FAST_TEMPERATURE = 0.3
export const CREATIVE_TEMPERATURE = 0.9
export const CREATIVE_TOP_P = 0.95
// Seed values when a user first opens ADVANCED (a neutral, provider-typical mid).
export const ADVANCED_DEFAULT_TEMPERATURE = 0.7
export const ADVANCED_DEFAULT_TOP_P = 1.0

// Slider bounds (mirrored by the ADVANCED popover inputs).
export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const TEMPERATURE_STEP = 0.1
export const TOP_P_MIN = 0
export const TOP_P_MAX = 1
export const TOP_P_STEP = 0.05

/** Clamp + round temperature to the supported [0,2] range. */
export function clampTemperature(v: number): number {
  if (!Number.isFinite(v)) return ADVANCED_DEFAULT_TEMPERATURE
  return Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, Math.round(v * 100) / 100))
}

/** Clamp + round top-p to the supported [0,1] range. */
export function clampTopP(v: number): number {
  if (!Number.isFinite(v)) return ADVANCED_DEFAULT_TOP_P
  return Math.min(TOP_P_MAX, Math.max(TOP_P_MIN, Math.round(v * 100) / 100))
}

/** The effective preset for a (possibly-absent) sampler setting. */
export function samplerPreset(s: SamplerSettings | null | undefined): SamplerPresetId {
  return s?.preset ?? 'balanced'
}

/**
 * Resolve a sampler setting to the OpenAI-compatible params to send.
 *
 * BALANCED (and an absent/unknown preset) → `{}` so the provider's own defaults
 * apply untouched — the safety guarantee the composer relies on. FAST/CREATIVE
 * use their fixed values; ADVANCED emits exactly the knobs the user set
 * (clamped), omitting any that are missing.
 */
export function samplerToParams(s: SamplerSettings | null | undefined): SamplerParams {
  const preset = samplerPreset(s)
  switch (preset) {
    case 'fast':
      return { temperature: FAST_TEMPERATURE }
    case 'creative':
      return { temperature: CREATIVE_TEMPERATURE, top_p: CREATIVE_TOP_P }
    case 'advanced': {
      const out: SamplerParams = {}
      if (typeof s?.temperature === 'number' && Number.isFinite(s.temperature)) {
        out.temperature = clampTemperature(s.temperature)
      }
      if (typeof s?.topP === 'number' && Number.isFinite(s.topP)) {
        out.top_p = clampTopP(s.topP)
      }
      return out
    }
    case 'balanced':
    default:
      return {}
  }
}

/**
 * Params for the send payload: the resolved params, or `undefined` when there
 * is nothing to send (BALANCED). Keeps the IPC payload clean rather than
 * shipping an empty object the main side would just spread to nothing.
 */
export function samplerPayload(s: SamplerSettings | null | undefined): SamplerParams | undefined {
  const params = samplerToParams(s)
  return Object.keys(params).length > 0 ? params : undefined
}
