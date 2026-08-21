// apps/desktop/src/pages/nodes/canvas/ResultCardChrome.tsx
//
// PanelChrome-style wrapper for node result cards.
//
// Inspired by the Grafana PanelChrome hover-header pattern
// (grafana/packages/grafana-ui/src/components/PanelChrome/PanelChrome.tsx):
//   - Header is HIDDEN at rest; slides in / fades in on hover.
//   - Header shows a title + an optional actions slot (buttons/icons).
//   - Collapse/expand: clicking the title area (or a dedicated chevron) toggles
//     the body, so heavy cards shrink to a slim title bar.
//
// Design system rules:
//   - 2px hard borders, hard offset shadow, JetBrains Mono — matches every
//     other node card in this canvas.
//   - CSS-variable colours: --border, --bg-surface, --bg-elevated, --text-primary,
//     --text-dim, --border-strong.
//   - No new npm deps — pure React / inline styles / a scoped <style> tag.
//   - All user-facing strings go through t() in the "nodes" namespace.

import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResultCardChromeProps {
  /** Title shown in the hover header (left side). */
  title: string
  /**
   * Accent colour for the border + shadow. Defaults to var(--border-strong).
   * Pass the same accent as the parent node so cards feel connected.
   */
  accent?: string
  /**
   * Optional slot for action buttons on the right side of the header.
   * Render small (16 px height) buttons styled to match the header bar.
   */
  actions?: React.ReactNode
  /** Whether the card starts collapsed. Default false. */
  defaultCollapsed?: boolean
  /** Whether to allow collapsing at all. Default true. */
  collapsible?: boolean
  /**
   * When true the header is ALWAYS visible (not just on hover).
   * Use for standalone result cards (OutputNode) where the title/actions
   * are permanent UI, not hover affordances.
   */
  headerAlwaysVisible?: boolean
  /** Extra className forwarded to the outermost container. */
  className?: string
  /** Extra inline style forwarded to the outermost container. */
  style?: React.CSSProperties
  /** The result content. Hidden when collapsed. */
  children: React.ReactNode
}

// ── Scoped style ──────────────────────────────────────────────────────────────
//
// We inject one small <style> block per instance (deduped by React's reconciler
// since the content is identical every render). Scoped to .rcc-root so it never
// leaks onto other elements.

const CHROME_CSS = `
.rcc-root { position: relative; }

/* Header: hidden at rest, revealed on hover or when collapsed */
.rcc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 6px;
  height: 0;
  overflow: hidden;
  opacity: 0;
  transition: height 120ms ease-out, opacity 120ms ease-out;
  border-bottom: 0px solid transparent;
  box-sizing: border-box;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  user-select: none;
  cursor: pointer;
}

/* Show header on hover, when card is collapsed, or when header-always class set.
   Collapsed class: title is always visible when body is hidden so card doesn't
   disappear entirely. rcc-header-always: for standalone result cards (OutputNode)
   where the header is a permanent element, not a hover affordance.
   A11Y (batch34): :focus-within is the keyboard twin of :hover — the header is
   tabbable (role=button + tabIndex), so it must become VISIBLE when it takes
   focus instead of leaving a sighted keyboard user on an invisible control. */
.rcc-root:hover .rcc-header,
.rcc-root:focus-within .rcc-header,
.rcc-collapsed .rcc-header,
.rcc-header-always .rcc-header {
  height: 22px;
  opacity: 1;
  overflow: visible;
  border-bottom-width: 2px;
}

/* Body: shown by default, hidden when collapsed */
.rcc-body {
  overflow: hidden;
  transition: max-height 150ms ease-out, opacity 150ms ease-out;
  max-height: 2000px;
  opacity: 1;
}
.rcc-collapsed .rcc-body {
  max-height: 0;
  opacity: 0;
  pointer-events: none;
}

/* Chevron rotates when collapsed */
.rcc-chevron {
  display: inline-block;
  font-style: normal;
  line-height: 1;
  transition: transform 150ms ease-out;
  flex-shrink: 0;
}
.rcc-collapsed .rcc-chevron {
  transform: rotate(-90deg);
}
`

// ── Component ─────────────────────────────────────────────────────────────────

