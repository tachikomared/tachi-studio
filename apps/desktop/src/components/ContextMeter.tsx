// apps/desktop/src/components/ContextMeter.tsx
//
// Context-window meter for the CODE tab — [CTX nn%] badge with a click dropdown.
// The caller passes a `chars` estimate plus the provider AND model actually
// routed; the window is resolved here, never passed in.
//
// UX F15: the dropdown is actionable — optional segment bars show WHERE the
// context goes, and an optional [COMPACT ▸] button lets the user shrink the
// next turn's history instead of just watching the number climb.
//
// THE NUMBER COMES FROM `useContextWindow` (→ resolveContextWindow + the window
// the provider's own catalog published, as recorded by the model pickers) — the
// SAME source the picker rows and the chat composer's chip read.
//
// It did not until 2026-08-02. This meter divided by `PROVIDER_MAX_TOKENS`, a
// per-PROVIDER table, and hedged the result as "(estimate)". A driver on the
// installed build read `Context: 0% of ~32,000 tokens (estimate)` for
// `olafangensan-glm-4.7-flash-heretic` (Venice serves it at 200,000) and for
// `e2ee-qwen3-6-35b-a3b-uncensored-p` (128,000) — because Venice has no row in
// that table at all and fell to the opengateway floor. The hedge was the tell:
// it was a true label on a wrong number, and the number is what sized the bar.
//
// HONESTY RULE, inherited from the chip in PageTopbar and not to be weakened:
// when nobody published a window for this model we show the token count and NO
// percentage, with no zone colour — a percentage needs a denominator we have.
// Do not reintroduce a per-provider constant here: a provider does not have a
// context window, a model does.
//
// AND (2026-08-02, the seam one day later): when the denominator did NOT come
// from the provider live, the badge says so. This meter drew `0% of 1,000,000`
// in a green zone for `glm-5-2` on imgnAI — from a sourced row in OUR catalog,
// probably the right number — while the picker beside it printed nothing at all
// about the window. The percentage and the colour are claims about how much room
// is LEFT, so they inherit the doubt in the denominator; the title now carries
// the source (see contextUsageTitle in modelWindow.store).
//
// Brutalist: 2px border, no radius, JetBrains Mono. Border/text color follows
// the fill zone (green < 60% < amber < 85% < red), neutral when unknown.

import React, { useState } from 'react'
import { getContextZone } from '../store/agent.store'
import { useContextWindow, describeContextUsage, contextUsageTitle } from '../store/modelWindow.store'

export interface ContextSegment {
  /** Uppercase micro-label, e.g. HISTORY / RAG / SYSTEM. */
  label: string
  chars: number
}

interface ContextMeterProps {
  /** Estimated context characters consumed so far (chars / 4 ≈ tokens). */
  chars: number
  /**
   * Provider id — SCOPES the model lookup (two gateways serve same-named models
   * at different windows). Must be the id the provider's picker records under
   * (`bankr-gateway`, `venice`, `surplus`, …), not a display name.
   */
  providerId: string
  /**
   * The model actually routed. REQUIRED for an honest meter: the window is a
   * per-model fact, and without it this component did what it did until
   * 2026-08-02 — divide by a per-provider constant and print the result.
   */
  modelId: string
  /** Badge label; defaults to CTX. */
  label?: string
  /** Optional composition segments rendered as bars in the dropdown. */
  breakdown?: ContextSegment[]
  /** Optional compact action — renders the [COMPACT ▸] button when provided. */
  onCompact?: () => void
  /** Disable COMPACT (e.g. while a run is in flight or nothing to compact). */
  compactDisabled?: boolean
  /** Extra dim footnote line (e.g. "plus system + tool defs, server-side"). */
  note?: string
}

