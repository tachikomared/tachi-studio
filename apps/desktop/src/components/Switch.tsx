// apps/desktop/src/components/Switch.tsx
//
// THE ON/OFF TOGGLE, AS A REAL CONTROL.
//
// Driver finding (Civitai phase-1 verify): the Private Mode toggle had no
// `role`, no `aria-checked` and no input of any kind — the handler sat on an
// inner <div>, so a screen reader announced nothing, the keyboard could not
// reach it at all, and clicking the "OFF" text next to it (inside a <label>
// with no control to label) did nothing. The identical shape was copy-pasted
// onto the scrub toggle and the context-recall toggle; the latter had picked up
// role/aria-checked but still no tabIndex and no key handler, which is the
// worst of the three — announced as a switch, unreachable as one.
//
// ONE control instead of three hand-rolled ones. It is a <button>, which is the
// whole fix: focusable, Space/Enter activated, disabled-aware, and announced by
// its own `role="switch"` + `aria-checked` with no keyboard code of our own to
// get wrong. The VISUAL is byte-for-byte the brutalist track the app already
// had — 36x18 box, 2px border, 12px knob sliding on `left` — because this is an
// accessibility fix, not a redesign.
//
// NAMING: prefer `labelledBy` pointing at the visible heading. An aria-label
// duplicating a visible string is a translation that can drift from the text
// beside it; pointing at the heading cannot.

import React from 'react'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Text shown beside the track. Part of the button, so clicking it toggles. */
  onLabel: string
  offLabel: string
  /** id of the visible element that names this switch. Preferred over `label`. */
  labelledBy?: string
  /** Accessible name when nothing visible names it. */
  label?: string
  disabled?: boolean
}

export function Switch({
  checked, onChange, onLabel, offLabel, labelledBy, label, disabled = false,
}: SwitchProps): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        // Strip the UA button chrome so the brutalist look is unchanged. The
        // focus ring is deliberately NOT stripped — it is the point.
        background: 'none',
        border: 0,
        padding: 0,
        margin: 0,
        fontFamily: 'inherit',
        fontSize: 'inherit',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: checked ? 'var(--accent)' : 'var(--text-muted)',
      }}>
        {checked ? onLabel : offLabel}
      </span>
      {/* Decorative: the state is already on aria-checked, so announcing the
          track (and its knob) again would just be noise. */}
      <span aria-hidden="true" style={{
        display: 'block',
        width: 36,
        height: 18,
        border: `2px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
        background: checked ? 'var(--accent-muted)' : 'var(--bg-inset, var(--bg-base))',
        position: 'relative',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}>
        <span style={{
          position: 'absolute',
          top: 1,
          left: checked ? 'calc(100% - 14px)' : 1,
          width: 12,
          height: 12,
          background: checked ? 'var(--accent)' : 'var(--border)',
          transition: 'left 0.15s',
        }} />
      </span>
    </button>
  )
}