export function ResultCardChrome({
  title,
  accent = 'var(--border-strong)',
  actions,
  defaultCollapsed = false,
  collapsible = true,
  headerAlwaysVisible = false,
  className,
  style,
  children,
}: ResultCardChromeProps) {
  const { t } = useTranslation('nodes')
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const containerRef = useRef<HTMLDivElement>(null)

  const toggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (collapsible) setCollapsed(prev => !prev)
  }

  // A11Y (batch34): the header carries role="button" but was mouse-only. It
  // cannot become a real <button> — the actions slot nests buttons inside it,
  // and nested interactive content is invalid inside <button> — so it gets the
  // rest of the button contract instead: tabIndex + Enter/Space activation.
  const onHeaderKeyDown = (e: React.KeyboardEvent) => {
    if (!collapsible) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      e.stopPropagation()
      setCollapsed(prev => !prev)
    }
  }

  const outerStyle: React.CSSProperties = {
    border: `2px solid ${accent}`,
    background: 'var(--bg-surface)',
    boxShadow: `3px 3px 0 ${accent}`,
    fontFamily: 'JetBrains Mono, monospace',
    ...style,
  }

  const headerBgStyle: React.CSSProperties = {
    background: accent,
    color: 'var(--bg-base)',
    borderBottom: `2px solid ${accent}`,
  }

  const collapseTitle = collapsed
    ? t('resultCard.expand')
    : t('resultCard.collapse')

  return (
    <>
      <style>{CHROME_CSS}</style>
      <div
        ref={containerRef}
        className={[
          'rcc-root',
          collapsed ? 'rcc-collapsed' : '',
          headerAlwaysVisible ? 'rcc-header-always' : '',
          className ?? '',
        ].filter(Boolean).join(' ')}
        style={outerStyle}
      >
        {/* ── Hover header ───────────────────────────────────────────────────
            A11Y (batch34): the button contract lives on the TITLE span, not on
            this bar. `role="button"` makes its subtree presentational per ARIA,
            and this bar also hosts the actions slot — putting the role here hid
            PIN / × / REGEN from assistive tech. The bar keeps only the mouse
            shortcut (click anywhere on it to collapse); the keyboard path is the
            titleform below, which is why the sweep allowlists this one div. */}
        <div
          className="rcc-header"
          style={headerBgStyle}
          onClick={collapsible ? toggleCollapse : undefined}
          title={collapsible ? collapseTitle : undefined}
          // Honesty marker for the a11y sweep: this click is a duplicate of a
          // control that IS keyboard-reachable, so it needs no role/tabIndex of
          // its own. Never put this on a click that is the only way to act.
          data-a11y="mouse-shortcut"
        >
          {/* Title + optional collapse chevron — THE collapse control. */}
          <span
            onClick={collapsible ? toggleCollapse : undefined}
            onKeyDown={collapsible ? onHeaderKeyDown : undefined}
            role={collapsible ? 'button' : undefined}
            tabIndex={collapsible ? 0 : undefined}
            aria-expanded={collapsible ? !collapsed : undefined}
            aria-label={collapsible ? t('resultCard.toggleAria', { title, defaultValue: 'Toggle result card: {{title}}' }) : undefined}
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {collapsible && (
              <span className="rcc-chevron" aria-hidden="true">▾</span>
            )}{' '}
            {title}
          </span>

          {/* Actions slot — stop propagation so clicks don't toggle collapse */}
          {actions && (
            <span
              style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              {actions}
            </span>
          )}
        </div>

        {/* ── Content body ──────────────────────────────────────────────── */}
        <div
          className="rcc-body"
          aria-hidden={collapsed}
        >
          {children}
        </div>
      </div>
    </>
  )
}

// ── Header action button helper ───────────────────────────────────────────────
//
// Small utility for the most common action button shape inside ResultCardChrome
// so callers don't need to repeat the exact styling.

export interface ChromeActionButtonProps {
  onClick: (e: React.MouseEvent) => void
  title: string
  label: string
  /** If true renders as a destructive (warning-coloured) button. */
  destructive?: boolean
  disabled?: boolean
}

export function ChromeActionButton({
  onClick,
  title,
  label,
  destructive = false,
  disabled = false,
}: ChromeActionButtonProps) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      className="nodrag"
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{
        height: 16,
        padding: '0 5px',
        border: `var(--border-width, 2px) solid var(--bg-base)`,
        background: 'transparent',
        color: destructive ? 'var(--destructive, var(--warning))' : 'var(--bg-base)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9,
        fontWeight: 800,
        lineHeight: '14px',
        letterSpacing: '0.04em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </button>
  )
}
