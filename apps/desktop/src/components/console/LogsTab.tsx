import React, { useState, useEffect, useMemo } from 'react'
import { LogEvent } from '@tachi/core'

const LEVEL_COLOR: Record<string, string> = {
  debug: 'var(--text-muted)', info: 'var(--text-primary)',
  warn: 'var(--warning)', error: 'var(--danger)',
}

export function LogsTab() {
  const [events, setEvents] = useState<LogEvent[]>([])
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const off = window.tachi.logs.onEvent(e => {
      setEvents(prev => [e, ...prev].slice(0, 1000))
    })
    return off
  }, [])

  const filtered = useMemo(() => {
    const lower = search.toLowerCase()
    return events.filter(e =>
      (filterLevel === 'all' || e.level === filterLevel) &&
      (!search || e.message.toLowerCase().includes(lower))
    )
  }, [events, filterLevel, search])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '4px 8px', borderBottom: 'var(--border-width) solid var(--border)', display: 'flex', gap: 8 }}>
        <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} style={{
          background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-muted)',
          fontSize: 11, borderRadius: 0, padding: '2px 6px',
        }}>
          <option value="all">All levels</option>
          {['debug','info','warn','error'].map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{
          flex: 1, background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)',
          fontSize: 11, borderRadius: 0, padding: '2px 8px',
        }} />
        <button onClick={() => setEvents([])} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 0, border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', cursor: 'pointer' }}>Clear</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
        {filtered.length === 0 && <div style={{ padding: 16, color: 'var(--text-muted)' }}>No log events.</div>}
        {filtered.map(e => (
          <div key={e.id} style={{ padding: '3px 10px', display: 'flex', gap: 10, borderBottom: 'var(--border-width) solid var(--border)' }}>
            <span style={{ color: 'var(--text-muted)', minWidth: 60 }}>{e.ts.slice(11,19)}</span>
            <span style={{ color: LEVEL_COLOR[e.level], minWidth: 40 }}>{e.level}</span>
            <span style={{ color: 'var(--text-muted)', minWidth: 80 }}>{e.category}</span>
            <span style={{ color: 'var(--text-primary)' }}>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
