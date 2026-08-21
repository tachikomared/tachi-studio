// apps/desktop/src/pages/inbox/InboxView.tsx
//
// PRIVATE MODE (Tier 4) — silent inbox for agent tool-permission requests.
//
// Lifecycle:
//   1. On mount, subscribe to window.tachi.inbox.onPush so new requests
//      land in the renderer store (`useCapabilityStore.enqueue`).
//   2. Also subscribe to onResolve so a decision made in another window
//      (or a server-side cancel) reflects in this view.
//   3. Call inbox.list() once to seed the store with any requests that
//      came in before this view mounted (mode flipped to inbox earlier
//      in the session).
//   4. Keyboard nav (j/k/Enter/Backspace/Ctrl+A) drives the list without
//      requiring a mouse.

import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapabilityStore } from '../../store/capability.store'
import type { CapabilityRequest, CapabilityMode } from '../../store/capability.store'
import type { CapabilityRequestPayload } from '../../types/electron'
import { InboxItem } from './InboxItem'

/** Bridge to the main process via the preload-exposed inbox API. */
function inboxBridge() {
  return (window as unknown as {
    tachi?: {
      inbox?: {
        setMode: (m: CapabilityMode) => Promise<unknown>
        list: () => Promise<{ requests: CapabilityRequestPayload[] }>
        approve: (id: string) => Promise<unknown>
        deny: (id: string) => Promise<unknown>
        onPush: (cb: (req: CapabilityRequestPayload) => void) => () => void
        onResolve: (cb: (p: { id: string; decision: 'allow' | 'deny' }) => void) => () => void
      }
    }
  }).tachi?.inbox
}

