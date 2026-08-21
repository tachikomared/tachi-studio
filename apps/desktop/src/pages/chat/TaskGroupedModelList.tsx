// apps/desktop/src/pages/chat/TaskGroupedModelList.tsx
//
// THE dropdown body every catalog-backed model picker renders (Bankr, Venice,
// Surplus, OpenRouter, imgnAI — and, through them, the Code tab, which mounts
// the very same components). One file so the grouping, the ARIA and the honesty
// rules exist once instead of five times.
//
// ── HOW FAMILY AND TASK COEXIST ──────────────────────────────────────────────
// The caller keeps owning its DEFAULT layout and hands it in as `groups` — for
// four of the five that is the family grouping they already shipped (CLAUDE /
// GPT / GEMINI …), for OpenRouter it is its free/paid split. Nothing about that
// view changes: an expert who opens the list to find "Sonnet 5" finds exactly
// the list they found yesterday, in the same order, with the model id still on
// the second line.
//
// The TASK axis is a FILTER STRIP above that list. Pick "Writing code" and the
// list collapses to the models that carry the tag, ranked by recommendModels()
// with its one-line reason printed under each row. Pick "All" and you are back
// in the family list. So a newcomer answers "what do I use for code" in one
// click without knowing a name, and nobody's existing scan is taken away.
//
// Rejected: task SECTIONS containing families. A model is routinely agentic AND
// coding AND long-context, so sections duplicate rows — Sonnet 5 would appear
// three times, tripling the list and destroying the by-name scan the expert
// relies on. Also rejected: a bare "recommended for…" band, which shows a
// shortlist and silently hides the rest of a task's members.
//
// ── WHAT THIS FILE IS NOT ALLOWED TO DO ──────────────────────────────────────
// It never decides what a model is good at. Every tag comes back from
// resolveTaskTags() in @tachi/core, which derives from tool support, context
// size, modality, price and a dated citation table, and returns NOTHING for a
// model it cannot prove anything about. There is no model name in this file and
// there must never be one.
//
// A model with no tags therefore shows no chips — and stays selectable in the
// unfiltered list. There is deliberately no "Other" / "General" task group: a
// bucket named for the models we could not classify reads as a judgement about
// them, which is the exact claim the taxonomy refuses to make.
//
// LIVE FACTS: a caller may pass contextTokens / capabilities / pricing ONLY for
// rows that really came from a live catalog fetch (every picker's model info
// carries a `live` boolean for precisely this). Forwarding a hand-written
// fallback row would make the resolver print "the provider's own live catalog
// lists…" over a value a human typed here.
//
// ── WHERE PRICE LIVES, AND WHY IT IS NOT A CHIP ──────────────────────────────
// Price is a SECOND AXIS, not a seventh task: a model is routinely both "writing
// code" and expensive. So it gets its own LINE — the meta line under the model
// name — reading `<band> · <rate>`, e.g. "PRICIEST · $15/M in · $75/M out".
// One glance answers "what will this cost me" on every row of every view, in
// the family list and inside a task filter alike.
//
// Rejected, in order of how tempting they were:
//   · MORE CHIPS IN THE TASK STRIP — for PRICE BANDS as a second vocabulary.
//     It would put two different questions ("what is it for", "what does it
//     cost") behind one control, with no way for the user to know whether
//     picking one of each means AND or OR. (The strip itself grew to eight
//     TAGS on 2026-08-02 — `uncensored`, `frontier` — but they are tags in the
//     ONE vocabulary, resolved and counted like every other tag.)
//   · A SECOND FILTER STRIP. Doubles the sticky chrome above a list that is
//     already scrolling inside a popover, and duplicates a control we have:
//     the cheap pole is ALREADY filterable, because `everyday` is defined by
//     the identical price threshold the `budget` band uses.
//   · SORTING BY PRICE. Cheapest-first destroys the family grouping this file
//     exists to preserve — the expert's by-name scan is not negotiable.
//   · A FILTER FOR THE EXPENSIVE POLE. "Show me only the costly ones" is not a
//     thing a newcomer wants; being WARNED is. A warning has to be on the row
//     they are about to click, not behind a filter they must think to apply.
//     OVERRIDDEN 2026-08-02 by the owner, who asked for exactly that group
//     ("Frontier Top models"). It shipped as the `frontier` TAG in @tachi/core
//     — membership derived from the premium price band, never asserted here —
//     and the on-row warning stays. The other three rejections stand.
//
// The band is our summary; the $/M number beside it is the fact, and both come
// from resolveTaskTags(). A model whose price cannot be proven shows NEITHER —
// same refusal, same reason as a model with no tags.
//
// ── THE CONTEXT WINDOW ON A ROW ──────────────────────────────────────────────
// It is resolved HERE, once, for every picker — not passed in as a formatted
// string by each of them. Four pickers used to print `formatContextSuffix(the
// window this fetch happened to carry)`, which is a stricter definition of
// "known" than the one every other surface uses, applied on exactly one screen:
// for `glm-5-2` on imgnAI the picker printed nothing while the chat chip and the
// CODE meter confidently rendered `0% of 1,000,000 tokens` in a green zone from
// a sourced row in our own catalog. Same store, same resolver, same answer now —
// and a number that did not come from the provider live says so on the row.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  resolveTaskTags,
  recommendModels,
  isOfferableFor,
  formatUsdPerM,
  type ModelPrice,
} from '@tachi/core/src/models/resolve-task-tags'
import { TASK_TAGS, type TaskTag, type PriceBand } from '@tachi/core/src/models/task-tags'
import type { ModelCapability } from '@tachi/core/src/providers/registry'
import type { ResolvedContextWindow } from '@tachi/core/src/tachi/models'
import { useContextWindowResolver, formatContextSuffix, contextWindowTitle } from '../../store/modelWindow.store'

