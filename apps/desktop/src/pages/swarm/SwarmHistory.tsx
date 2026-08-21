// apps/desktop/src/pages/swarm/SwarmHistory.tsx
//
// Past-run history for the swarm (STEAL 2026-06-21 #15, CodexMonitor). Renders
// the terminal runs from the live `runs` slice as newest-first cards — the board
// only shows current state; this is the audit trail (outcome, duration, cost,
// commits) the SwarmPage previously lacked. Pure presentation; ordering lives in
// swarmHistory.ts.

import React, { useMemo } from 'react'
import type { SwarmRun } from '../../store/swarm.store'
import { sortRunsForHistory, formatRunDuration } from './runHistory'

const STATE_COLOR: Record<SwarmRun['state'], string> = {
  running:   'var(--text-dim)',
  completed: 'var(--accent)',
  failed:    'var(--danger, #ff5252)',
  cancelled: 'var(--text-dim)',
}

export function SwarmHistory({ runs }: { runs: SwarmRun[] }) {
  const history = useMemo(() => sortRunsForHistory(runs), [runs])

  if (history.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
      }}>
        No completed runs yet — dispatch a task from the board.
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column',
      gap: 8, fontFamily: 'JetBrains Mono, monospace',
    }}>
      {history.map((r) => {
        const dur = formatRunDuration(r)
        return (
          <div key={r.id} style={{
            border: '2px solid var(--border)', background: 'var(--bg-surface)', padding: 10,
            display: 'flex', flexDirection: 'column', gap: 4, boxShadow: 'var(--shadow-hard)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                padding: '1px 6px', border: `2px solid ${STATE_COLOR[r.state]}`, color: STATE_COLOR[r.state],
              }}>{r.state}</span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.task}>{r.task}</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{r.agent}</span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
              <span>{new Date(r.finished_at || r.started_at).toLocaleString()}</span>
              {dur && <span>· {dur}</span>}
              {r.attempt > 1 && <span>· attempt {r.attempt}</span>}
              {typeof r.tokens === 'number' && <span>· {r.tokens.toLocaleString()} tok</span>}
              {typeof r.cost_usd === 'number' && <span>· ${r.cost_usd.toFixed(4)}</span>}
              {r.commits.length > 0 && <span>· {r.commits.length} commit{r.commits.length === 1 ? '' : 's'}</span>}
              {r.artifacts.length > 0 && <span>· {r.artifacts.length} artifact{r.artifacts.length === 1 ? '' : 's'}</span>}
            </div>
            {r.error && (
              <div style={{ fontSize: 10, color: 'var(--danger, #ff5252)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>
                {r.error}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
