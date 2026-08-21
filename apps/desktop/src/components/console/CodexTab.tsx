// Console dock — CODEX tab: the Codex worker's run journal, live.
//
// The user's ask, verbatim: codex activity must show in OUR console (the app
// has a Console dock — no hidden child windows, no guessing what the worker
// is doing). Snapshot via codex.getLog(), then live lines via onLogEvent.
// Brutalist mono feed; colors per line kind; auto-scroll pinned to bottom
// unless the user scrolled up.
import React, { useEffect, useRef, useState } from 'react'

interface CodexLogLine {
  at: number
  runId: string
  kind: 'start' | 'progress' | 'answer' | 'error' | 'exit'
  text: string
}

const KIND_COLOR: Record<CodexLogLine['kind'], string> = {
  start:    'var(--accent)',
  progress: 'var(--text-muted)',
  answer:   'var(--success)',
  error:    'var(--danger)',
  exit:     'var(--text-dim)',
}

export function CodexTab() {
  const [lines, setLines] = useState<CodexLogLine[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    let alive = true
    window.tachi.codex.getLog().then(l => { if (alive) setLines(l) }).catch(() => {})
    const off = window.tachi.codex.onLogEvent(line => {
      setLines(prev => {
        const next = [...prev, line]
        return next.length > 600 ? next.slice(-600) : next
      })
    })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        flex: 1, overflowY: 'auto', padding: '8px 12px',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, lineHeight: 1.6,
        background: 'var(--bg-inset)',
      }}
    >
      {lines.length === 0 && (
        <div style={{ color: 'var(--text-dim)' }}>
          No Codex runs yet this session. Delegations from the CODE agent (codex_worker / codex_review) and @codex chats stream here.
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>
            {new Date(l.at).toLocaleTimeString()} {l.runId}
          </span>
          <span style={{ color: KIND_COLOR[l.kind], flexShrink: 0, textTransform: 'uppercase', fontSize: 9, fontWeight: 700, lineHeight: 2 }}>
            {l.kind}
          </span>
          <span style={{ color: l.kind === 'progress' ? 'var(--text-muted)' : 'var(--text-primary)' }}>{l.text}</span>
        </div>
      ))}
    </div>
  )
}
