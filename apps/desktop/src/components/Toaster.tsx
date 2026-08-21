// apps/desktop/src/components/Toaster.tsx
//
// Brutalist toast notifications. Subscribes to window 'tachi:toast' events.
// Use anywhere: window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

import React, { useEffect, useState } from 'react'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label:   string
  onClick: () => void
}

export interface ToastInput {
  kind?:    ToastKind
  text:     string
  /** ms before auto-dismiss. Default 4000. 0 = never auto-dismiss. */
  ttl?:     number
  /** Optional inline action buttons rendered after the text. */
  actions?: ToastAction[]
}

interface Toast extends ToastInput {
  id: number
}

let _seq = 0

const KIND_COLOR: Record<ToastKind, string> = {
  info:    'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  error:   'var(--danger)',
}

const KIND_LABEL: Record<ToastKind, string> = {
  info:    'INFO',
  success: 'OK',
  warning: 'WARN',
  error:   'ERR',
}

export function showToast(input: ToastInput): void {
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: input }))
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail as ToastInput | undefined
      if (!detail || typeof detail.text !== 'string') return
      const t: Toast = { ...detail, id: ++_seq }
      setToasts(prev => [...prev, t])
      const ttl = detail.ttl === 0 ? 0 : (detail.ttl ?? 4000)
      if (ttl > 0) {
        setTimeout(() => {
          setToasts(prev => prev.filter(x => x.id !== t.id))
        }, ttl)
      }
    }
    window.addEventListener('tachi:toast', onToast as EventListener)
    return () => window.removeEventListener('tachi:toast', onToast as EventListener)
  }, [])

  const dismiss = (id: number) => setToasts(prev => prev.filter(t => t.id !== id))

  // ── THE LIVE REGION IS ALWAYS MOUNTED ──────────────────────────────────────
  //
  // This used to `return null` while the list was empty, which is every moment
  // before the first toast. A live region announces CHANGES to a node the
  // assistive tech is already observing — one that is created together with its
  // first child has nothing to compare against, so nothing is read out. For a
  // surface where a toast is the ONLY notice of some state changes (the
  // provider fallback, a stopped render, a failed save) that is the difference
  // between "quiet" and "silent".
  //
  // `role="status"` (not the previous `role="region"`) is the right container:
  // it is the polite-live landmark for advisory, non-urgent messages, which is
  // exactly what every toast here is. It carries an implicit aria-live="polite",
  // spelled out anyway because older screen readers honour the explicit
  // attribute more reliably than the implicit one.
  //
  // An always-present fixed-position box would swallow clicks in that corner of
  // the window, so `pointerEvents: 'none'` on the container is load-bearing now
  // rather than merely tidy — each toast re-enables it for itself.
  return (
    <div
      role="status"
      aria-label="Notifications"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 10000,
        maxWidth: 360,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => {
        const kind = t.kind ?? 'info'
        const color = KIND_COLOR[kind]
        return (
          <div
            key={t.id}
            className="tachi-toast"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              border: `2px solid ${color}`,
              background: 'var(--bg-surface)',
              boxShadow: 'var(--shadow-hard)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: 'var(--text-primary)',
            }}
          >
            <span style={{
              flexShrink: 0,
              padding: '1px 5px',
              border: `2px solid ${color}`,
              background: 'var(--bg-elevated)',
              color,
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: '0.08em',
            }}>{KIND_LABEL[kind]}</span>
            <span style={{ flex: 1, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.text}</span>
            {t.actions && t.actions.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {t.actions.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => { a.onClick(); dismiss(t.id) }}
                    style={{
                      padding: '2px 6px',
                      border: `2px solid ${color}`,
                      background: 'transparent',
                      color,
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                    }}
                  >{a.label}</button>
                ))}
              </div>
            )}
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              title="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-dim)',
                padding: 0,
                lineHeight: 1,
                fontSize: 14,
              }}
            >×</button>
          </div>
        )
      })}
    </div>
  )
}
