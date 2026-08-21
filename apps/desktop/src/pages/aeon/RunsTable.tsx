// apps/desktop/src/pages/aeon/RunsTable.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonRunSummary } from '../../types/electron'
import { RunDetailDrawer } from './RunDetailDrawer'
import { showToast } from '../../components/Toaster'

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
}

function statusDotColor(run: AeonRunSummary): string {
  if (run.status === 'queued') return 'var(--warning)'       // amber
  if (run.status === 'in_progress') return 'var(--info)'  // blue
  if (run.conclusion === 'success') return 'var(--success)'  // green
  if (run.conclusion === 'failure') return 'var(--destructive)'  // red
  if (run.conclusion === 'cancelled') return 'var(--text-dim)'
  return 'var(--text-dim)'
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function durationStr(run: AeonRunSummary): string {
  const start = new Date(run.created_at).getTime()
  const end = new Date(run.updated_at).getTime()
  const diffMs = end - start
  if (diffMs < 0 || run.status !== 'completed') return '—'
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

interface RunRowProps {
  run:           AeonRunSummary
  onOpen:        (run: AeonRunSummary) => void
  onRerun:       (run: AeonRunSummary) => void
  onDelete:      (run: AeonRunSummary) => void
  busyKind:      null | 'rerun' | 'delete'
  confirmDelete: boolean
}

function RunRow({ run, onOpen, onRerun, onDelete, busyKind, confirmDelete }: RunRowProps) {
  const { t } = useTranslation('aeon')
  const dotColor = statusDotColor(run)
  const canRerun = run.status === 'completed' && !busyKind

  return (
    <div style={{
      borderBottom: 'var(--border-width) solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      opacity: busyKind ? 0.6 : 1,
    }}>
      <button
        onClick={() => onOpen(run)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          padding: '6px 12px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        title={t('runs.row.openTitle')}
      >
        <div
          className={run.status === 'in_progress' ? 'tachi-pulse-dot' : undefined}
          style={{ width: 6, height: 6, background: dotColor, flexShrink: 0 }}
        />
        <span style={{
          flex: 1,
          fontSize: 11,
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={run.name}>
          {run.name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>
          {durationStr(run)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0, minWidth: 56, textAlign: 'right' }}>
          {relativeTime(run.created_at)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>▸</span>
      </button>
      <div style={{ display: 'flex', gap: 4, paddingRight: 8 }}>
        {canRerun && (
          <button
            onClick={() => onRerun(run)}
            disabled={!!busyKind}
            title={t('runs.rerunTitle')}
            style={{
              padding: '2px 8px',
              fontSize: 9,
              fontWeight: 700,
              border: '2px solid var(--accent)',
              background: 'transparent',
              color: 'var(--accent-text, var(--accent))',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              letterSpacing: '0.04em',
            }}
          >
            {t('runs.rerun')}
          </button>
        )}
        <button
          onClick={() => onDelete(run)}
          disabled={!!busyKind}
          title={confirmDelete ? t('runs.confirmDeleteTitle') : t('runs.deleteTitle')}
          style={{
            padding: '2px 8px',
            fontSize: 9,
            fontWeight: 700,
            border: `2px solid ${confirmDelete ? 'var(--destructive)' : 'var(--border)'}`,
            background: confirmDelete ? 'var(--destructive)' : 'transparent',
            color: confirmDelete ? '#fff' : 'var(--text-muted)',
            cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.04em',
          }}
        >
          {confirmDelete ? t('runs.sure') : '×'}
        </button>
      </div>
    </div>
  )
}

interface RunsTableProps {
  owner: string
  refreshSignal?: number
}

// ── Kanban view ─────────────────────────────────────────────────────────────

const KANBAN_COLUMNS: Array<{ key: 'todo' | 'running' | 'failed' | 'done'; label: string; color: string }> = [
  { key: 'todo',    label: 'Queued',  color: 'var(--warning)' },
  { key: 'running', label: 'Running', color: 'var(--accent)' },
  { key: 'failed',  label: 'Failed',  color: 'var(--danger)' },
  { key: 'done',    label: 'Done',    color: 'var(--success)' },
]

function kanbanBucket(run: AeonRunSummary): 'todo' | 'running' | 'failed' | 'done' {
  if (run.status === 'queued') return 'todo'
  if (run.status === 'in_progress') return 'running'
  if (run.conclusion === 'failure' || run.conclusion === 'cancelled') return 'failed'
  return 'done'
}

interface KanbanCardProps {
  run:      AeonRunSummary
  onOpen:   (r: AeonRunSummary) => void
  onRerun:  (r: AeonRunSummary) => void
  onDelete: (r: AeonRunSummary) => void
  busyKind: null | 'rerun' | 'delete'
  confirmDelete: boolean
}

function KanbanCard({ run, onOpen, onRerun, onDelete, busyKind, confirmDelete }: KanbanCardProps) {
  const { t } = useTranslation('aeon')
  const [hover, setHover] = useState(false)
  const isTerminal = run.status === 'completed' || run.status === 'queued' && false  // can always delete; rerun only meaningful when not currently running

  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/x-aeon-run-id', String(run.id))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(run)}
      style={{
        position: 'relative',
        border: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-soft)',
        padding: '6px 8px',
        fontFamily: 'JetBrains Mono, monospace',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        textAlign: 'left',
        cursor: 'grab',
        color: 'inherit',
        opacity: busyKind ? 0.6 : 1,
      }}
      title={t('runs.card.title')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span
          className={run.status === 'in_progress' ? 'tachi-pulse-dot' : undefined}
          style={{ width: 6, height: 6, background: statusDotColor(run), flexShrink: 0 }}
        />
        <span style={{
          flex: 1, fontSize: 11, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={run.name}>{run.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: 'var(--text-dim)' }}>
        <span>{durationStr(run)}</span>
        <span style={{ flex: 1 }} />
        <span>{relativeTime(run.created_at)}</span>
      </div>

      {/* Hover-revealed action chips. Stop propagation so clicking them
          doesn't bubble up to the open-detail handler on the card. */}
      {(hover || confirmDelete) && !busyKind && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            display: 'flex',
            gap: 2,
          }}
        >
          {run.status === 'completed' && (
            <button
              onClick={e => { e.stopPropagation(); onRerun(run) }}
              title={t('runs.card.rerunTitle')}
              style={{
                padding: '2px 6px',
                fontSize: 9,
                fontWeight: 700,
                border: '2px solid var(--accent)',
                background: 'var(--bg-surface)',
                color: 'var(--accent-text, var(--accent))',
                cursor: 'pointer',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.04em',
              }}
            >
              {t('runs.rerun')}
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(run) }}
            title={confirmDelete ? t('runs.card.confirmDeleteTitle') : t('runs.deleteTitle')}
            style={{
              padding: '2px 6px',
              fontSize: 9,
              fontWeight: 700,
              border: `2px solid ${confirmDelete ? 'var(--destructive)' : 'var(--border)'}`,
              background: confirmDelete ? 'var(--destructive)' : 'var(--bg-surface)',
              color: confirmDelete ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              letterSpacing: '0.04em',
            }}
          >
            {confirmDelete ? t('runs.sure') : '×'}
          </button>
        </div>
      )}
    </div>
  )
}

interface KanbanViewProps {
  runs:     AeonRunSummary[]
  onOpen:   (r: AeonRunSummary) => void
  onRerun:  (r: AeonRunSummary) => void
  onDelete: (r: AeonRunSummary) => void
  busy:     Record<number, 'rerun' | 'delete'>
  confirmDeleteId: number | null
  onDropToQueued: (runId: number) => void
}

function KanbanView({ runs, onOpen, onRerun, onDelete, busy, confirmDeleteId, onDropToQueued }: KanbanViewProps) {
  const { t } = useTranslation('aeon')
  const [dragOverTodo, setDragOverTodo] = useState(false)
  const buckets: Record<'todo' | 'running' | 'failed' | 'done', AeonRunSummary[]> = { todo: [], running: [], failed: [], done: [] }
  for (const r of runs) buckets[kanbanBucket(r)].push(r)
  return (
    <div style={{
      flex: 1, padding: 8, display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, overflow: 'auto',
    }}>
      {KANBAN_COLUMNS.map(col => {
        const isTodo = col.key === 'todo'
        const highlight = isTodo && dragOverTodo
        return (
          <div
            key={col.key}
            onDragOver={isTodo ? (e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }) : undefined}
            onDragEnter={isTodo ? (() => setDragOverTodo(true)) : undefined}
            onDragLeave={isTodo ? (() => setDragOverTodo(false)) : undefined}
            onDrop={isTodo ? (e => {
              e.preventDefault()
              setDragOverTodo(false)
              const idStr = e.dataTransfer.getData('application/x-aeon-run-id')
              const id = Number(idStr)
              if (id) onDropToQueued(id)
            }) : undefined}
            style={{
              display: 'flex', flexDirection: 'column',
              background: highlight ? 'var(--accent-muted, var(--bg-elevated))' : 'var(--bg-elevated)',
              border: `2px ${highlight ? 'dashed var(--accent)' : 'solid var(--border)'}`,
              transition: 'background 80ms linear',
            }}
          >
            <div style={{
              padding: '4px 8px',
              background: col.color,
              color: '#000',
              fontSize: 9, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em',
              fontFamily: 'JetBrains Mono, monospace',
              display: 'flex', alignItems: 'center', gap: 6,
              borderBottom: '2px solid var(--border)',
            }}>
              <span style={{ flex: 1 }}>{t(`runs.kanban.${col.key}`)}</span>
              <span style={{ background: 'rgba(0,0,0,0.2)', padding: '0 4px' }}>{buckets[col.key].length}</span>
            </div>
            <div style={{ flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
              {buckets[col.key].length === 0 && (
                <div style={{ padding: 6, fontSize: 9, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  {highlight ? t('runs.kanban.dropHint') : '—'}
                </div>
              )}
              {buckets[col.key].map(r => (
                <KanbanCard
                  key={r.id}
                  run={r}
                  onOpen={onOpen}
                  onRerun={onRerun}
                  onDelete={onDelete}
                  busyKind={busy[r.id] ?? null}
                  confirmDelete={confirmDeleteId === r.id}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function RunsTable({ owner, refreshSignal }: RunsTableProps) {
  const { t } = useTranslation('aeon')
  const [runs, setRuns] = useState<AeonRunSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'table' | 'kanban'>('kanban')
  const [openRun, setOpenRun] = useState<AeonRunSummary | null>(null)
  // Per-run busy state for action buttons (rerun/delete) so we can dim the
  // card and disable double-clicks while a GitHub API request is in flight.
  const [busy, setBusy] = useState<Record<number, 'rerun' | 'delete'>>({})
  // Two-click delete confirmation — first click arms; second click within
  // ~3s commits. Matches the ChatHistory delete pattern.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Keep the open drawer in sync with the latest run state from polling, so
  // status/conclusion updates live without the user having to reopen the modal.
  useEffect(() => {
    if (openRun) {
      const fresh = runs.find(r => r.id === openRun.id)
      if (fresh && (fresh.status !== openRun.status || fresh.conclusion !== openRun.conclusion)) {
        setOpenRun(fresh)
      }
    }
  }, [runs, openRun])

  const load = useCallback(async () => {
    if (!owner) return
    setLoading(true)
    setError(null)
    try {
      const list = await window.tachi.aeon.listRuns(owner, 20)
      setRuns(list)
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setLoading(false)
    }
  }, [owner])

  // Auto-poll while any run is in-flight
  useEffect(() => {
    const hasActive = runs.some(r => r.status === 'queued' || r.status === 'in_progress')
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(() => { load() }, 10_000)
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [runs, load])

  // Initial load + refresh on external signal
  useEffect(() => { load() }, [load, refreshSignal])

  // ── Action handlers ───────────────────────────────────────────────────────
  const setRunBusy = useCallback((id: number, kind: 'rerun' | 'delete' | null) => {
    setBusy(b => {
      const next = { ...b }
      if (kind) next[id] = kind
      else delete next[id]
      return next
    })
  }, [])

  const handleRerun = useCallback(async (run: AeonRunSummary) => {
    setRunBusy(run.id, 'rerun')
    try {
      await window.tachi.aeon.rerunRun(owner, run.id)
      showToast({ kind: 'success', text: t('runs.toast.rerunning', { name: run.name }) })
      // Optimistically push the card into "running" so the kanban moves
      // immediately. Real state will land on the next poll.
      setRuns(rs => rs.map(r => r.id === run.id
        ? { ...r, status: 'in_progress', conclusion: null }
        : r))
      // Re-arm the poller right away in case it had stopped
      load()
    } catch (err: any) {
      showToast({ kind: 'error', text: t('runs.toast.rerunFailed', { error: err?.message ?? err }) })
    } finally {
      setRunBusy(run.id, null)
    }
  }, [owner, load, setRunBusy, t])

  const handleDelete = useCallback(async (run: AeonRunSummary) => {
    // First click: arm the confirm UI. Second click: actually delete.
    if (confirmDeleteId !== run.id) {
      setConfirmDeleteId(run.id)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000)
      return
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmDeleteId(null)
    setRunBusy(run.id, 'delete')
    try {
      await window.tachi.aeon.deleteRun(owner, run.id)
      showToast({ kind: 'success', text: t('runs.toast.deleted', { name: run.name }) })
      setRuns(rs => rs.filter(r => r.id !== run.id))
    } catch (err: any) {
      showToast({ kind: 'error', text: t('runs.toast.deleteFailed', { error: err?.message ?? err }) })
    } finally {
      setRunBusy(run.id, null)
    }
  }, [owner, confirmDeleteId, setRunBusy, t])

  const handleDropToQueued = useCallback((id: number) => {
    const run = runs.find(r => r.id === id)
    if (!run) return
    if (run.status === 'in_progress' || run.status === 'queued') {
      showToast({ kind: 'info', text: t('runs.toast.alreadyRunning') })
      return
    }
    handleRerun(run)
  }, [runs, handleRerun, t])

  // Clean up the confirm timer on unmount
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [])

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span>{t('runs.header')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['kanban', 'table'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '3px 8px',
                border: '2px solid var(--border)',
                background: view === v ? 'var(--accent-muted)' : 'transparent',
                color: view === v ? 'var(--accent-text)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9,
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >{v}</button>
          ))}
        </div>
        <button
          onClick={load}
          style={{
            padding: '3px 8px',
            border: 'var(--border-width) solid var(--border)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
          }}
          title={t('runs.refresh')}
        >
          ⟳
        </button>
      </div>

      {error && (
        <div style={{
          padding: '6px 12px',
          fontSize: 11,
          color: 'var(--destructive)',
          fontFamily: 'JetBrains Mono, monospace',
          borderBottom: 'var(--border-width) solid var(--border)',
          flexShrink: 0,
        }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {loading && runs.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {t('runs.loading')}
          </div>
        )}
        {!loading && runs.length === 0 && !error && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {t('runs.empty')}
          </div>
        )}
        {runs.length > 0 && view === 'kanban' && (
          <KanbanView
            runs={runs}
            onOpen={setOpenRun}
            onRerun={handleRerun}
            onDelete={handleDelete}
            busy={busy}
            confirmDeleteId={confirmDeleteId}
            onDropToQueued={handleDropToQueued}
          />
        )}
        {runs.length > 0 && view === 'table' && runs.map(run => (
          <RunRow
            key={run.id}
            run={run}
            onOpen={setOpenRun}
            onRerun={handleRerun}
            onDelete={handleDelete}
            busyKind={busy[run.id] ?? null}
            confirmDelete={confirmDeleteId === run.id}
          />
        ))}
      </div>

      <RunDetailDrawer owner={owner} run={openRun} onClose={() => setOpenRun(null)} />
    </div>
  )
}