export function InboxView() {
  const { t } = useTranslation('inbox')
  const mode    = useCapabilityStore(s => s.mode)
  const queue   = useCapabilityStore(s => s.queue)
  const setMode = useCapabilityStore(s => s.setMode)
  const enqueue = useCapabilityStore(s => s.enqueue)
  const resolve = useCapabilityStore(s => s.resolve)
  const clearResolved = useCapabilityStore(s => s.clearResolved)

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // ── Push subscription + initial snapshot ───────────────────────────────
  // Pre-existing requests in the main queue (e.g. user toggled mode->inbox
  // earlier this session and immediately navigated here) are fetched once
  // on mount via inbox.list(). After that we only need the push channel.
  useEffect(() => {
    const bridge = inboxBridge()
    if (!bridge) return

    bridge.list().then(({ requests }) => {
      for (const r of requests) {
        // Only enqueue if not already in the store — list() returns the
        // full main-side snapshot and may overlap with what we already have
        // from prior push events.
        if (!useCapabilityStore.getState().queue.some(q => q.id === r.id)) {
          enqueue({ ...r, status: 'pending' })
        }
      }
    }).catch(() => { /* main not ready — ignore */ })

    const offPush = bridge.onPush((req) => {
      // Guard against duplicate enqueue if push arrived before the list()
      // hydration completed. (Promise scheduling means list()'s setState
      // can land after the first push event for a given id.)
      if (!useCapabilityStore.getState().queue.some(q => q.id === req.id)) {
        enqueue({ ...req, status: 'pending' })
      }
    })
    const offResolve = bridge.onResolve(({ id, decision }) => {
      resolve(id, decision === 'allow' ? 'approved' : 'denied')
    })

    return () => {
      offPush()
      offResolve()
    }
  }, [enqueue, resolve])

  // Auto-focus the first pending row on mount so j/k works immediately.
  useEffect(() => {
    if (focusedId !== null) return
    const firstPending = queue.find(r => r.status === 'pending')
    if (firstPending) setFocusedId(firstPending.id)
  }, [queue, focusedId])

  // ── Mutations ──────────────────────────────────────────────────────────
  // Local store transition + main-side decision in parallel. The push
  // resolve event will land too (echo from main), but resolve() is
  // idempotent on the same id+status so the double-call is a no-op.
  const approveOne = useCallback((id: string) => {
    const bridge = inboxBridge()
    resolve(id, 'approved')
    bridge?.approve(id).catch(() => { /* ignore — agent already moved on */ })
  }, [resolve])

  const denyOne = useCallback((id: string) => {
    const bridge = inboxBridge()
    resolve(id, 'denied')
    bridge?.deny(id).catch(() => { /* ignore — agent already moved on */ })
  }, [resolve])

  const pending = useMemo(() => queue.filter(r => r.status === 'pending'), [queue])

  const approveAll = useCallback(() => {
    for (const r of pending) approveOne(r.id)
  }, [pending, approveOne])

  // ── Keyboard navigation ────────────────────────────────────────────────
  // j/k move focus between pending items. Enter = approve focused.
  // Backspace/Delete = deny focused. Cmd/Ctrl+A = approve all pending.
  // We listen on window so the inbox doesn't need an explicit focused
  // element (the list-item itself never gains DOM focus).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't hijack typing in a future search box / mode toggle button.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        approveAll()
        return
      }

      // For j/k we operate only on pending rows — resolved rows are read-only.
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (pending.length === 0) return
        const idx = focusedId === null ? -1 : pending.findIndex(r => r.id === focusedId)
        const next = pending[Math.min(idx + 1, pending.length - 1)]
        if (next) setFocusedId(next.id)
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (pending.length === 0) return
        const idx = focusedId === null ? pending.length : pending.findIndex(r => r.id === focusedId)
        const prev = pending[Math.max(idx - 1, 0)]
        if (prev) setFocusedId(prev.id)
        return
      }
      if (e.key === 'Enter') {
        if (focusedId) {
          e.preventDefault()
          approveOne(focusedId)
        }
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (focusedId) {
          e.preventDefault()
          denyOne(focusedId)
        }
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusedId, pending, approveOne, denyOne, approveAll])

  // ── Styling ────────────────────────────────────────────────────────────
  const pageStyle: React.CSSProperties = {
    height: '100%',
    background: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace',
    display: 'flex',
    flexDirection: 'column',
  }

  const headerStyle: React.CSSProperties = {
    padding: '14px 18px',
    borderBottom: '2px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  }

  const modeButton = (m: CapabilityMode, label: string): React.CSSProperties => {
    const selected = mode === m
    return {
      padding: '4px 10px',
      border: '2px solid var(--border-strong, var(--border))',
      background: selected ? 'var(--accent-muted, var(--accent))' : 'var(--bg-elevated, transparent)',
      color: selected ? 'var(--accent-text, #ffffff)' : 'var(--text-muted)',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10,
      fontWeight: selected ? 700 : 400,
      letterSpacing: '0.08em',
      cursor: 'pointer',
      textTransform: 'uppercase',
    }
  }

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em' }}>
          {t('header.title')}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {t('header.pending', { count: pending.length })}
        </span>
        <div style={{ flex: 1 }} />

        <button
          type="button"
          onClick={approveAll}
          disabled={pending.length === 0}
          style={{
            padding: '4px 10px',
            border: '2px solid var(--accent)',
            background: pending.length === 0 ? 'transparent' : 'var(--accent)',
            color: pending.length === 0 ? 'var(--text-muted)' : '#ffffff',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            cursor: pending.length === 0 ? 'not-allowed' : 'pointer',
            textTransform: 'uppercase',
          }}
        >
          {t('actions.approveAll')}
        </button>

        <button
          type="button"
          onClick={() => clearResolved()}
          style={{
            padding: '4px 10px',
            border: '2px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.08em',
            cursor: 'pointer',
            textTransform: 'uppercase',
          }}
        >
          {t('actions.clearResolved')}
        </button>
      </div>

      {/* List */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {queue.length === 0 ? (
          <EmptyState mode={mode} />
        ) : (
          queue.map((r: CapabilityRequest) => (
            <InboxItem
              key={r.id}
              request={r}
              focused={r.id === focusedId}
              onFocus={() => setFocusedId(r.id)}
              onApprove={() => approveOne(r.id)}
              onDeny={() => denyOne(r.id)}
            />
          ))
        )}
      </div>

      {/* Footer — mode toggle + keyboard hints */}
      <div
        style={{
          borderTop: '2px solid var(--border)',
          padding: '10px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexShrink: 0,
          background: 'var(--bg-elevated, transparent)',
          fontSize: 10,
        }}
      >
        <span style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>{t('footer.modeLabel')}</span>
        <button
          type="button"
          onClick={() => setMode('immediate')}
          style={modeButton('immediate', 'IMMEDIATE')}
        >
          {t('footer.mode.immediate')}
        </button>
        <button
          type="button"
          onClick={() => setMode('inbox')}
          style={modeButton('inbox', 'INBOX')}
        >
          {t('footer.mode.inbox')}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>
          {t('footer.hints')}
        </span>
      </div>
    </div>
  )
}

function EmptyState({ mode }: { mode: CapabilityMode }) {
  const { t } = useTranslation('inbox')
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        color: 'var(--text-muted)',
        padding: 40,
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: 'var(--text-primary)',
        }}
      >
        {t('empty.title')}
      </div>
      <div
        style={{
          maxWidth: 520,
          textAlign: 'center',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {mode === 'inbox'
          ? t('empty.inbox')
          : t('empty.immediate')}
      </div>
    </div>
  )
}
