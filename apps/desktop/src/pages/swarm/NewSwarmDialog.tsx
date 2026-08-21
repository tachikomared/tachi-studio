// apps/desktop/src/pages/swarm/NewSwarmDialog.tsx
//
// Brutalist modal for picking (or typing) a directory and calling
// gnap.initSwarm() on it. Layout mirrors ConfirmDialog so it looks identical
// to the rest of the app — header bar with accent border, two-column footer
// with CANCEL + CREATE.
//
// Uses window.tachi.agent.pickFolder() for the native directory chooser
// (already exposed by the agent IPC bridge, no new IPC needed). Falls back
// to a manual text input if the user prefers to type the path.

import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../../hooks/useDialog'

interface NewSwarmDialogProps {
  /** Called with the resolved repo path after a successful initSwarm. */
  onCreated: (repoPath: string) => void
  /** Called when the user dismisses the dialog without creating a swarm. */
  onCancel:  () => void
}

export function NewSwarmDialog({ onCreated, onCancel }: NewSwarmDialogProps) {
  const { t } = useTranslation('swarm')
  const [repoPath, setRepoPath]   = useState('')
  const [busy,     setBusy]       = useState(false)
  const [error,    setError]      = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Esc + focus trap + focus restore (backdrop/Esc no-op while busy).
  const cardRef = useDialog<HTMLDivElement>(() => { if (!busy) onCancel() })

  async function handlePick() {
    try {
      const picked = await window.tachi.agent.pickFolder()
      if (picked) setRepoPath(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSubmit() {
    const trimmed = repoPath.trim()
    if (!trimmed) {
      setError(t('dialog.pathRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await window.tachi.gnap.initSwarm(trimmed, { protocolVersion: '1.0' })
      if (!res.ok) {
        setError(res.error || t('dialog.initFailed'))
        setBusy(false)
        return
      }
      onCreated(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position:       'fixed',
        inset:          0,
        zIndex:         99999,
        background:     'rgba(0, 0, 0, 0.50)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-swarm-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth:      460,
          maxWidth:      640,
          background:    'var(--bg-surface)',
          border:        '2px solid var(--accent)',
          boxShadow:     'var(--shadow-hard)',
          fontFamily:    'JetBrains Mono, monospace',
          display:       'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding:       '10px 14px 8px',
          borderBottom:  '2px solid var(--accent)',
          fontSize:      11,
          fontWeight:    700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color:         'var(--accent)',
        }}>
          <span id="new-swarm-title">{t('dialog.title')}</span>
        </div>

        {/* Body */}
        <div style={{
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          <div style={{
            fontSize:   12,
            color:      'var(--text-muted)',
            lineHeight: 1.5,
          }}>
            {t('dialog.descBefore')} <code>.gnap/</code>{t('dialog.descAfter')}
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <input
              ref={inputRef}
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder={t('dialog.pathPlaceholder')}
              disabled={busy}
              style={{
                flex:       1,
                padding:    '6px 8px',
                border:     '2px solid var(--border)',
                background: 'var(--bg-base)',
                color:      'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize:   12,
                outline:    'none',
              }}
            />
            <button
              type="button"
              onClick={handlePick}
              disabled={busy}
              style={{
                padding:    '5px 12px',
                border:     '2px solid var(--border-strong)',
                background: 'var(--bg-elevated)',
                color:      'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize:   11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor:     busy ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t('dialog.pick')}
            </button>
          </div>

          {error && (
            <div style={{
              padding:    '6px 8px',
              border:     '2px solid var(--danger, #ff5252)',
              background: 'transparent',
              color:      'var(--danger, #ff5252)',
              fontSize:   11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak:  'break-word',
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding:        '8px 14px 12px',
          display:        'flex',
          justifyContent: 'flex-end',
          gap:            8,
        }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding:    '5px 14px',
              border:     '2px solid var(--border)',
              background: 'transparent',
              color:      'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:     busy ? 'default' : 'pointer',
            }}
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            style={{
              padding:    '5px 14px',
              border:     '2px solid var(--accent)',
              background: 'var(--accent)',
              color:      '#ffffff',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:     busy ? 'default' : 'pointer',
              opacity:    busy ? 0.6 : 1,
            }}
          >
            {busy ? t('dialog.creating') : t('dialog.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
