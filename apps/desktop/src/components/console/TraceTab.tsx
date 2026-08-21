// apps/desktop/src/components/console/TraceTab.tsx
//
// RUN-TRACE VIEWER — brutalist timeline/tree of recorded spans.
//
// Renders the run-trace.store span forest as an indented tree. Each row shows
// a kind-colored bar positioned + scaled against the whole-trace window, plus
// the span name and duration. In-flight spans pulse and stretch their bar to
// "now". A live ticker re-renders ~5x/sec so open spans keep growing.
//
// No external deps; pure store reads. The pulse animation is guarded by
// prefers-reduced-motion (the .tachi-trace-live class is defined in globals).

import React, { useEffect, useMemo, useState } from 'react'
import {
  useRunTraceStore,
  buildSpanTree,
  traceBounds,
  formatDuration,
  KIND_COLOR,
  type SpanKind,
  type SpanNode,
} from '../../store/run-trace.store'
import { ToolCallRow } from '../ToolCallRow'

const KIND_LABEL: Record<SpanKind, string> = {
  llm: 'LLM', tool: 'TOOL', agent: 'AGENT', phase: 'PHASE',
}

/** Flatten the forest into render rows (depth carried on each node). */
function flatten(nodes: SpanNode[], out: SpanNode[] = []): SpanNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children.length) flatten(n.children, out)
  }
  return out
}

export function TraceTab() {
  const spans = useRunTraceStore((s) => s.spans)
  const clear = useRunTraceStore((s) => s.clear)
  const [filterKind, setFilterKind] = useState<'all' | SpanKind>('all')

  // Live ticker: only runs while at least one span is still open, so an idle
  // trace doesn't burn render cycles.
  const hasOpen = useMemo(() => spans.some((s) => s.endedAt === undefined), [spans])
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!hasOpen) return
    const h = setInterval(() => setTick((t) => t + 1), 200)
    return () => clearInterval(h)
  }, [hasOpen])

  const now = Date.now()
  const tree = useMemo(() => buildSpanTree(spans), [spans])
  const rows = useMemo(() => flatten(tree), [tree])
  const bounds = useMemo(() => traceBounds(spans, now), [spans, now])
  const totalMs = bounds ? Math.max(1, bounds.end - bounds.start) : 1

  const visibleRows = filterKind === 'all' ? rows : rows.filter((r) => r.kind === filterKind)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '4px 8px', borderBottom: 'var(--border-width) solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value as 'all' | SpanKind)}
          style={{
            background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-muted)',
            fontSize: 11, borderRadius: 0, padding: '2px 6px',
          }}
        >
          <option value="all">All kinds</option>
          {(['llm', 'tool', 'agent', 'phase'] as SpanKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>

        {/* Legend — kind → color key. */}
        <div style={{ display: 'flex', gap: 10, flex: 1, fontSize: 10, color: 'var(--text-muted)' }}>
          {(['llm', 'tool', 'agent', 'phase'] as SpanKind[]).map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, background: KIND_COLOR[k], border: 'var(--border-width) solid var(--border-strong)', display: 'inline-block' }} />
              {KIND_LABEL[k]}
            </span>
          ))}
        </div>

        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{spans.length} span{spans.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => clear()}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 0, border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', cursor: 'pointer' }}
        >Clear</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {visibleRows.length === 0 && (
          <div style={{ padding: 16, color: 'var(--text-muted)' }}>
            No spans recorded yet. Run a flow or chat to populate the trace.
          </div>
        )}
        {visibleRows.map((node) => {
          const open = node.endedAt === undefined
          const spanStart = node.startedAt
          const spanEnd = node.endedAt ?? now
          const offsetPct = bounds ? ((spanStart - bounds.start) / totalMs) * 100 : 0
          const widthPct = bounds ? Math.max(1.5, ((spanEnd - spanStart) / totalMs) * 100) : 1.5
          const color = KIND_COLOR[node.kind]
          return (
            <ToolCallRow
              key={node.id}
              name={node.name}
              title={node.name}
              status={open ? 'running' : 'ok'}
              indent={node.depth * 14}
              nameMinWidth={200}
              durationText={formatDuration(node, now)}
              durationColor={open ? color : 'var(--text-muted)'}
              /* Kind label — colored micro-text, not a filled chip. */
              leading={<span style={{ fontSize: 9, color, fontWeight: 700, minWidth: 38 }}>{KIND_LABEL[node.kind]}</span>}
              /* Timeline track + scaled bar occupies the flex:1 middle. */
              argsPreview={
                <div style={{ flex: 1, position: 'relative', height: 12, background: 'var(--bg-inset)', border: 'var(--border-width) solid var(--border)' }}>
                  <div
                    className={open ? 'tachi-trace-live' : undefined}
                    style={{
                      position: 'absolute', top: 1, bottom: 1,
                      left: `${offsetPct}%`, width: `${widthPct}%`,
                      background: color,
                      border: 'var(--border-width) solid var(--border-strong)',
                      boxShadow: 'var(--shadow-hard)',
                    }}
                    title={`${node.name} — ${formatDuration(node, now)}`}
                  />
                </div>
              }
            />
          )
        })}
      </div>
    </div>
  )
}
