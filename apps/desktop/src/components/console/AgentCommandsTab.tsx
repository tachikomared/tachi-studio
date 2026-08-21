import React, { useState, useEffect } from 'react'
import { AgentCommandEvent, AgentCommandStatus } from '@tachi/core'

const STATUS_COLOR: Record<AgentCommandStatus, string> = {
  proposed:             'var(--warning)',
  waiting_for_approval: 'var(--warning)',
  approved:             'var(--accent)',
  rejected:             'var(--danger)',
  running:              'var(--accent-alt)',
  succeeded:            'var(--accent)',
  failed:               'var(--danger)',
  cancelled:            'var(--text-muted)',
}

export function AgentCommandsTab() {
  const [events, setEvents] = useState<AgentCommandEvent[]>([])

  useEffect(() => {
    const off = window.tachi.commands.onEvent(e => {
      setEvents(prev => [e, ...prev].slice(0, 200))
    })
    return off
  }, [])

  if (events.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        No agent commands yet. Commands proposed or run by AI agents appear here.
      </div>
    )
  }

  return (
    <div style={{ overflowY: 'auto', height: '100%', fontFamily: 'monospace', fontSize: 12 }}>
      {events.map(e => (
        <div key={e.id} style={{ padding: '6px 12px', borderBottom: 'var(--border-width) solid var(--border)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ color: STATUS_COLOR[e.status] ?? 'var(--text-muted)', minWidth: 80 }}>{e.status}</span>
          <span style={{ color: 'var(--text-primary)', flex: 1 }}>{e.command}</span>
          {e.runtimeId && <span style={{ color: 'var(--text-muted)' }}>{e.runtimeId}</span>}
        </div>
      ))}
    </div>
  )
}
