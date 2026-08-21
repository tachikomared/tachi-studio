// apps/desktop/src/store/modelWindow.store.ts
//
// ONE place the renderer answers "how big is this model's context window?".
//
// Why this exists: on 2026-08-02 a driver hovered the chat CTX chip on a Venice
// conversation and read `Context: 0% of 32,000 tokens` for Claude Opus 5, GLM
// 5.2, DeepSeek V4 Pro — every Venice model, because the chip looked the number
// up in a PER-PROVIDER table (`PROVIDER_MAX_TOKENS`) that has no Venice row at
// all, and every OpenRouter model read 128,000 including Kimi K3, which the
// model picker on the SAME screen labelled `1049k ctx`. Two surfaces, one model,
// two numbers, and the wrong one was the one under the cursor.
//
// A context window is a per-MODEL fact and the provider serving the model is the
// authority for it (see packages/core/src/tachi/models.ts). The pickers already
// fetch that number — every provider catalog service carries `contextTokens`
// through when its gateway publishes one, and OMITS the field when it does not.
// So the pickers publish what they fetched here, and every other surface reads
// it back through `resolveContextWindow`, which is the same resolver the picker
// rows are built from. Same input, same resolver, same answer.
//
// HONESTY CONTRACT (inherited from resolveContextWindow, do not weaken):
//   * a window that is NOT known is never printed as if it were — callers show
//     no number rather than an invented one (`known: false`);
//   * budgeting callers (red-zone, smart-attach) still get a usable number,
//     because a guess you can label is better than a division by nothing;
//   * an id nobody published a window for stays unknown; we do not default it;
//   * a KNOWN window still carries WHO answered, and every surface that prints
//     the number prints that too when it did not come from the provider live
//     (see "PROVENANCE" below — the seam the day after the 32k fix).
//
// NOT persisted: it is a mirror of catalogs that are themselves refetched (and
// main-side cached) per session. A stale window written to disk would outlive
// the model it described.

import { useCallback } from 'react'
import { create } from 'zustand'
import { resolveContextWindow, type ResolvedContextWindow, type ContextWindowSource } from '@tachi/core/src/tachi/models'

/** A catalog row as every provider picker already has it. */
export interface CatalogWindowRow {
  id: string
  /**
   * The window this provider's catalog row carries — present only when the
   * gateway published one (or a curated fallback row shipped the vendor's own
   * published number). Absent means UNKNOWN; never substitute a default.
   */
  contextTokens?: number
  /**
   * Whether this row came from a LIVE catalog fetch. Every provider service
   * already carries it, and every picker already gates its TAG evidence on it
   * (`m.live && typeof m.contextTokens === 'number'`).
   *
   * The window was the half nobody gated: the pickers handed `res.models`
   * wholesale to `recordCatalogWindows`, fallback rows included, and this store
   * has no way to tell a number a gateway published from a number one of us
   * typed into a service file. Downstream, `resolveContextWindow` reports the
   * store's value with `source: 'live'` — so an unreachable gateway made every
   * surface say "published by this provider's own catalog" about our own
   * hand-written constant. `undefined` is accepted (a caller that genuinely
   * cannot tell), `false` is refused.
   */
  live?: boolean
}

/** Cache key. Provider-scoped on purpose: two gateways serve same-named models
 *  at different windows (Venice's `deepseek-v4-pro` is not imgnAI's). */
export function modelWindowKey(providerId: string, modelId: string): string {
  return `${(providerId || '').toLowerCase()}::${(modelId || '').toLowerCase()}`
}

interface ModelWindowStore {
  /** key → window in tokens, as published by that provider for that model. */
  windows: Record<string, number>
  /**
   * Publish a provider catalog. Rows without a usable window are recorded as
   * nothing at all (not as a zero, not as a default) — the resolver must be free
   * to fall through to the static rows and report the weaker source honestly.
   *
   * Rows explicitly marked `live: false` are DROPPED HERE rather than at the
   * four call sites, so a fifth picker cannot reintroduce the lie by forgetting
   * to filter. See CatalogWindowRow.live.
   */
  recordCatalogWindows(providerId: string, rows: ReadonlyArray<CatalogWindowRow>): void
}

