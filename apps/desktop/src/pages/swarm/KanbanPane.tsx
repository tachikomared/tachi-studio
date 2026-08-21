// apps/desktop/src/pages/swarm/KanbanPane.tsx
//
// Center pane of the SwarmPage: tasks board, one column per GnapTaskState.
//
// V1 simplifications (intentional):
//  - No drag-and-drop. Card tap opens an action sheet ("Mark in_progress /
//    review / done / blocked / cancel") rendered inline as a popover.
//  - No inline edit of task description. Tap a card -> detail modal shows
//    the full body, comments list, and a [CLOSE] button.
//  - No creation flow yet. There's a [+ NEW TASK] button at the bottom of
//    the BACKLOG column that opens a tiny inline form (title + desc).
//
// State transitions go through window.tachi.gnap.updateTaskState() — the
// caller passes a `by` agent id. We default that to the first agent in the
// roster; if there isn't one, we use the special id "viewer" so the call
// still succeeds (the protocol doesn't enforce membership for state
// changes, just records authorship in the commit message).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GnapTaskState } from '../../types/electron'
import type { SwarmAgent, SwarmTask } from '../../store/swarm.store'

/** Approx max height the action sheet can reach (used for flip-above check). */
const ACTION_SHEET_MAX_HEIGHT = 220
/** Width we render the action sheet at when positioned with `fixed`. */
const ACTION_SHEET_WIDTH = 200
/** Gap (px) between the card and the action sheet. */
const ACTION_SHEET_GAP = 2

interface KanbanPaneProps {
  tasks:       SwarmTask[]
  agents:      SwarmAgent[]
  activeRepo:  string | null
  onChanged?:  () => void
}

const COLUMNS: { state: GnapTaskState; label: string }[] = [
  { state: 'backlog',     label: 'BACKLOG'     },
  { state: 'ready',       label: 'READY'       },
  { state: 'in_progress', label: 'IN_PROGRESS' },
  { state: 'review',      label: 'REVIEW'      },
  { state: 'done',        label: 'DONE'        },
  { state: 'blocked',     label: 'BLOCKED'     },
  { state: 'cancelled',   label: 'CANCELLED'   },
]

/** All task states we offer as targets in the action sheet. */
const TRANSITION_TARGETS: GnapTaskState[] = [
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled',
]

function genId(prefix: string): string {
  const ts   = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, '0')
  return `${prefix}-${ts}-${rand}`
}

function stateColor(state: GnapTaskState): string {
  if (state === 'done')        return 'var(--success, #4ade80)'
  if (state === 'in_progress') return 'var(--accent)'
  if (state === 'review')      return 'var(--warning, #f59e0b)'
  if (state === 'blocked')     return 'var(--danger, #ff5252)'
  if (state === 'cancelled')   return 'var(--text-dim)'
  return 'var(--text-muted)'
}

