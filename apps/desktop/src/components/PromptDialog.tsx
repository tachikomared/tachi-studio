// apps/desktop/src/components/PromptDialog.tsx
//
// Brutalist in-app TEXT-INPUT modal. Replaces window.prompt().
// Used via ConfirmProvider + usePromptText() hook.
//
// WHY THIS EXISTS: window.prompt() is not implemented in Electron's renderer —
// it throws, so the click handler dies mid-way and the feature is simply dead in
// a packaged build (see the same note at DesignPage.tsx's brand-URL input and
// NookBounties.tsx's apply modal, which each hand-rolled a one-off input for
// exactly this reason). This is the shared version of that workaround, so the
// next surface that needs a string from the user doesn't hand-roll a third one.
//
// A11Y comes from the house useDialog() hook (the same one <Modal>, the canvas
// menus and the blueprint dialog use): Escape closes, Tab is trapped, and focus
// is restored to the invoking control on unmount. The text input is deliberately
// the FIRST focusable element in the card, which is what puts initial focus in
// the input — useDialog focuses the first focusable on open. Do not add a header
// × button above it without also making the input explicitly focused.
//
// Deliberately danger-free: this dialog asks for a value, it never confirms a
// destructive act, so it has no `danger` prop and always renders in --accent.

import React, { useId, useState } from 'react'
import { useDialog } from '../hooks/useDialog'

export interface PromptOptions {
  title?:        string   // default "INPUT"
  message:       string   // the label shown above the input
  placeholder?:  string   // input placeholder
  initialValue?: string   // pre-filled text (default "")
  okLabel?:      string   // default "OK"
  cancelLabel?:  string   // default "CANCEL"
  maxLength?:    number   // optional hard cap on the input
}

interface PromptDialogProps extends PromptOptions {
  /** Called with the TRIMMED, non-empty value. Never called with a blank string. */
  onOk:     (value: string) => void
  onCancel: () => void
}

export function PromptDialog({
  title        = 'INPUT',
  message,
  placeholder,
  initialValue = '',
  okLabel      = 'OK',
  cancelLabel  = 'CANCEL',
  maxLength,
  onOk,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue)
  const ref     = useDialog<HTMLDivElement>(onCancel)
  const titleId = useId()
  const inputId = useId()

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0

  // Blank (or whitespace-only) input can never resolve a value: the OK button is
  // disabled and Enter is a no-op, so the caller's "empty = cancel" contract
  // holds without the dialog silently closing on a stray Enter.
  const submit = () => { if (canSubmit) onOk(trimmed) }

  const accentVar = 'var(--accent)'

  return (
    // Backdrop — click outside cancels.
    <div
      onClick={onCancel}
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         99999,
        background:     'rgba(0, 0, 0, 0.50)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
    >
      {/* Card — stop propagation so clicks inside don't dismiss */}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth:      380,
          maxWidth:      560,
          background:    'var(--bg-surface)',
          border:        `2px solid ${accentVar}`,
          boxShadow:     'var(--shadow-hard)',
          fontFamily:    'JetBrains Mono, monospace',
          display:       'flex',
          flexDirection: 'column',
          outline:       'none',
        }}
      >
        {/* Header */}
        <div style={{
          padding:       '10px 14px 8px',
          borderBottom:  `2px solid ${accentVar}`,
          fontSize:      11,
          fontWeight:    700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color:         accentVar,
        }}>
          <span id={titleId}>{title}</span>
        </div>

        {/* Body — label + the input. The input is the first focusable in the
            card, so useDialog's initial focus lands directly in it. */}
        <div style={{
          padding:       '14px 14px 12px',
          display:       'flex',
          flexDirection: 'column',
          gap:           8,
        }}>
          <label
            htmlFor={inputId}
            style={{
              fontSize:   13,
              lineHeight: 1.5,
              color:      'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak:  'break-word',
            }}
          >
            {message}
          </label>
          <input
            id={inputId}
            type="text"
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits. Escape is handled by useDialog (document-level),
              // but stop it here too so it never leaks to a parent handler.
              if (e.key === 'Enter') { e.preventDefault(); submit() }
            }}
            style={{
              width:      '100%',
              boxSizing:  'border-box',
              padding:    '7px 9px',
              border:     '2px solid var(--border)',
              background: 'var(--bg-inset)',
              color:      'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   13,
              outline:    'none',
            }}
          />
        </div>

        {/* Footer */}
        <div style={{
          padding:        '8px 14px 12px',
          display:        'flex',
          justifyContent: 'flex-end',
          gap:            8,
        }}>
          {/* Cancel — ghost */}
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding:       '5px 14px',
              border:        '2px solid var(--border)',
              background:    'transparent',
              color:         'var(--text-primary)',
              fontFamily:    'JetBrains Mono, monospace',
              fontSize:      11,
              fontWeight:    700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:        'pointer',
            }}
          >
            {cancelLabel}
          </button>

          {/* OK — filled, disabled while the input is blank */}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              padding:       '5px 14px',
              border:        `2px solid ${accentVar}`,
              background:    accentVar,
              color:         '#ffffff',
              fontFamily:    'JetBrains Mono, monospace',
              fontSize:      11,
              fontWeight:    700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:        canSubmit ? 'pointer' : 'not-allowed',
              opacity:       canSubmit ? 1 : 0.5,
            }}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
