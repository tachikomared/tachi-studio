// apps/desktop/src/pages/agent/ReconnectBanner.tsx
//
// CONNECTION RESILIENCE — the Code tab's reconnect status line.
//
// When a run's model stream dies on a transport blip the harness does NOT end
// the run: it waits out a backoff and re-requests the same round. Without a
// surface for that, the app just looks frozen — which is exactly the "hard
// error" feeling this whole feature exists to remove. This renders the live
// state instead: which attempt we are on, out of how many, and a ticking
// countdown to the next try, right next to the run's status badge.
//
// Purely presentational + self-contained (its own 1s ticker); the store owns
// when it appears and disappears.

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../../store/agent.store'

export function ReconnectBanner(): React.ReactElement | null {
  const { t } = useTranslation('agent')
  const reconnect = useAgentStore(s => s.reconnect)
  // Remaining wait, recomputed each second from when this attempt was announced.
  const [remainingMs, setRemainingMs] = useState(0)

  useEffect(() => {
    if (!reconnect) { setRemainingMs(0); return }
    const startedAt = Date.now()
    setRemainingMs(reconnect.delayMs)
    const id = setInterval(() => {
      setRemainingMs(Math.max(0, reconnect.delayMs - (Date.now() - startedAt)))
    }, 500)
    return () => clearInterval(id)
    // A NEW attempt (or a new delay) restarts the countdown.
  }, [reconnect?.attempt, reconnect?.delayMs, reconnect])

  if (!reconnect) return null
  const seconds = Math.ceil(remainingMs / 1000)

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '3px 8px',
        border: 'var(--border-width) solid var(--warning, var(--accent-alt))',
        background: 'var(--bg-inset)',
        color: 'var(--warning, var(--accent-alt))',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
      title={t('reconnect.reason', { reason: reconnect.reason, defaultValue: 'Cause: {{reason}}' })}
    >
      <span aria-hidden style={{ fontSize: 12 }}>⟳</span>
      <span>
        {t('reconnect.retrying', {
          attempt: reconnect.attempt,
          max: reconnect.maxAttempts,
          defaultValue: 'Connection lost — retrying {{attempt}}/{{max}}',
        })}
      </span>
      {seconds > 0 && (
        <span style={{ color: 'var(--text-muted)' }}>
          {t('reconnect.nextIn', { seconds, defaultValue: 'next in {{seconds}}s' })}
        </span>
      )}
    </div>
  )
}