export function KanbanPane({ tasks, agents, activeRepo, onChanged }: KanbanPaneProps) {
  const { t } = useTranslation('swarm')
  const [actionForId, setActionForId] = useState<string | null>(null)
  // Position of the open action sheet, in viewport coords. Computed from the
  // card's bounding rect at click time. `placeAbove` is true when there isn't
  // enough room below the card to render the full sheet, so we flip it up.
  const [actionPos,   setActionPos]   = useState<{ top: number; left: number; placeAbove: boolean } | null>(null)
  const [detailFor,   setDetailFor]   = useState<SwarmTask | null>(null)
  const [creating,    setCreating]    = useState(false)
  const [draftTitle,  setDraftTitle]  = useState('')
  const [draftDesc,   setDraftDesc]   = useState('')
  const [busy,        setBusy]        = useState(false)
  const [runningId,   setRunningId]   = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  // Ref on the open sheet element so the click-outside listener can ignore
  // clicks inside it (mousedown bubbles to document before React click fires).
  const sheetRef = useRef<HTMLDivElement | null>(null)

  // Click-outside dismissal for the action sheet. We listen on `mousedown` at
  // the document level so a click anywhere outside the sheet closes it. Clicks
  // *inside* the sheet are ignored via the ref check. We bail out cheaply if
  // no sheet is open.
  useEffect(() => {
    if (!actionForId) return
    function handleMouseDown(e: MouseEvent) {
      const node = sheetRef.current
      if (node && e.target instanceof Node && node.contains(e.target)) return
      setActionForId(null)
      setActionPos(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [actionForId])

  /** Open the action sheet for `task`, anchored to the clicked card element. */
  function openActionSheet(task: SwarmTask, cardEl: HTMLElement) {
    if (actionForId === task.id) {
      setActionForId(null)
      setActionPos(null)
      return
    }
    const rect = cardEl.getBoundingClientRect()
    const viewportH = window.innerHeight
    // If the sheet would overflow the bottom of the viewport, flip it above.
    const spaceBelow = viewportH - rect.bottom
    const placeAbove = spaceBelow < ACTION_SHEET_MAX_HEIGHT + ACTION_SHEET_GAP
    const top = placeAbove
      ? Math.max(4, rect.top - ACTION_SHEET_GAP - ACTION_SHEET_MAX_HEIGHT)
      : rect.bottom + ACTION_SHEET_GAP
    // Clamp left so the sheet doesn't run off the right edge of the viewport.
    const left = Math.min(
      Math.max(4, rect.left),
      window.innerWidth - ACTION_SHEET_WIDTH - 4,
    )
    setActionForId(task.id)
    setActionPos({ top, left, placeAbove })
  }

  // Group tasks by state once per render.
  const grouped = useMemo(() => {
    const map = new Map<GnapTaskState, SwarmTask[]>()
    for (const col of COLUMNS) map.set(col.state, [])
    for (const t of tasks) {
      const bucket = map.get(t.state)
      if (bucket) bucket.push(t)
      else map.set(t.state, [t])
    }
    return map
  }, [tasks])

  // "By" agent id used in commit messages. Prefer the first registered agent;
  // fall back to a placeholder so commits are still attributable.
  const byAgentId = agents[0]?.id ?? 'viewer'

  async function transitionTask(task: SwarmTask, next: GnapTaskState) {
    if (!activeRepo) return
    setActionForId(null)
    setActionPos(null)
    try {
      const res = await window.tachi.gnap.updateTaskState(
        activeRepo,
        task.id,
        next,
        byAgentId,
      )
      if (!res.ok) {
        setError(`updateTaskState: ${res.error}`)
        return
      }
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Audit H1(a): claim the task AND run it (worktree + TACHI harness). Run state
  // lands in .gnap/runs/*, which the page watch() mirrors onto the board.
  async function claimAndRunTask(task: SwarmTask) {
    if (!activeRepo) return
    setActionForId(null)
    setActionPos(null)
    setRunningId(task.id)
    try {
      const res = await window.tachi.gnap.claimAndRun(activeRepo, task.id, byAgentId, 'tachi')
      if (!res.ok) setError(`Run failed: ${res.reason ?? 'unknown'}`)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningId(null)
    }
  }

  async function handleCreate() {
    if (!activeRepo) return
    const title = draftTitle.trim()
    if (!title) {
      setError(t('kanban.titleRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const id = genId('task')
      const res = await window.tachi.gnap.createTask(activeRepo, {
        id,
        title,
        assigned_to: [],
        state:       'backlog',
        created_by:  byAgentId,
        created_at:  new Date().toISOString(),
        desc:        draftDesc.trim() || undefined,
      })
      if (!res.ok) {
        setError(`createTask: ${res.error}`)
        setBusy(false)
        return
      }
      setCreating(false)
      setDraftTitle('')
      setDraftDesc('')
      setBusy(false)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div style={{
      flex:          1,
      minWidth:      0,
      display:       'flex',
      flexDirection: 'column',
      background:    'var(--bg-base)',
      overflow:      'hidden',
      fontFamily:    'JetBrains Mono, monospace',
    }}>
      {/* Pane header */}
      <div style={{
        padding:       '8px 12px',
        borderBottom:  '2px solid var(--border)',
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color:         'var(--text-muted)',
        display:       'flex',
        alignItems:    'center',
        gap:           12,
        flexShrink:    0,
      }}>
        <span>{t('kanban.header', { count: tasks.length })}</span>
        {error && (
          <span style={{
            color:      'var(--danger, #ff5252)',
            fontWeight: 400,
            letterSpacing: 'normal',
            textTransform: 'none',
            fontSize:   10,
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {error}
          </span>
        )}
      </div>

      {/* Columns (horizontal scroll if too wide) */}
      <div style={{
        flex:     1,
        display:  'flex',
        overflow: 'auto',
      }}>
        {COLUMNS.map((col) => {
          const colTasks = grouped.get(col.state) ?? []
          return (
            <div
              key={col.state}
              style={{
                minWidth:      220,
                width:         220,
                flexShrink:    0,
                borderRight:   '2px solid var(--border)',
                display:       'flex',
                flexDirection: 'column',
                background:    'var(--bg-base)',
              }}
            >
              {/* Column header */}
              <div style={{
                padding:       '8px 10px',
                borderBottom:  '2px solid var(--border)',
                fontSize:      10,
                fontWeight:    700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color:         stateColor(col.state),
                display:       'flex',
                justifyContent: 'space-between',
                alignItems:    'center',
              }}>
                <span>{col.label}</span>
                <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
                  {colTasks.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
                {colTasks.map((task) => (
                  <div
                    key={task.id}
                    style={{
                      position:    'relative',
                      marginBottom: 6,
                      border:      '2px solid var(--border)',
                      background:  'var(--bg-elevated)',
                      padding:     '6px 8px',
                      cursor:      'pointer',
                    }}
                    onMouseDown={(e) => {
                      // Stop the document-level mousedown listener from
                      // treating this click as "outside" — otherwise toggling
                      // off the current sheet and opening this card's sheet
                      // would race.
                      e.stopPropagation()
                    }}
                    onClick={(e) => openActionSheet(task, e.currentTarget)}
                  >
                    <div style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color:    'var(--text-primary)',
                      marginBottom: 2,
                      wordBreak: 'break-word',
                    }}>
                      {task.title}
                    </div>
                    <div style={{
                      fontSize: 9,
                      color: 'var(--text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {task.id}
                    </div>
                    {task.assigned_to.length > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        @{task.assigned_to.join(', @')}
                      </div>
                    )}
                    {task.claim && (
                      <div style={{
                        fontSize: 9,
                        color:    'var(--warning, #f59e0b)',
                        marginTop: 2,
                      }}>
                        {t('kanban.claimed')} {task.claim.agent}
                      </div>
                    )}
                  </div>
                ))}

                {/* New-task affordance — only in the BACKLOG column. */}
                {col.state === 'backlog' && (
                  <div style={{ marginTop: 6 }}>
                    {!creating && (
                      <button
                        type="button"
                        disabled={!activeRepo}
                        onClick={() => { setCreating(true); setError(null) }}
                        style={{
                          width:     '100%',
                          padding:   '6px',
                          border:    '2px dashed var(--border)',
                          background: 'transparent',
                          color:     activeRepo ? 'var(--text-muted)' : 'var(--text-dim)',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize:  10,
                          fontWeight: 700,
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          cursor:    activeRepo ? 'pointer' : 'default',
                        }}
                      >
                        {t('kanban.newTask')}
                      </button>
                    )}
                    {creating && (
                      <div style={{
                        border:     '2px solid var(--accent)',
                        background: 'var(--bg-elevated)',
                        padding:    6,
                        display:    'flex',
                        flexDirection: 'column',
                        gap:        4,
                      }}>
                        <input
                          type="text"
                          autoFocus
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          placeholder={t('kanban.titlePlaceholder')}
                          disabled={busy}
                          style={inputStyle}
                        />
                        <textarea
                          value={draftDesc}
                          onChange={(e) => setDraftDesc(e.target.value)}
                          placeholder={t('kanban.descPlaceholder')}
                          disabled={busy}
                          rows={3}
                          style={{ ...inputStyle, resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => { setCreating(false); setError(null) }}
                            style={smallButtonGhost}
                          >
                            {t('kanban.cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={handleCreate}
                            style={smallButtonFilled}
                          >
                            {busy ? '...' : t('kanban.add')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Action sheet — rendered as a portal-style fixed element so it isn't
          clipped by the column's overflow-y:auto. Position is computed in
          openActionSheet() with a flip-above fallback when there isn't enough
          space below the anchor card. */}
      {actionForId && actionPos && (() => {
        const task = tasks.find((t) => t.id === actionForId)
        if (!task) return null
        return (
          <div
            ref={sheetRef}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position:   'fixed',
              top:        actionPos.top,
              left:       actionPos.left,
              width:      ACTION_SHEET_WIDTH,
              maxHeight:  ACTION_SHEET_MAX_HEIGHT,
              overflowY:  'auto',
              background: 'var(--bg-surface)',
              border:     '2px solid var(--accent)',
              boxShadow:  'var(--shadow-hard)',
              zIndex:     99997,
              padding:    4,
              display:    'flex',
              flexDirection: 'column',
              gap:        2,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setActionForId(null)
                setActionPos(null)
                setDetailFor(task)
              }}
              style={actionButtonStyle}
            >
              {t('kanban.actionOpen')}
            </button>
            <button
              type="button"
              disabled={runningId === task.id}
              onClick={() => claimAndRunTask(task)}
              style={actionButtonStyle}
            >
              {runningId === task.id ? 'RUNNING…' : 'CLAIM & RUN'}
            </button>
            <div style={{
              borderTop: 'var(--border-width) solid var(--border)',
              margin:    '2px 0',
            }} />
            {TRANSITION_TARGETS.filter((s) => s !== task.state).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => transitionTask(task, s)}
                style={actionButtonStyle}
              >
                -&gt; {s.replace('_', ' ').toUpperCase()}
              </button>
            ))}
          </div>
        )
      })()}

      {/* Detail modal */}
      {detailFor && (
        <div
          onClick={() => setDetailFor(null)}
          style={{
            position:       'fixed',
            inset:          0,
            zIndex:         99998,
            background:     'rgba(0,0,0,0.5)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth:   480,
              maxWidth:   720,
              maxHeight:  '80vh',
              overflow:   'auto',
              background: 'var(--bg-surface)',
              border:     '2px solid var(--accent)',
              boxShadow:  'var(--shadow-hard)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            <div style={{
              padding:       '10px 14px',
              borderBottom:  '2px solid var(--accent)',
              fontSize:      11,
              fontWeight:    700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color:         'var(--accent)',
              display:       'flex',
              justifyContent: 'space-between',
              alignItems:    'center',
            }}>
              <span>{t('kanban.detail.titlePrefix')} {detailFor.id}</span>
              <button
                type="button"
                onClick={() => setDetailFor(null)}
                style={{
                  border:     'none',
                  background: 'transparent',
                  color:      'var(--accent)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize:   14,
                  cursor:     'pointer',
                  padding:    0,
                  lineHeight: 1,
                }}
                aria-label={t('kanban.detail.close')}
              >
                [X]
              </button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                {detailFor.title}
              </div>
              <div style={{ fontSize: 11, color: stateColor(detailFor.state) }}>
                state: {detailFor.state}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                created_by: {detailFor.created_by} · created_at: {detailFor.created_at}
              </div>
              {detailFor.assigned_to.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  assigned: @{detailFor.assigned_to.join(', @')}
                </div>
              )}
              {detailFor.desc && (
                <div style={{
                  fontSize:   12,
                  color:      'var(--text-primary)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak:  'break-word',
                  border:     '2px solid var(--border)',
                  padding:    8,
                  background: 'var(--bg-base)',
                }}>
                  {detailFor.desc}
                </div>
              )}
              {detailFor.comments && detailFor.comments.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                  }}>
                    {t('kanban.detail.comments', { count: detailFor.comments.length })}
                  </div>
                  {detailFor.comments.map((c, i) => (
                    <div key={i} style={{
                      fontSize: 11,
                      color:    'var(--text-primary)',
                      border:   'var(--border-width) solid var(--border)',
                      padding:  6,
                      background: 'var(--bg-base)',
                    }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                        @{c.author} · {c.at}
                      </div>
                      <div style={{ marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {c.text}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared styles ───────────────────────────────────────────────────────────

const actionButtonStyle: React.CSSProperties = {
  border:        'none',
  background:    'transparent',
  color:         'var(--text-primary)',
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      10,
  fontWeight:    700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor:        'pointer',
  padding:       '3px 6px',
  textAlign:     'left',
}

const inputStyle: React.CSSProperties = {
  padding:    '4px 6px',
  border:     '2px solid var(--border)',
  background: 'var(--bg-base)',
  color:      'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize:   11,
  outline:    'none',
}

const smallButtonGhost: React.CSSProperties = {
  flex: 1,
  padding: '3px 6px',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const smallButtonFilled: React.CSSProperties = {
  flex: 1,
  padding: '3px 6px',
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}
