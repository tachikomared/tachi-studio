// apps/desktop/src/components/ConfirmDialog.tsx
//
// Brutalist in-app confirmation modal. Replaces window.confirm().
// Used via ConfirmProvider + useConfirm() hook.

import React, { useEffect, useRef } from 'react'

export interface ConfirmOptions {
  title?:        string   // default "CONFIRM"
  message:       string   // the question
  okLabel?:      string   // default "OK"
  cancelLabel?:  string   // default "CANCEL"
  danger?:       boolean  // true → OK button uses --danger color
}

interface ConfirmDialogProps extends ConfirmOptions {
  onOk:     () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title       = 'CONFIRM',
  message,
  okLabel     = 'OK',
  cancelLabel = 'CANCEL',
  danger      = false,
  onOk,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef     = useRef<HTMLButtonElement>(null)

  // Trap focus inside the modal while open.
  useEffect(() => {
    // Focus Cancel by default (safe default).
    cancelRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      // Tab cycles between Cancel and OK only.
      if (e.key === 'Tab') {
        e.preventDefault()
        if (document.activeElement === cancelRef.current) {
          okRef.current?.focus()
        } else {
          cancelRef.current?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const accentVar = danger ? 'var(--danger, #ff5252)' : 'var(--accent)'

  return (
    // Backdrop
    <div
      onClick={onCancel}
      style={{
        position:        'fixed',
        inset:           0,
        zIndex:          99999,
        background:      'rgba(0, 0, 0, 0.50)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
      }}
    >
      {/* Card — stop propagation so clicks inside don't dismiss */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth:   380,
          maxWidth:   560,
          background: 'var(--bg-surface)',
          border:     `2px solid ${accentVar}`,
          boxShadow:  'var(--shadow-hard)',
          fontFamily: 'JetBrains Mono, monospace',
          display:    'flex',
          flexDirection: 'column',
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
          <span id="confirm-title">{title}</span>
        </div>

        {/* Body */}
        <div style={{
          padding:    '14px 14px 12px',
          fontSize:   13,
          lineHeight: 1.5,
          color:      'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak:  'break-word',
        }}>
          {message}
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
            ref={cancelRef}
            onClick={onCancel}
            style={{
              padding:    '5px 14px',
              border:     '2px solid var(--border)',
              background: 'transparent',
              color:      'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:     'pointer',
            }}
          >
            {cancelLabel}
          </button>

          {/* OK — filled */}
          <button
            ref={okRef}
            onClick={onOk}
            style={{
              padding:    '5px 14px',
              border:     `2px solid ${accentVar}`,
              background: accentVar,
              color:      '#ffffff',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:     'pointer',
            }}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