// ── Shapes ───────────────────────────────────────────────────────────────────

/** One selectable model row. The live-fact fields are optional and evidence-only. */
export interface PickableModel {
  id: string
  label: string
  /** Live catalog context window. Pass ONLY for a row that came from a live fetch. */
  contextTokens?: number
  /** Live catalog per-model capabilities. Pass ONLY for a live row. */
  capabilities?: readonly ModelCapability[]
  /** Live catalog per-model price. Pass ONLY for a live row. */
  pricing?: { inUsdPerMTok?: number; outUsdPerMTok?: number }
}

/** The caller's own default grouping — usually by model family. */
export interface ModelGroup {
  key: string
  /** Empty = no header (a pinned row such as openrouter/auto). */
  label: string
  models: PickableModel[]
  /** Disclosure rendered under the header (e.g. OpenRouter's free-tier limits). */
  note?: React.ReactNode
}

interface Props {
  /** Canonical provider id — handed to the resolver, never inspected here. */
  providerId: string
  groups: ModelGroup[]
  value: string
  onPick: (modelId: string) => void
  /** Accessible name for the listbox (the provider's own picker label). */
  listLabel: string
  /** Extra inline badge after the model label. */
  renderBadge?: (m: PickableModel) => React.ReactNode
}

// ── Live-fact extraction ─────────────────────────────────────────────────────

function liveFactsOf(m: PickableModel) {
  const has =
    typeof m.contextTokens === 'number' ||
    (m.capabilities?.length ?? 0) > 0 ||
    m.pricing !== undefined
  if (!has) return null
  return {
    contextTokens: m.contextTokens,
    capabilities: m.capabilities,
    pricing: m.pricing,
  }
}

/** Cheap identity for the memo — ids plus the live values that move a tag. */
function signatureOf(models: PickableModel[]): string {
  return models
    .map(m => `${m.id}|${m.contextTokens ?? ''}|${m.pricing?.inUsdPerMTok ?? ''}|${m.capabilities?.join('+') ?? ''}`)
    .join('\u0000')   // one char an id cannot contain, ESCAPED rather than
                            // a raw NUL byte in the source: that made git call
                            // this file binary and print 'Binary files differ'
                            // instead of a reviewable diff of the rules above.
}

// ── Tag chip ─────────────────────────────────────────────────────────────────
//
// `free` borrows the success colour because it is the same claim the pickers
// already print in green; `frontier` borrows the warning colour because it IS
// the claim the PRICIEST band prints in amber (same resolved price, one
// derivation). Everything else stays dim so eight tags never shout over the
// model name.

const TAG_COLOR = (tag: TaskTag) =>
  tag === 'free' ? 'var(--success)'
  : tag === 'frontier' ? 'var(--warning)'
  : 'var(--text-dim)'

