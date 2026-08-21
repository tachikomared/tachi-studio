// apps/desktop/src/pages/agent/NewParallelTaskDialog.tsx
//
// Brutalist create-task modal. Uses ConfirmDialog's visual language but with
// a form body — text inputs for name, project root, base branch, branch
// prefix, plus checkboxes for which sibling dirs to symlink into the new
// worktree (defaults: node_modules, .env).
//
// Submit calls `window.tachi.parallel.createTask` via the store; on success
// the dialog closes and the new tile appears in the grid (the store's
// optimistic insert covers the case where the push event hasn't arrived yet).

import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParallelAgentsStore } from '../../store/parallel-agents.store'
import { useDialog } from '../../hooks/useDialog'

interface NewParallelTaskDialogProps {
  defaultProjectRoot: string | null
  onClose: () => void
}

const DEFAULT_SYMLINKS = ['node_modules', '.env']
const KNOWN_SYMLINK_OPTIONS = ['node_modules', '.env', '.venv', 'vendor', '.cache']

export function NewParallelTaskDialog({
  defaultProjectRoot,
  onClose,
}: NewParallelTaskDialogProps) {
  const { t } = useTranslation('agent')
  const createTask = useParallelAgentsStore(s => s.createTask)

  const [name,         setName]         = useState('')
  const [projectRoot,  setProjectRoot]  = useState(defaultProjectRoot ?? '')
  const [baseBranch,   setBaseBranch]   = useState('')
  const [branchPrefix, setBranchPrefix] = useState('task')
  const [symlinks,     setSymlinks]     = useState<Set<string>>(new Set(DEFAULT_SYMLINKS))
  const [error,        setError]        = useState<string | null>(null)
  const [submitting,   setSubmitting]   = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // Esc + focus trap + focus restore (backdrop/Esc no-op while submitting).
  const cardRef = useDialog<HTMLDivElement>(() => { if (!submitting) onClose() })

  const pickFolder = async () => {
    const path = await window.tachi.agent.pickFolder()
    if (path) setProjectRoot(path)
  }

  const toggleSymlink = (dir: string) => {
    const next = new Set(symlinks)
    if (next.has(dir)) next.delete(dir)
    else next.add(dir)
    setSymlinks(next)
  }

  const handleSubmit = async () => {
    setError(null)
    const trimmedName = name.trim()
    const trimmedRoot = projectRoot.trim()
    if (!trimmedName) {
      setError(t('dialog.nameRequired'))
      return
    }
    if (!trimmedRoot) {
      setError(t('dialog.rootRequired'))
      return
    }
    setSubmitting(true)
    try {
      const result = await createTask({
        name:         trimmedName,
        projectRoot:  trimmedRoot,
        baseBranch:   baseBranch.trim() || undefined,
        branchPrefix: branchPrefix.trim() || 'task',
        symlinkDirs:  Array.from(symlinks),
      })
      if (!result.ok) {
        setError(result.error)
        setSubmitting(false)
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const accent = 'var(--accent)'
  const labelStyle: React.CSSProperties = {
    display:       'block',
    fontSize:      10,
    fontWeight:    700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color:         'var(--text-dim)',
    marginBottom:  4,
  }
  const inputStyle: React.CSSProperties = {
    width:         '100%',
    padding:       '6px 10px',
    border:        '2px solid var(--border)',
    background:    'var(--bg-elevated)',
    color:         'var(--text-primary)',
    fontFamily:    'JetBrains Mono, monospace',
    fontSize:      12,
    boxSizing:     'border-box',
  }

  return (
    <div
      onClick={() => { if (!submitting) onClose() }}
      style={{
        position:        'fixed',
        inset:           0,
        zIndex:          99999,
        background:      'rgba(0, 0, 0, 0.50)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-parallel-task-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth:    480,
          maxWidth:    640,
          background:  'var(--bg-surface)',
          border:      `2px solid ${accent}`,
          boxShadow:   'var(--shadow-hard, 8px 8px 0 var(--border))',
          fontFamily:  'JetBrains Mono, monospace',
          display:     'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding:        '10px 14px 8px',
            borderBottom:   `2px solid ${accent}`,
            fontSize:       11,
            fontWeight:     700,
            letterSpacing:  '0.12em',
            textTransform:  'uppercase',
            color:          accent,
          }}
        >
          <span id="new-parallel-task-title">{t('dialog.title')}</span>
        </div>

        {/* Body */}
        <div style={{ padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Task name */}
          <div>
            <label style={labelStyle} htmlFor="task-name">{t('dialog.nameLabel')}</label>
            <input
              ref={nameRef}
              id="task-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('dialog.namePlaceholder')}
              style={inputStyle}
              disabled={submitting}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            />
          </div>

          {/* Project root */}
          <div>
            <label style={labelStyle} htmlFor="project-root">{t('dialog.rootLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                id="project-root"
                type="text"
                value={projectRoot}
                onChange={(e) => setProjectRoot(e.target.value)}
                placeholder={t('dialog.rootPlaceholder')}
                style={{ ...inputStyle, flex: 1 }}
                disabled={submitting}
              />
              <button
                onClick={pickFolder}
                disabled={submitting}
                style={{
                  padding:        '6px 12px',
                  border:         '2px solid var(--border)',
                  background:     'var(--bg-elevated)',
                  color:          'var(--text-primary)',
                  fontFamily:     'JetBrains Mono, monospace',
                  fontSize:       11,
                  fontWeight:     700,
                  letterSpacing:  '0.04em',
                  cursor:         submitting ? 'default' : 'pointer',
                  whiteSpace:     'nowrap',
                }}
              >
                {t('dialog.choose')}
              </button>
            </div>
          </div>

          {/* Base branch + branch prefix on one row */}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle} htmlFor="base-branch">{t('dialog.baseBranchLabel')}</label>
              <input
                id="base-branch"
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder={t('dialog.baseBranchPlaceholder')}
                style={inputStyle}
                disabled={submitting}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle} htmlFor="branch-prefix">{t('dialog.branchPrefixLabel')}</label>
              <input
                id="branch-prefix"
                type="text"
                value={branchPrefix}
                onChange={(e) => setBranchPrefix(e.target.value)}
                placeholder={t('dialog.branchPrefixPlaceholder')}
                style={inputStyle}
                disabled={submitting}
              />
            </div>
          </div>

          {/* Symlink dirs */}
          <div>
            <label style={labelStyle}>{t('dialog.symlinkLabel')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {KNOWN_SYMLINK_OPTIONS.map(dir => {
                const checked = symlinks.has(dir)
                return (
                  <button
                    key={dir}
                    onClick={() => toggleSymlink(dir)}
                    disabled={submitting}
                    style={{
                      padding:       '3px 8px',
                      border:        checked ? `2px solid ${accent}` : '2px solid var(--border)',
                      background:    checked ? 'var(--accent-muted, transparent)' : 'transparent',
                      color:         checked ? accent : 'var(--text-muted)',
                      fontFamily:    'JetBrains Mono, monospace',
                      fontSize:      10,
                      fontWeight:    700,
                      letterSpacing: '0.04em',
                      cursor:        submitting ? 'default' : 'pointer',
                    }}
                  >
                    [{checked ? 'X' : ' '}] {dir}
                  </button>
                )
              })}
            </div>
          </div>

          {error && (
            <div
              style={{
                padding:    '6px 10px',
                border:     '2px solid var(--danger, #ff5252)',
                background: 'transparent',
                color:      'var(--danger, #ff5252)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize:   11,
              }}
            >
              {t('dialog.errorPrefix', { error })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding:        '8px 14px 12px',
            display:        'flex',
            justifyContent: 'flex-end',
            gap:            8,
          }}
        >
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding:        '5px 14px',
              border:         '2px solid var(--border)',
              background:     'transparent',
              color:          'var(--text-primary)',
              fontFamily:     'JetBrains Mono, monospace',
              fontSize:       11,
              fontWeight:     700,
              letterSpacing:  '0.08em',
              textTransform:  'uppercase',
              cursor:         submitting ? 'default' : 'pointer',
            }}
          >
            {t('dialog.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              padding:        '5px 14px',
              border:         `2px solid ${accent}`,
              background:     accent,
              color:          '#ffffff',
              fontFamily:     'JetBrains Mono, monospace',
              fontSize:       11,
              fontWeight:     700,
              letterSpacing:  '0.08em',
              textTransform:  'uppercase',
              cursor:         submitting ? 'default' : 'pointer',
              opacity:        submitting ? 0.6 : 1,
            }}
          >
            {submitting ? t('dialog.creating') : t('dialog.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