export const useModelWindowStore = create<ModelWindowStore>((set, get) => ({
  windows: {},

  recordCatalogWindows(providerId, rows) {
    if (!providerId || rows.length === 0) return
    const prev = get().windows
    let next: Record<string, number> | null = null
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || r.id === '') continue
      // A row the service marked as NOT live is our own curated fallback. It may
      // still be a fine number to display — the pickers show it, tagged
      // `(catalog)` — but it must reach the surfaces through the static rows the
      // resolver already owns, not through the store that means "the provider
      // said so".
      if (r.live === false) continue
      const tok = r.contextTokens
      if (typeof tok !== 'number' || !Number.isFinite(tok) || tok <= 0) continue
      const k = modelWindowKey(providerId, r.id)
      const v = Math.floor(tok)
      if (prev[k] === v) continue
      next ??= { ...prev }
      next[k] = v
    }
    // Only write when something actually changed — this runs on every picker
    // load, and a fresh object identity would re-render every subscriber.
    if (next) set({ windows: next })
  },
}))

/**
 * THE renderer entry point for a model's context window.
 *
 * `resolveContextWindow` decides; this only supplies the live value the pickers
 * published, so the picker and every other surface answer from the same input.
 * Non-reactive — for React use `useContextWindow`.
 */
export function contextWindowFor(providerId: string, modelId: string): ResolvedContextWindow {
  return resolveContextWindow(modelId, useModelWindowStore.getState().windows[modelWindowKey(providerId, modelId)])
}

/** Reactive form of `contextWindowFor`. Re-renders only when THIS model's
 *  published window changes (the selector returns a number or undefined). */
export function useContextWindow(providerId: string, modelId: string): ResolvedContextWindow {
  const live = useModelWindowStore(s => s.windows[modelWindowKey(providerId, modelId)])
  return resolveContextWindow(modelId, live)
}

/**
 * `useContextWindow` for a LIST of models — a model picker resolving every row
 * of one provider's catalog.
 *
 * A picker cannot call `useContextWindow` per row (a hook inside a loop over a
 * variable-length list is not a hook), and that mechanical fact is how the
 * pickers ended up with a display rule of their own: they printed the raw live
 * value they had fetched and nothing else, while every other surface asked the
 * resolver. Same store, same resolver, one call per row.
 */
export function useContextWindowResolver(providerId: string): (modelId: string) => ResolvedContextWindow {
  const windows = useModelWindowStore(s => s.windows)
  return useCallback(
    (modelId: string) => resolveContextWindow(modelId, windows[modelWindowKey(providerId, modelId)]),
    [windows, providerId],
  )
}

/**
 * The published window alone, for callers that must send it somewhere else
 * (the chat red-zone budget lives in the main process and cannot read this
 * store). `undefined` means "no provider published one for this model" — pass
 * it through as absent, never as a number.
 */
export function publishedContextTokens(providerId: string, modelId: string): number | undefined {
  return useModelWindowStore.getState().windows[modelWindowKey(providerId, modelId)]
}

/** How a usage meter may talk about `chars` against `window`. */
export interface ContextUsage {
  /** chars/4 ≈ tokens, the app-wide estimate. */
  tokens: number
  /** Percent full — null when the window is unknown, because a percentage of an
   *  unknown denominator is exactly the lie this module exists to kill. */
  pct: number | null
  /** The window, only when it is evidence about this model. */
  windowTokens: number | null
}

/**
 * Pure: what a context meter may claim, given a char estimate and a resolved
 * window. Split out of the badge so the honesty rule is unit-testable without
 * rendering — an unknown window yields `pct: null` and `windowTokens: null`,
 * and there is no code path that turns those back into a number.
 */
export function describeContextUsage(chars: number, win: ResolvedContextWindow): ContextUsage {
  const tokens = Math.round(Math.max(0, chars) / 4)
  if (!win.known) return { tokens, pct: null, windowTokens: null }
  return {
    tokens,
    pct: Math.min(Math.round((tokens / win.tokens) * 100), 100),
    windowTokens: win.tokens,
  }
}

// ── PROVENANCE ───────────────────────────────────────────────────────────────
//
// `known: true` is not one thing. It is EITHER the number the provider's own
// live catalog published for the model it serves ('live'), OR a sourced row in
// our static catalog ('catalog') — an exact-id or named-variant row with a dated
// citation, real evidence, but OURS and not theirs.
//
// Both are evidence and both may be shown. They are not the same claim, and the
// day after the 32k lie died a driver found the seam that admission had left:
// for `glm-5-2` on imgnAI the chip and the CODE meter printed
// `Context: 0% of 1,000,000 tokens` in a green zone (source 'catalog'), while
// the picker three inches away said NOTHING about the window — because the
// picker printed only a LIVE value and the meter printed the resolver's answer.
//
// Note what this is NOT: 1,000,000 is probably RIGHT (Venice publishes 1000k for
// the same underlying model). Unlike `32,000` for a 200k model, the two surfaces
// disagreed about CONFIDENCE, not about the number. So the fix is not to stop
// showing the static value — that would take the percentage away from every
// Anthropic conversation, where no picker publishes a live catalog at all and
// `claude-opus-5`'s 200k/1M rows are the only thing we have, and it would put
// back "no window published for this model" as a lie of a different kind.
//
// The fix is that every surface answers from `resolveContextWindow`, and any
// number that did not come from the provider live carries its source with it.
// The helpers below are that vocabulary — a compact tag, the same fact as prose,
// and the two sentences the pickers and the badges hover with. Nothing may spell
// it a second way.

