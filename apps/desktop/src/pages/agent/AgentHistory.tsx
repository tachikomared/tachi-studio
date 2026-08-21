// apps/desktop/src/pages/agent/AgentHistory.tsx
//
// Left rail listing past agent sessions, mirroring ChatHistory's pattern.
// Clicking a session opens it read-only (viewArchive). The "Continue" action
// (onContinue → AgentPage.resumeSession) restores it into the editable live
// area and starts a fresh harness session so the user can pick the task back
// up in the same workspace.
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentStore, sessionsForTag, type PastAgentSession, type AgentSessionTag } from '../../store/agent.store'
import { showToast } from '../../components/Toaster'
import { useAgentRuntime } from '../../hooks/useAgentRuntime'

function formatRelative(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('history.time.justNow')
  if (diff < 3600_000) return t('history.time.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('history.time.hoursAgo', { count: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('history.time.daysAgo', { count: Math.floor(diff / 86400_000) })
  return new Date(ts).toLocaleDateString()
}

function basename(path: string | null): string {
  if (!path) return '—'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function statusColor(s: PastAgentSession['status']): string {
  if (s === 'done') return 'var(--success)'
  if (s === 'error') return 'var(--destructive)'
  if (s === 'running') return 'var(--info)'
  return 'var(--text-dim)'
}

export function AgentHistory({ open, onClose, onContinue, tag }: {
  open: boolean
  onClose: () => void
  onContinue: (id: string) => void
  /** Surface filter — omitted on the Code tab (shows untagged sessions only). */
  tag?: AgentSessionTag
}) {
  const { t } = useTranslation('agent')
  const allSessions      = useAgentStore(s => s.pastSessions)
  const pastSessions     = useMemo(() => sessionsForTag(allSessions, tag), [allSessions, tag])
  const viewingArchiveId = useAgentStore(s => s.viewingArchiveId)
  const viewArchive      = useAgentStore(s => s.viewArchive)
  const startNewSession  = useAgentStore(s => s.startNewSession)
  const closeArchive     = useAgentStore(s => s.closeArchive)
  const deleteArchive    = useAgentStore(s => s.deleteArchive)
  const renameArchive    = useAgentStore(s => s.renameArchive)
  // C2 dev: mirror from main store proves cross-window broadcast
  const runtimeSnapshot  = useAgentRuntime()

  const [q, setQ] = useState('')
  const [renaming, setRenaming]                 = useState<string | null>(null)
  const [renameText, setRenameText]             = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const list = [...pastSessions].sort((a, b) => b.endedAt - a.endedAt)
    if (!q.trim()) return list
    const lc = q.toLowerCase()
    return list.filter(p =>
      p.title.toLowerCase().includes(lc) ||
      (p.workingDir ?? '').toLowerCase().includes(lc),
    )
  }, [pastSessions, q])

  if (!open) return null

  return (
    <div style={{
      width: 260,
      minWidth: 260,
      maxWidth: 260,
      borderRight: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'JetBrains Mono, monospace',
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: '2px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--bg-elevated)',
      }}>
        <span style={{
          flex: 1,
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
        }}>{t('history.sessions', { count: pastSessions.length })}</span>
        {/* C2: runtimeSnapshot still proves cross-window broadcast, but the raw
            "{main store: idle}" chip was a dev artifact users could see (QA
            2026-07-18) — keep the subscription, drop the chip. */}
        <button
          onClick={() => startNewSession()}
          title={t('history.newTooltip')}
          aria-label={t('history.newAria')}
          style={{
            padding: '2px 8px',
            border: '2px solid var(--accent)',
            background: 'var(--accent-muted)',
            color: 'var(--accent-text)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >{t('history.new')}</button>
        <button
          onClick={onClose}
          title={t('history.hideTooltip')}
          aria-label={t('history.hideAria')}
          style={{
            padding: '2px 6px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >×</button>
      </div>

      {/* Viewing-archive banner — only shown while in read-only mode */}
      {viewingArchiveId && (
        <div style={{
          padding: '6px 10px',
          borderBottom: '2px solid var(--border)',
          background: 'var(--bg-inset)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{
            flex: 1,
            fontSize: 9,
            color: 'var(--warning, #f59e0b)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 700,
          }}>{t('history.viewingArchive')}</span>
          <button
            onClick={() => closeArchive()}
            title={t('history.backToLiveTooltip')}
            style={{
              padding: '2px 6px',
              border: '2px solid var(--border)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >↶ {t('history.backToLive')}</button>
        </div>
      )}

      {/* Search */}
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={t('history.searchPlaceholder')}
        style={{
          padding: '6px 10px',
          border: 'none',
          borderBottom: '2px solid var(--border)',
          background: 'var(--bg-inset)',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          outline: 'none',
        }}
      />

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>
            {q ? t('history.noMatches') : t('history.empty')}
          </div>
        )}
        {filtered.map(p => {
          const isActive = p.id === viewingArchiveId
          const isConfirming = confirmingDelete === p.id

          return (
            <div
              key={p.id}
              onClick={() => viewArchive(p.id)}
              style={{
                padding: '8px 10px',
                borderBottom: 'var(--border-width) solid var(--border)',
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                background: isActive ? 'var(--accent-muted)' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {renaming === p.id ? (
                <input
                  autoFocus
                  value={renameText}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setRenameText(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      renameArchive(p.id, renameText)
                      setRenaming(null)
                    }
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => {
                    if (renameText.trim()) renameArchive(p.id, renameText)
                    setRenaming(null)
                  }}
                  style={{
                    padding: '2px 4px',
                    border: '2px solid var(--accent)',
                    background: 'var(--bg-inset)',
                    color: 'var(--text-primary)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    outline: 'none',
                  }}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    width: 5, height: 5, background: statusColor(p.status), flexShrink: 0,
                  }} />
                  <div style={{
                    flex: 1,
                    fontSize: 11,
                    color: isActive ? 'var(--accent-text)' : 'var(--text-primary)',
                    fontWeight: isActive ? 700 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{p.title}</div>
                </div>
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 9,
                color: 'var(--text-dim)',
                paddingLeft: 9,
              }}>
                <span>{p.harness}</span>
                <span>·</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.workingDir ?? ''}>
                  {basename(p.workingDir)}
                </span>
                <span>{t('history.eventCount', { count: p.messages.length })}</span>
                <span>{formatRelative(p.endedAt, t)}</span>
              </div>
              {isActive && (
                <div style={{ display: 'flex', gap: 4, marginTop: 4, paddingLeft: 9 }}>
                  <button
                    title={t('history.continueTooltip')}
                    aria-label={t('history.continueAction')}
                    onClick={e => { e.stopPropagation(); onContinue(p.id) }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--accent)',
                      background: 'var(--accent-muted)',
                      color: 'var(--accent-text)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >▶ {t('history.continueAction')}</button>
                  <button
                    title={t('history.rename')}
                    aria-label={t('history.rename')}
                    onClick={e => { e.stopPropagation(); setRenameText(p.title); setRenaming(p.id) }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{t('history.renameAction')}</button>
                  <button
                    title={isConfirming ? t('history.confirmDeleteTooltip') : t('history.delete')}
                    aria-label={t('history.delete')}
                    onClick={e => {
                      e.stopPropagation()
                      if (isConfirming) {
                        deleteArchive(p.id)
                        setConfirmingDelete(null)
                        showToast({ kind: 'info', text: t('history.deletedToast') })
                      } else {
                        setConfirmingDelete(p.id)
                        setTimeout(() => {
                          setConfirmingDelete(curr => curr === p.id ? null : curr)
                        }, 3000)
                      }
                    }}
                    style={{
                      padding: '2px 6px',
                      border: `2px solid ${isConfirming ? 'var(--destructive)' : 'var(--border)'}`,
                      background: isConfirming ? 'var(--destructive)' : 'var(--bg-elevated)',
                      color: isConfirming ? '#fff' : 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{isConfirming ? t('history.sure') : t('history.deleteAction')}</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
