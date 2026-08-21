// apps/desktop/src/components/ToolCallRow.tsx
//
// SHARED TOOL-CALL ROW — the one brutalist row used to render a single tool /
// span invocation, so TraceTab (the canonical look) and the agent transcript's
// ToolCallBlock no longer hand-roll the same flex skeleton twice.
//
// The row is deliberately slotted. The scalar props (`name`, `argsPreview`,
// `status`, `durationMs`, `tokens`) drive a sensible default layout that any
// new tool-call list can drop in as-is; per-surface extras go through the
// slots (`leading`, `children`) and a few parity overrides so an existing call
// site can adopt it with byte-for-byte identical output. It owns only the
// chrome + status color + duration/token formatting — never surface-specific
// content.
//
// Layout (left → right):
//   [ leading | name ]  [ argsPreview (flex:1) ]  [ tokens ] [ duration ]  [ children ]
//
// Nothing here renders a hardcoded user-visible string: labels/args/durations
// are all data supplied by the caller, so there is no i18n surface of its own.

import React from 'react'
import {
  formatToolDuration,
  formatTokenCount,
  toolCallStatusColor,
  type ToolCallStatus,
} from './toolCallRow.format'

export type { ToolCallStatus } from './toolCallRow.format'

export interface ToolCallRowProps {
  /** Tool / span name, shown after the leading slot (ellipsized). */
  name: string
  /**
   * Args/context preview for the flex:1 middle. A string is rendered as a
   * muted, ellipsized one-liner (with a hover title); any other node is
   * rendered verbatim (e.g. TraceTab's timeline bar) and owns its own layout.
   */
  argsPreview?: React.ReactNode
  /** Drives the default leading dot + the default duration color. */
  status: ToolCallStatus
  /** Raw duration; formatted via formatToolDuration unless `durationText` set. */
  durationMs?: number
  /** Optional token count, shown as a compact trailing chip. */
  tokens?: number
  /** When set, the whole row becomes an interactive <button>. */
  onClick?: () => void
  /** Trailing content after the duration (badges, a +/- toggle, …). */
  children?: React.ReactNode

  // ── optional slots / parity overrides ──────────────────────────────────────
  /** Custom leading cell (a kind/family chip). Defaults to a status-colored dot. */
  leading?: React.ReactNode
  /** Left padding on the name cell (tree depth in TraceTab), in px. */
  indent?: number
  /** Fixed min-width on the name cell so middles line up across rows, in px. */
  nameMinWidth?: number
  /** Preformatted duration text, overriding formatToolDuration(durationMs). */
  durationText?: string
  /** Duration text color; defaults to muted (accent while running). */
  durationColor?: string
  /** Row padding (default "3px 10px"). */
  padding?: string
  /** Row font-size in px (default 11). */
  fontSize?: number
  /** Draw the bottom hairline border (default true). */
  bordered?: boolean
  /** Tooltip for the name text. */
  title?: string
}

export function ToolCallRow({
  name,
  argsPreview,
  status,
  durationMs,
  tokens,
  onClick,
  children,
  leading,
  indent,
  nameMinWidth,
  durationText,
  durationColor,
  padding,
  fontSize,
  bordered,
  title,
}: ToolCallRowProps) {
  const interactive = typeof onClick === 'function'

  const rootStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: padding ?? '3px 10px',
    border: 'none',
    ...(bordered === false ? {} : { borderBottom: 'var(--border-width) solid var(--border)' }),
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: fontSize ?? 11,
    color: 'var(--text-primary)',
    boxSizing: 'border-box',
    ...(interactive
      ? { width: '100%', background: 'transparent', textAlign: 'left' as const, cursor: 'pointer' }
      : {}),
  }

  const durText = durationText ?? (typeof durationMs === 'number' ? formatToolDuration(durationMs) : '')
  const durCol = durationColor ?? (status === 'running' ? toolCallStatusColor(status) : 'var(--text-muted)')

  const body = (
    <>
      {/* Leading cell + name. Grouped so an optional min-width aligns middles. */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflow: 'hidden',
          ...(indent != null ? { paddingLeft: indent } : {}),
          ...(nameMinWidth != null ? { minWidth: nameMinWidth } : {}),
        }}
      >
        {leading ?? (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              background: toolCallStatusColor(status),
              border: 'var(--border-width) solid var(--border-strong)',
            }}
          />
        )}
        {name ? (
          <span
            style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={title ?? name}
          >
            {name}
          </span>
        ) : null}
      </span>

      {/* Middle: string preview auto-wraps; any other node renders verbatim. */}
      {argsPreview == null ? (
        <span style={{ flex: 1 }} />
      ) : typeof argsPreview === 'string' ? (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-muted)',
          }}
          title={argsPreview}
        >
          {argsPreview}
        </span>
      ) : (
        argsPreview
      )}

      {/* Trailing: tokens, then duration, then per-surface extras. */}
      {typeof tokens === 'number' && Number.isFinite(tokens) ? (
        <span style={{ flexShrink: 0, color: 'var(--text-dim)', fontSize: 10 }}>{formatTokenCount(tokens)}</span>
      ) : null}
      {durText ? (
        <span style={{ minWidth: 60, textAlign: 'right', color: durCol, flexShrink: 0 }}>{durText}</span>
      ) : null}
      {children}
    </>
  )

  return interactive ? (
    <button type="button" onClick={onClick} style={rootStyle}>
      {body}
    </button>
  ) : (
    <div style={rootStyle}>{body}</div>
  )
}