/** The compact tag beside a number — `null` for 'live', which needs no hedge. */
export function contextSourceNote(source: ContextWindowSource): string | null {
  switch (source) {
    case 'live':            return null
    case 'catalog':         return 'catalog'
    case 'family-estimate': return 'estimate'
    case 'assumed':         return 'assumed'
  }
}

/** The same fact as prose, for a tooltip that has room to say it. */
export function contextSourceSentence(source: ContextWindowSource): string | null {
  switch (source) {
    case 'live':            return null
    case 'catalog':         return 'from our own model catalog, not from this provider\'s live catalog'
    case 'family-estimate': return 'a family-wide estimate, not a fact about this model'
    case 'assumed':         return 'an assumed default, not a published window'
  }
}

/**
 * The window as a string a surface may print, with its provenance welded on:
 * `1,000,000` when the provider published it, `1,000,000 (catalog)` when we did.
 *
 * Returns null for a window that is not known — there is nothing honest to
 * print — so a caller that interpolates this cannot accidentally show a guess.
 */
export function formatContextTokens(win: ResolvedContextWindow | null | undefined): string | null {
  if (!win || !win.known || !Number.isFinite(win.tokens) || win.tokens <= 0) return null
  const note = contextSourceNote(win.source)
  return note === null ? win.tokens.toLocaleString() : `${win.tokens.toLocaleString()} (${note})`
}

/**
 * The `· 200k ctx` tail a model-picker row prints — ONE spelling for every
 * picker.
 *
 * It lived in exactly one of them (OpenRouter), so a Venice row printed no
 * window while an OpenRouter row did, for no reason a user could see. That
 * asymmetry was in the DISPLAY only: Venice publishes
 * `model_spec.availableContextTokens`, and Bankr and Surplus publish theirs —
 * all three services have carried the number since 2026-08-02 and the pickers
 * simply never printed it.
 *
 * It takes a RESOLVED window, not a raw number, because "what the provider
 * happened to publish" was the picker-only definition of known that produced the
 * seam above. Null for a window that is not known — a row nobody can size still
 * prints NOTHING, and making the columns match by inventing a number would be a
 * worse bug than the asymmetry it tidied.
 */
export function formatContextSuffix(win: ResolvedContextWindow | null | undefined): string | null {
  if (!win || !win.known || !Number.isFinite(win.tokens) || win.tokens <= 0) return null
  const note = contextSourceNote(win.source)
  return ` · ${Math.round(win.tokens / 1000)}k ctx${note === null ? '' : ` (${note})`}`
}

/** The picker row's hover line: the full number, and who said so. */
export function contextWindowTitle(win: ResolvedContextWindow | null | undefined): string | null {
  if (!win || !win.known || !Number.isFinite(win.tokens) || win.tokens <= 0) return null
  const sentence = contextSourceSentence(win.source)
  return `${win.tokens.toLocaleString()} token context window`
    + (sentence === null ? ', published by this provider\'s own catalog' : ` — ${sentence}`)
}

/**
 * THE sentence both context badges hover with — the chat chip (PageTopbar) and
 * the CODE tab's meter (ContextMeter).
 *
 * One function so two surfaces cannot word one reading two ways, and so the
 * percentage can never appear without the provenance of the denominator it was
 * computed from: a green zone is a claim about how much room is LEFT, and that
 * claim inherits every doubt the denominator carries.
 */
export function contextUsageTitle(
  usage: ContextUsage,
  win: ResolvedContextWindow,
  modelId: string,
): string {
  if (usage.pct === null || usage.windowTokens === null) {
    return `Context: ${usage.tokens.toLocaleString()} tokens used — no context window published for ${modelId || 'this model'}, so there is no percentage to show`
  }
  const sentence = contextSourceSentence(win.source)
  return `Context: ${usage.pct}% of ${usage.windowTokens.toLocaleString()} tokens`
    + (sentence === null ? '' : ` — window ${sentence}`)
}
