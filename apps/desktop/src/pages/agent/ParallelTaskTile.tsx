// apps/desktop/src/pages/agent/ParallelTaskTile.tsx
//
// Brutalist tile representing one parallel coding task. Shows:
//   - Task name (top, sticky)
//   - Branch name (mono, dim)
//   - Status pill ([RUNNING] / [DONE] / [ERROR] / [IDLE] / [ABORTED])
//   - Display-mode toggle ([ EVENTS | PTY ]) — events is default (legacy
//     behaviour); pty mounts a PtyTerminalView attached to the worktree
//   - Last ~6 lines of output (from .claude/steps.json or assistant text),
//     OR an xterm-backed terminal pane when PTY is selected
//   - Focus highlight when this tile is the InputBar target
//
// No border-radius; 2px borders; JetBrains Mono throughout. Uses semantic
// CSS vars (--accent, --border, --bg-elevated) so theme switches Just Work.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ParallelTaskSnapshot, ParallelStepEntry } from '../../types/electron'
import { useParallelAgentsStore, type ParallelTileDisplayMode } from '../../store/parallel-agents.store'
import { PtyTerminalView } from './PtyTerminalView'

interface ParallelTaskTileProps {
  task:     ParallelTaskSnapshot
  steps:    ParallelStepEntry[]
  focused:  boolean
  onFocus:  () => void
  onDelete: () => void
}

const STATUS_LABEL_KEY: Record<ParallelTaskSnapshot['status'], string> = {
  idle:    'tile.status.idle',
  running: 'tile.status.running',
  done:    'tile.status.done',
  error:   'tile.status.error',
  aborted: 'tile.status.aborted',
}

const STATUS_COLOR: Record<ParallelTaskSnapshot['status'], string> = {
  idle:    'var(--text-muted)',
  running: 'var(--success, #4ade80)',
  done:    'var(--accent)',
  error:   'var(--danger, #ff5252)',
  aborted: 'var(--warning, #f59e0b)',
}

function stepToLine(entry: ParallelStepEntry): string {
  // Best-effort extraction: agents emit different shapes. Try common fields.
  if (typeof entry.summary === 'string') return entry.summary
  if (typeof entry.text === 'string') return entry.text
  if (typeof entry.tool === 'string' && typeof entry.target === 'string') {
    return `${entry.tool} ${entry.target}`
  }
  if (typeof entry.message === 'string') return entry.message
  // Fall back to JSON one-liner (truncated).
  try {
    return JSON.stringify(entry).slice(0, 200)
  } catch {
    return '(unparseable step)'
  }
}