export function ContextMeter({ chars, providerId, modelId, label = 'CTX', breakdown, onCompact, compactDisabled, note }: ContextMeterProps) {
  const [open, setOpen] = useState(false)

  const win   = useContextWindow(providerId, modelId)
  const usage = describeContextUsage(chars, win)
  // No known window ⇒ no zone. Colouring by an invented denominator is the same
  // lie in another channel.
  const zone  = usage.pct === null ? null : getContextZone(usage.pct / 100)

  const color = zone === null
    ? 'var(--border)'
    : zone === 'red'
      ? 'var(--danger)'
      : zone === 'yellow'
        ? 'var(--warning)'
        : 'var(--success)'
  const textColor = zone === null ? 'var(--text-muted)' : color

  const segTotal = (breakdown ?? []).reduce((s, b) => s + b.chars, 0)

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        /* Stable styling hook for theme structure layers (OPUS-5 gives the badge
           an LED-segment fill, because a context meter IS an instrument reading).
           Neutral everywhere else — no code reads it. */
        data-ctx-meter=""
        /* Same sentence as the chat chip, from the same builder — including the
           provenance of the denominator whenever the number is not the
           provider's own. Two badges of one reading may not word it two ways. */
        title={`${contextUsageTitle(usage, win, modelId)} — click for breakdown`}
        style={{
          padding: '1px 6px',
          /* Published for theme structure layers: OPUS-5 / TK-05 paint the
             badge as an LED ladder and clip the lit cells to this width.
             Inert in every other theme. An unknown window lights no cells
             rather than lighting them against a made-up scale. */
          ...({ '--ctx-fill': `${usage.pct ?? 0}%` } as React.CSSProperties),
          border: `2px solid ${color}`,
          background: 'transparent',
          color: textColor,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.05em',
          cursor: 'pointer',
          lineHeight: 1.6,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {usage.pct === null
          ? `[${label} ${usage.tokens.toLocaleString()} TOK]`
          : `[${label} ${usage.pct}%]`}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'var(--bg-elevated)',
            border: `2px solid ${color}`,
            padding: '8px 12px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--text-primary)',
            zIndex: 9999,
            minWidth: 260,
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Context window</div>
          {/* Segment bars — where the context actually goes. A bar is a FRACTION
              OF THE WINDOW, so with no window there is no bar: the segment's
              token count still prints, because that half is measured. */}
          {breakdown && breakdown.length > 0 && segTotal > 0 && (
            <div style={{ marginBottom: 6 }}>
              {breakdown.map(seg => {
                const segPct = usage.windowTokens === null
                  ? null
                  : Math.min(seg.chars / 4 / usage.windowTokens, 1)
                return (
                  <div key={seg.label} style={{ marginBottom: 3 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
                      <span>{seg.label}</span>
                      <span>{Math.round(seg.chars / 4).toLocaleString()} tok</span>
                    </div>
                    {segPct !== null && (
                      <div style={{ height: 6, border: '1px solid var(--border)', background: 'var(--bg-inset)' }}>
                        <div style={{ height: '100%', width: `${Math.max(segPct * 100, seg.chars > 0 ? 2 : 0)}%`, background: color }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div>chars: {Math.max(0, chars).toLocaleString()}</div>
          <div>tokens (est): {usage.tokens.toLocaleString()}</div>
          {/* The window row prints ONLY what is known about this model, and
              names who answered — so a family estimate can never be mistaken
              for the provider's own number. */}
          {usage.windowTokens === null
            ? <div style={{ color: 'var(--text-muted)' }}>max tokens: not published for this model</div>
            : <div>max tokens: {usage.windowTokens.toLocaleString()} <span style={{ color: 'var(--text-dim)' }}>({win.source})</span></div>}
          <div>provider: {providerId || 'unknown'}</div>
          <div>model: {modelId || 'unknown'}</div>
          {zone !== null && <div style={{ marginTop: 4, color }}>zone: {zone.toUpperCase()}</div>}
          {note && (
            <div style={{ marginTop: 4, fontSize: 9, color: 'var(--text-dim)', whiteSpace: 'normal', maxWidth: 240 }}>{note}</div>
          )}
          {onCompact && (
            <button
              onClick={() => { onCompact(); setOpen(false) }}
              disabled={compactDisabled}
              title="Keep the last turns verbatim and drop older history from the NEXT request — the full log stays on screen and the agent can recover details with expand_compacted"
              style={{
                marginTop: 8,
                padding: '4px 10px',
                border: '2px solid var(--accent)',
                background: compactDisabled ? 'var(--bg-inset)' : 'var(--accent)',
                color: compactDisabled ? 'var(--text-dim)' : '#fff',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: compactDisabled ? 'default' : 'pointer',
                width: '100%',
              }}
            >
              Compact ▸
            </button>
          )}
        </div>
      )}
    </div>
  )
}
