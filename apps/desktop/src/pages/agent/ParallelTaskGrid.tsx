// apps/desktop/src/pages/agent/ParallelTaskGrid.tsx
//
// Grid view that hosts multiple parallel coding tasks side-by-side. Each tile
// is a ParallelTaskTile; clicking one selects it as the InputBar target. The
// grid uses CSS grid with `auto-fill, minmax(360px, 1fr)` so tiles reflow
// responsively as the window resizes.
//
// Lifecycle: this component subscribes to `parallel:event` once on mount,
// dispatches to the parallel-agents store, and bootstraps the initial state
// via `parallel.list()`. The store is the source of truth for renderer code.

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParallelAgentsStore } from '../../store/parallel-agents.store'
import { ParallelTaskTile } from './ParallelTaskTile'
import { NewParallelTaskDialog } from './NewParallelTaskDialog'
import { useConfirm } from '../../components/ConfirmProvider'

interface ParallelTaskGridProps {
  /** Default project root to suggest in the new-task dialog. */
  defaultProjectRoot?: string | null
}

export function ParallelTaskGrid({ defaultProjectRoot }: ParallelTaskGridProps) {
  const { t } = useTranslation('agent')
  const taskOrder      = useParallelAgentsStore(s => s.taskOrder)
  const tasks          = useParallelAgentsStore(s => s.tasks)
  const stepsByTask    = useParallelAgentsStore(s => s.steps)
  const focusedTaskId  = useParallelAgentsStore(s => s.focusedTaskId)
  const focusTask      = useParallelAgentsStore(s => s.focusTask)
  const deleteTask     = useParallelAgentsStore(s => s.deleteTask)

  const [dialogOpen, setDialogOpen] = useState(false)

  const taskList = taskOrder
    .map(id => tasks.get(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)

  const runningCount = taskList.filter(t => t.status === 'running').length
  const totalCount   = taskList.length

  const confirm = useConfirm()

  const handleDelete = async (taskId: string) => {
    const task = tasks.get(taskId)
    const branchName = task?.branchName ?? t('grid.unknownBranch')
    const ok = await confirm({
      title: t('grid.deleteConfirmTitle'),
      message: t('grid.deleteConfirmMessage', { branchName }),
      okLabel: t('grid.deleteConfirmOk'),
      cancelLabel: t('grid.deleteConfirmCancel'),
      danger: true,
    })
    if (!ok) return
    await deleteTask(taskId, true)
  }

  return (
    <div
      style={{
        display:        'flex',
        flexDirection:  'column',
        flex:           1,
        minHeight:      0,
        background:     'var(--bg-base)',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display:        'flex',
          alignItems:     'center',
          gap:            10,
          padding:        '8px 12px',
          borderBottom:   '2px solid var(--border)',
          background:     'var(--bg-surface)',
          flexShrink:     0,
          fontFamily:     'JetBrains Mono, monospace',
        }}
      >
        <button
          onClick={() => setDialogOpen(true)}
          style={{
            padding:        '6px 12px',
            border:         '2px solid var(--accent)',
            background:     'var(--accent)',
            color:          '#ffffff',
            fontFamily:     'JetBrains Mono, monospace',
            fontSize:       11,
            fontWeight:     700,
            letterSpacing:  '0.08em',
            textTransform:  'uppercase',
            cursor:         'pointer',
          }}
        >
          {t('grid.newTask')}
        </button>

        <span style={{ flex: 1 }} />

        <span
          style={{
            fontSize:      10,
            color:         'var(--text-dim)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {t('grid.running', { running: runningCount, total: totalCount })}
        </span>
      </div>

      {/* Grid body */}
      <div
        style={{
          flex:         1,
          overflow:     'auto',
          padding:      12,
          display:      'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap:          12,
          alignContent: 'start',
        }}
      >
        {taskList.length === 0 ? (
          <div
            style={{
              gridColumn:   '1 / -1',
              padding:      '40px 20px',
              textAlign:    'center',
              color:        'var(--text-muted)',
              fontFamily:   'JetBrains Mono, monospace',
              fontSize:     12,
              border:       '2px dashed var(--border)',
              background:   'var(--bg-elevated)',
            }}
          >
            {t('grid.empty')}
          </div>
        ) : (
          taskList.map(task => (
            <ParallelTaskTile
              key={task.id}
              task={task}
              steps={stepsByTask.get(task.id) ?? []}
              focused={focusedTaskId === task.id}
              onFocus={() => focusTask(task.id)}
              onDelete={() => handleDelete(task.id)}
            />
          ))
        )}
      </div>

      {dialogOpen && (
        <NewParallelTaskDialog
          defaultProjectRoot={defaultProjectRoot ?? null}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