export function ParallelTaskTile({
  task,
  steps,
  focused,
  onFocus,
  onDelete,
}: ParallelTaskTileProps) {
  const { t } = useTranslation('agent')
  // Read this tile's display mode from the store. Missing entry = 'events'
  // (the legacy default; PTY is opt-in).
  const displayMode    = useParallelAgentsStore(s => s.displayMode.get(task.id) ?? 'events')
  const setDisplayMode = useParallelAgentsStore(s => s.setDisplayMode)

  const handleSetMode = (mode: ParallelTileDisplayMode, e: React.MouseEvent) => {
    e.stopPropagation()  // toggle clicks shouldn't also fire focus
    setDisplayMode(task.id, mode)
  }

  const lines: string[] = []
  // Prefer the latest assistant text excerpt (set by main from agent events)
  // so the user sees "what the agent just said" rather than only its tool calls.
  if (task.lastLine) lines.push(task.lastLine)
  // Append the most-recent ~6 steps, oldest first.
  const recentSteps = steps.slice(-6)
  for (const s of recentSteps) lines.push(stepToLine(s))
  // Trim to last 6 unique-ish lines for display.
  const displayLines = lines.slice(-6)

  return (
    <div
      onClick={onFocus}
      style={{
        display:       'flex',
        flexDirection: 'column',
        minHeight:     220,
        border:        focused ? '2px solid var(--accent)' : '2px solid var(--border)',
        background:    'var(--bg-elevated)',
        boxShadow:     focused
          ? '0 0 0 2px var(--accent), 4px 4px 0 var(--border)'
          : '4px 4px 0 var(--border)',
        fontFamily:    'JetBrains Mono, monospace',
        cursor:        'pointer',
        transition:    'box-shadow 0.1s, border-color 0.1s',
        position:      'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding:        '6px 10px',
          borderBottom:   '2px solid var(--border)',
          display:        'flex',
          alignItems:     'center',
          gap:            8,
          background:     'var(--bg-surface)',
          flexShrink:     0,
        }}
      >
        <span
          style={{
            flex:           1,
            fontSize:       12,
            fontWeight:     700,
            color:          'var(--text-primary)',
            overflow:       'hidden',
            textOverflow:   'ellipsis',
            whiteSpace:     'nowrap',
            letterSpacing:  '0.02em',
          }}
          title={task.name}
        >
          {task.name}
        </span>
        <span
          style={{
            fontSize:    9,
            fontWeight:  700,
            color:       STATUS_COLOR[task.status],
            border:      `2px solid ${STATUS_COLOR[task.status]}`,
            padding:     '1px 6px',
            background:  'transparent',
            letterSpacing: '0.06em',
            flexShrink:  0,
          }}
        >
          {t(STATUS_LABEL_KEY[task.status])}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={t('tile.deleteTooltip')}
          aria-label={t('tile.deleteAria')}
          style={{
            padding:        '1px 6px',
            border:         '2px solid var(--border)',
            background:     'transparent',
            color:          'var(--text-muted)',
            fontFamily:     'JetBrains Mono, monospace',
            fontSize:       10,
            fontWeight:     700,
            cursor:         'pointer',
            flexShrink:     0,
          }}
        >
          X
        </button>
      </div>

      {/* Branch line + display-mode toggle */}
      <div
        style={{
          padding:        '4px 10px',
          borderBottom:   'var(--border-width) solid var(--border)',
          fontSize:       10,
          color:          'var(--text-dim)',
          letterSpacing:  '0.02em',
          flexShrink:     0,
          display:        'flex',
          alignItems:     'center',
          gap:            8,
        }}
      >
        <span
          style={{
            flex:         1,
            overflow:     'hidden',
            textOverflow: 'ellipsis',
            whiteSpace:   'nowrap',
          }}
          title={task.branchName}
        >
          {task.branchName}
        </span>
        {/* [ EVENTS | PTY ] toggle. Inline so it lives next to the branch
            label and never wraps. */}
        <span
          aria-label={t('tile.displayModeAria')}
          style={{
            display:     'inline-flex',
            border:      '2px solid var(--border)',
            flexShrink:  0,
          }}
        >
          <button
            onClick={(e) => handleSetMode('events', e)}
            aria-pressed={displayMode === 'events'}
            title={t('tile.eventsTooltip')}
            style={{
              padding:        '1px 6px',
              border:         'none',
              background:     displayMode === 'events' ? 'var(--accent)' : 'transparent',
              color:          displayMode === 'events' ? '#ffffff' : 'var(--text-muted)',
              fontFamily:     'JetBrains Mono, monospace',
              fontSize:       9,
              fontWeight:     700,
              letterSpacing:  '0.08em',
              cursor:         'pointer',
            }}
          >
            {t('tile.events')}
          </button>
          <button
            onClick={(e) => handleSetMode('pty', e)}
            aria-pressed={displayMode === 'pty'}
            title={t('tile.ptyTooltip')}
            style={{
              padding:        '1px 6px',
              border:         'none',
              borderLeft:     '2px solid var(--border)',
              background:     displayMode === 'pty' ? 'var(--accent)' : 'transparent',
              color:          displayMode === 'pty' ? '#ffffff' : 'var(--text-muted)',
              fontFamily:     'JetBrains Mono, monospace',
              fontSize:       9,
              fontWeight:     700,
              letterSpacing:  '0.08em',
              cursor:         'pointer',
            }}
          >
            PTY
          </button>
        </span>
      </div>

      {/* Output viewport — either the legacy events list or the PTY pane.
          We render exactly one at a time so xterm doesn't have to compete
          for viewport size with the text fallback. */}
      {displayMode === 'pty' ? (
        // PtyTerminalView owns its own flex sizing; we just provide the
        // wrapper so the tile's overall column layout stays consistent.
        <div
          style={{
            flex:         1,
            display:      'flex',
            flexDirection: 'column',
            minHeight:    100,
            background:   '#0f0f0f',
          }}
        >
          <PtyTerminalView taskId={task.id} active={true} />
        </div>
      ) : (
        <div
          style={{
            flex:         1,
            padding:      '6px 10px',
            fontSize:     11,
            lineHeight:   1.4,
            color:        'var(--text-primary)',
            overflow:     'auto',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            minHeight:    100,
          }}
        >
          {displayLines.length === 0 && (
            <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
              {t('tile.noOutput')}
            </span>
          )}
          {displayLines.map((line, i) => (
            <div
              key={i}
              style={{
                opacity: i === displayLines.length - 1 ? 1 : 0.65,
                marginBottom: 2,
              }}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