export function TaskTagChips({ tags }: { tags: readonly TaskTag[] }) {
  const { t } = useTranslation(['chat', 'providers'])
  if (tags.length === 0) return null
  return (
    <>
      {tags.map(tag => (
        <span
          key={tag}
          title={t(`providers:taskTags.${tag}.blurb`)}
          style={{
            padding: '0 3px',
            border: `var(--border-width) solid ${TAG_COLOR(tag)}`,
            color: TAG_COLOR(tag),
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          {t(`providers:taskTags.${tag}.label`)}
        </span>
      ))}
    </>
  )
}

// ── Price line ───────────────────────────────────────────────────────────────
//
// A four-step colour ramp so the two poles the owner asked for read without
// being read: green at the bottom, amber at the top, dim in between. `mid`
// stays deliberately quiet — it is the answer "nothing to see here", and if it
// shouted it would drown out the one row that matters.

const PRICE_BAND_COLOR: Record<PriceBand, string> = {
  free:    'var(--success)',
  budget:  'var(--success)',
  mid:     'var(--text-dim)',
  premium: 'var(--warning)',
}

/**
 * `<band> · <rate>` — our summary, then the number it summarises.
 *
 * Renders NOTHING when either half is missing, which happens for exactly one
 * reason: the resolver could not prove a price. It never falls back to a
 * keyword-matched rate, because that would price a model off its name.
 */
export function PriceNote({ price, band }: { price: ModelPrice | null; band: PriceBand | null }) {
  const { t } = useTranslation(['chat', 'providers'])
  if (!price || !band) return null
  return (
    <>
      <span
        title={t(`providers:priceBands.${band}.blurb`)}
        style={{ color: PRICE_BAND_COLOR[band], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
      >
        {t(`providers:priceBands.${band}.label`)}
      </span>
      {' · '}
      {/* The rate carries its own provenance in the tooltip — a live catalog
          row and a bundled snapshot are both honest, and they are not the same
          thing. */}
      <span title={price.why}>
        {band === 'free'
          ? t('chat:picker.priceFree')
          : t('chat:picker.priceRate', {
              in: formatUsdPerM(price.inPerM),
              out: formatUsdPerM(price.outPerM),
            })}
      </span>
    </>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────

const headerStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 8,
  color: 'var(--text-dim)',
  background: 'var(--bg-elevated)',
  borderBottom: 'var(--border-width) solid var(--border)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
}

export function TaskGroupedModelList({
  providerId,
  groups,
  value,
  onPick,
  listLabel,
  renderBadge,
}: Props) {
  const { t } = useTranslation(['chat', 'providers'])
  const [tag, setTag] = useState<TaskTag | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // De-duplicated flat catalog. A model listed in two groups is resolved once.
  const all = useMemo(() => {
    const seen = new Set<string>()
    const out: PickableModel[] = []
    for (const g of groups) {
      for (const m of g.models) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        out.push(m)
      }
    }
    return out
  }, [groups])

  const signature = signatureOf(all)

  // id → the resolved context window, from the SAME store + resolver the chat
  // chip, the CODE meter and the harness budget read. Memoised for the same
  // reason the tags below are: OpenRouter ships 300+ rows and each resolve walks
  // the capability catalog.
  const resolveWindow = useContextWindowResolver(providerId)
  const ctxById = useMemo(() => {
    const map = new Map<string, ResolvedContextWindow>()
    for (const m of all) map.set(m.id, resolveWindow(m.id))
    return map
  }, [all, resolveWindow])

  // id → the full resolved result (tags AND price). Resolved once per catalog,
  // not once per render: OpenRouter ships 300+ rows and every resolve walks the
  // capability catalog. One resolve per model also means the tags and the price
  // on a row are guaranteed to describe the same evidence.
  const factsById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveTaskTags>>()
    for (const m of all) {
      map.set(m.id, resolveTaskTags({ id: m.id, providerId, live: liveFactsOf(m) }))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, providerId])

  // The number on a chip is a PROMISE about the list that chip filters to, so
  // it is counted with the SAME predicate the filtered list is built from
  // (isOfferableFor — see @tachi/core). It used to count `f.tags` directly
  // while the list dropped not-a-general-chat models, and a driver read
  // "READS IMAGES 24" over 23 rendered rows: the missing row was a multimodal
  // moderation guardrail, correctly tagged and correctly withheld. One
  // predicate, two readers.
  const counts = useMemo(() => {
    const c = {} as Record<TaskTag, number>
    for (const tg of TASK_TAGS) c[tg] = 0
    for (const f of factsById.values()) for (const tg of TASK_TAGS) if (isOfferableFor(f, tg)) c[tg] += 1
    return c
  }, [factsById])

  // Filtered view: the recommender's ORDER and its per-row reason. limit is the
  // whole catalog — this is a filter, not a top-5 teaser, so nothing is hidden.
  const ranked = useMemo(() => {
    if (!tag) return null
    const byId = new Map(all.map(m => [m.id, m]))
    const recs = recommendModels(
      tag,
      all.map(m => ({ id: m.id, providerId, live: liveFactsOf(m) })),
      {},
      { limit: all.length || 1 },
    )
    return recs
      .map(r => ({ model: byId.get(r.id), reason: r.reason }))
      .filter((x): x is { model: PickableModel; reason: string } => !!x.model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, signature, providerId])

  // ── Roving focus. Options are <button>s, so Tab+Enter already worked — but
  // tabbing through 300 models to leave the dropdown did not. Only the selected
  // option is tabbable; arrows move focus inside the list.
  const optionEls = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])

  const onListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const els = optionEls()
    if (els.length === 0) return
    e.preventDefault()
    const here = els.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? els.length - 1
      : e.key === 'ArrowDown' ? Math.min(els.length - 1, here + 1)
      : Math.max(0, here <= 0 ? 0 : here - 1)
    els[next]?.focus()
  }, [])

  // Index of the row that owns tabIndex=0. Falls back to the first row when the
  // stored value names nothing in this catalog.
  const flatOrder = ranked ? ranked.map(r => r.model.id) : all.map(m => m.id)
  const selectedIdx = Math.max(0, flatOrder.indexOf(value))

  const renderRow = (m: PickableModel, reason: string | null) => {
    const isSelected = m.id === value
    const idx = flatOrder.indexOf(m.id)
    const facts = factsById.get(m.id)
    const tags = facts?.tags ?? []
    const ctx = ctxById.get(m.id) ?? null
    const ctxSuffix = formatContextSuffix(ctx)
    const price = facts?.price ?? null
    const band = facts?.priceBand ?? null
    // The id stays on the row (experts navigate by it) and is suppressed only
    // when the label IS the id — a bare custom endpoint, where a second
    // identical line would be noise rather than information.
    const showId = m.label !== m.id || !!ctxSuffix
    return (
      <button
        key={m.id}
        role="option"
        type="button"
        aria-selected={isSelected}
        tabIndex={idx === selectedIdx ? 0 : -1}
        onClick={() => onPick(m.id)}
        style={{
          textAlign: 'left',
          padding: '8px 12px',
          border: 'none',
          borderBottom: 'var(--border-width) solid var(--border)',
          background: isSelected ? 'var(--accent-muted)' : 'transparent',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          width: '100%',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontWeight: isSelected ? 700 : 500 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</span>
          {renderBadge?.(m)}
          <TaskTagChips tags={tags} />
        </span>
        {/* Meta line: the id the experts navigate by, then the price axis. A
            row we cannot price shows only the id; a bare custom endpoint we
            CAN price shows only the price. Neither half is invented to keep
            the line company. */}
        {(showId || band) && (
          <span style={{ fontSize: 9, color: 'var(--text-dim)', whiteSpace: 'normal' }}>
            {showId && m.id}
            {/* The window carries its own provenance, exactly as the rate beside
                it does: bare when the provider published it, `(catalog)` when
                the number is ours. The tooltip says which in full. */}
            {ctxSuffix && <span title={contextWindowTitle(ctx) ?? undefined}>{ctxSuffix}</span>}
            {showId && band ? ' · ' : ''}
            <PriceNote price={price} band={band} />
          </span>
        )}
        {reason && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.35, whiteSpace: 'normal' }}>
            {reason}
          </span>
        )}
      </button>
    )
  }

  return (
    <>
      {/* ── Task filter strip. Lives OUTSIDE the listbox: a listbox may only
          contain options and groups, so a row of toggles inside one is not a
          list a screen reader can walk. */}
      <div
        role="group"
        aria-label={t('chat:picker.taskFilterAria')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '6px 8px',
          background: 'var(--bg-elevated)',
          borderBottom: '2px solid var(--border)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <FilterChip
          active={tag === null}
          label={t('chat:picker.taskAll')}
          title={t('chat:picker.taskAllTitle')}
          onClick={() => setTag(null)}
        />
        {TASK_TAGS.filter(tg => counts[tg] > 0).map(tg => (
          <FilterChip
            key={tg}
            active={tag === tg}
            label={`${t(`providers:taskTags.${tg}.label`)} ${counts[tg]}`}
            title={t(`providers:taskTags.${tg}.blurb`)}
            onClick={() => setTag(tag === tg ? null : tg)}
          />
        ))}
      </div>

      {tag && (
        <div style={{
          padding: '5px 10px',
          fontSize: 9,
          lineHeight: 1.4,
          color: 'var(--text-dim)',
          background: 'var(--bg-inset)',
          borderBottom: 'var(--border-width) solid var(--border)',
        }}>
          {t(`providers:taskTags.${tag}.blurb`)}
        </div>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label={listLabel}
        onKeyDown={onListKeyDown}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {ranked
          ? (ranked.length === 0
              ? <div style={{ padding: '10px 12px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-dim)' }}>
                  {t('chat:picker.taskEmpty')}
                </div>
              : ranked.map(r => renderRow(r.model, r.reason)))
          : groups.map(g => {
              if (g.models.length === 0) return null
              // Real group semantics — the visible header is hidden from the
              // a11y tree so the group is announced once, by its label.
              return (
                <div key={g.key} role="group" aria-label={g.label || listLabel}>
                  {g.label && <div aria-hidden="true" style={headerStyle}>{g.label}</div>}
                  {g.note}
                  {g.models.map(m => renderRow(m, null))}
                </div>
              )
            })}
      </div>
    </>
  )
}

function FilterChip({
  active, label, title, onClick,
}: { active: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        padding: '2px 6px',
        border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent-muted)' : 'var(--bg-surface)',
        color: active ? 'var(--accent-text)' : 'var(--text-dim)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}
