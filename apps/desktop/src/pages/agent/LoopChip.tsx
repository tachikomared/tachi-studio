// apps/desktop/src/pages/agent/LoopChip.tsx
//
// LOOP MODE — the Code tab's cycle indicator.
//
// A `/loop` run is ONE run to the user, made of N cycles the controller decides
// between. Without a surface, a loop looks like a run that keeps talking after
// it said it was done. This is that surface: which cycle is in flight, out of
// how many, the goal on hover — and the one control that matters, STOP LOOP,
// which lets the current cycle finish and declines to start another (the STOP
// button next to it stays the hard abort).
//
// Purely presentational + self-contained; the store owns when it appears (a
// `loop` event) and disappears (`loop-ended`, or any terminal event).

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../../store/agent.store'

export function LoopChip(): React.ReactElement | null {
  const { t } = useTranslation('agent')
  const loop = useAgentStore(s => s.loop)
  const sessionId = useAgentStore(s => s.sessionId)
  const [stopping, setStopping] = useState(false)

  if (!loop) return null

  const stopLoop = async (): Promise<void> => {
    if (!sessionId || stopping) return
    setStopping(true)
    try { await window.tachi.agent.stopLoop(sessionId) } catch { /* the run may have just ended */ }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '3px 8px',
        border: 'var(--border-width) solid var(--accent)',
        background: 'var(--bg-inset)',
        color: 'var(--accent)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
      title={t('loop.goal', { goal: loop.goal, defaultValue: 'Loop goal: {{goal}}' })}
    >
      <span aria-hidden style={{ fontSize: 12 }}>↻</span>
      <span>{t('loop.cycle', { iteration: loop.iteration, cap: loop.cap, defaultValue: 'Loop {{iteration}}/{{cap}}' })}</span>
      <button
        type="button"
        onClick={() => { void stopLoop() }}
        disabled={stopping || !sessionId}
        style={{
          padding: '1px 6px',
          border: 'var(--border-width) solid var(--danger, #ff5252)',
          background: 'transparent',
          color: 'var(--danger, #ff5252)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: stopping || !sessionId ? 'default' : 'pointer',
          opacity: stopping || !sessionId ? 0.5 : 1,
        }}
        title={t('loop.stopHint', { defaultValue: 'Finish this cycle, then stop looping' })}
      >
        {stopping
          ? t('loop.stopping', { defaultValue: 'Stopping…' })
          : t('loop.stop', { defaultValue: 'Stop loop' })}
      </button>
    </div>
  )
}
