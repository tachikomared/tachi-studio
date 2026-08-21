// apps/desktop/src/pages/nodes/sidebar/RevisionsDrawer.tsx
//
// REVISIONS drawer for one flow row in the flows rail (A1,
// NODES-RESEARCH-2026-07-26). Every save leaves a snapshot under
// `Flows/.history/<name>/<ts>.json`; this lists them newest-first with a
// change summary against the CURRENT state and a RESTORE per row.
//
// A flat list, NOT a second canvas — n8n's side-by-side diff is the expensive
// rendering of information users read as a change-count badge anyway.
//
// The counts are computed lazily, here, when the drawer opens: one
// readRevision + a pure diffFlows per entry (capped at 20 by the writer), so
// main stays a dumb file store that never needs the flow schema.
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { diffFlows, diffCounts, relativeAge, type FlowDiff, type FlowDiffCounts } from '../flowDiff'

interface RevisionRow {
  ts:      number
  savedAt: string
  size:    number
  /** null when the revision could not be read — the row still offers RESTORE. */
  diff:    FlowDiff | null
  counts:  FlowDiffCounts | null
}

interface Props {
  filename: string
  /** stableFlowJson-shaped state the counts are measured against: the LIVE
   *  canvas for the open flow, the file on disk for any other row. */
  getCurrentJson: () => Promise<string>
  onRestore: (ts: number) => void | Promise<void>
}

export function RevisionsDrawer({ filename, getCurrentJson, onRestore }: Props) {
  const { t } = useTranslation('nodes')
  const [rows, setRows]   = useState<RevisionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyTs, setBusyTs] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const listed = await window.tachi.nodes.listRevisions(filename)
      if (cancelled) return
      if (!listed.ok) { setError(listed.error ?? ''); setRows([]); return }
      const current = await getCurrentJson()
      if (cancelled) return
      const out: RevisionRow[] = []
      for (const rev of listed.revisions) {
        let diff: FlowDiff | null = null
        try {
          const one = await window.tachi.nodes.readRevision(filename, rev.ts)
          if (one.ok && typeof one.json === 'string') diff = diffFlows(one.json, current)
        } catch { /* a single unreadable snapshot must not kill the list */ }
        out.push({ ...rev, diff, counts: diff ? diffCounts(diff) : null })
      }
      if (!cancelled) setRows(out)
    })().catch(err => {
      if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setRows([]) }
    })
    return () => { cancelled = true }
  }, [filename, getCurrentJson])

  // "12m ago" / "3h ago" — a unit + count rendered through i18n, never a
  // pre-baked English string.
  const ageLabel = useCallback((ts: number) => {
    const { unit, count } = relativeAge(ts, Date.now())
    return unit === 'now' ? t('flowsRail.revisions.justNow') : t(`flowsRail.revisions.${unit}Ago`, { n: count })
  }, [t])

  // "+2 nodes, -1 edge, 3 params" — the same information n8n renders as two canvases.
  const summary = useCallback((counts: FlowDiffCounts | null) => {
    if (!counts) return t('flowsRail.revisions.unreadable')
    if (counts.total === 0) return t('flowsRail.revisions.identical')
    const parts: string[] = []
    if (counts.nodesAdded)   parts.push(t('flowsRail.revisions.nodesAdded',   { n: counts.nodesAdded }))
    if (counts.nodesRemoved) parts.push(t('flowsRail.revisions.nodesRemoved', { n: counts.nodesRemoved }))
    if (counts.edgesAdded)   parts.push(t('flowsRail.revisions.edgesAdded',   { n: counts.edgesAdded }))
    if (counts.edgesRemoved) parts.push(t('flowsRail.revisions.edgesRemoved', { n: counts.edgesRemoved }))
    if (counts.params)       parts.push(t('flowsRail.revisions.params',       { n: counts.params }))
    return parts.join(', ')
  }, [t])

  // The hover title NAMES the nodes, so "what exactly changed" never needs a
  // second canvas to answer.
  const detail = useCallback((row: RevisionRow) => {
    const lines = [new Date(row.ts).toLocaleString(), t('flowsRail.revisions.size', { n: Math.max(1, Math.round(row.size / 1024)) })]
    const d = row.diff
    if (d) {
      const name = (n: { label: string; id: string }) => n.label || n.id
      if (d.nodesAdded.length)   lines.push(`+ ${d.nodesAdded.map(name).join(', ')}`)
      if (d.nodesRemoved.length) lines.push(`- ${d.nodesRemoved.map(name).join(', ')}`)
      for (const n of d.nodesChanged) lines.push(`~ ${name(n)}: ${n.params.join(', ')}`)
    }
    return lines.join('\n')
  }, [t])

  const restore = useCallback(async (ts: number) => {
    setBusyTs(ts)
    try { await onRestore(ts) } finally { setBusyTs(null) }
  }, [onRestore])

  return (
    <div
      role="group"
      aria-label={t('flowsRail.revisions.title')}
      style={{
        borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-elevated)', padding: '2px 0',
      }}
    >
      <div style={{
        padding: '4px 8px 3px 11px', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--text-dim)',
      }}>
        {t('flowsRail.revisions.title')}
      </div>

      {rows === null && (
        <div style={drawerNote}>{t('flowsRail.revisions.loading')}</div>
      )}
      {rows !== null && rows.length === 0 && (
        <div style={drawerNote}>{error ? t('flowsRail.revisions.failed', { error }) : t('flowsRail.revisions.empty')}</div>
      )}

      {(rows ?? []).map(row => (
        <div
          key={row.ts}
          title={detail(row)}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 4,
            padding: '4px 6px 5px 11px',
            borderTop: 'var(--border-width) solid var(--border)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)' }}>
              {ageLabel(row.ts)}
            </span>
            <span style={{
              display: 'block', fontSize: 8, color: 'var(--text-dim)', lineHeight: 1.4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {summary(row.counts)}
            </span>
          </span>
          <button
            onClick={() => restore(row.ts)}
            disabled={busyTs !== null}
            title={t('flowsRail.revisions.restoreTitle')}
            // Every row's button reads "restore" — qualify it with WHICH
            // snapshot so the list isn't N identically-named controls.
            aria-label={t('flowsRail.rowActionAria', {
              action: t('flowsRail.revisions.restore'),
              name: ageLabel(row.ts),
              defaultValue: '{{action}} — {{name}}',
            })}
            style={{
              flexShrink: 0, border: 'var(--border-width) solid var(--border)', background: 'transparent',
              color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 4px',
              cursor: busyTs !== null ? 'wait' : 'pointer',
            }}
          >{t('flowsRail.revisions.restore')}</button>
        </div>
      ))}
    </div>
  )
}

const drawerNote: React.CSSProperties = {
  padding: '3px 8px 6px 11px', fontSize: 8, color: 'var(--text-dim)', lineHeight: 1.5,
}
