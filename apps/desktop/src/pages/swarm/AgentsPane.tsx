// apps/desktop/src/pages/swarm/AgentsPane.tsx
//
// Left pane of the SwarmPage: roster of registered agents.
//
// V1 keeps this read-only — no register-agent flow in-pane. The [REGISTER]
// button is wired to a stub action sheet that opens a one-field prompt
// (later we'll add a proper modal for runtime + role + capabilities).
//
// Heartbeat-age is computed against the agent's `heartbeat_sec` advisory,
// but the protocol doesn't expose a last-beat-at field directly — so this
// only shows the status and the *advisory* heartbeat interval, not actual
// liveness. Liveness inference belongs in a follow-up once the protocol
// adds a presence file.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SwarmAgent } from '../../store/swarm.store'

interface AgentsPaneProps {
  agents:     SwarmAgent[]
  activeRepo: string | null
  /** Called after the store has been refreshed. Caller usually re-runs loadAll. */
  onChanged?: () => void
}

function statusGlyph(status: SwarmAgent['status']): string {
  if (status === 'active')  return '[ACTIVE]'
  if (status === 'paused')  return '[PAUSED]'
  return '[STOPPED]'
}

function statusColor(status: SwarmAgent['status']): string {
  if (status === 'active') return 'var(--success, #4ade80)'
  if (status === 'paused') return 'var(--warning, #f59e0b)'
  return 'var(--text-dim)'
}

export function AgentsPane({ agents, activeRepo, onChanged }: AgentsPaneProps) {
  const { t } = useTranslation('swarm')
  const [registering, setRegistering] = useState(false)
  const [draftId,     setDraftId]     = useState('')
  const [draftName,   setDraftName]   = useState('')
  const [busy,        setBusy]        = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  async function handleRegister() {
    if (!activeRepo) return
    const id   = draftId.trim()
    const name = draftName.trim() || id
    if (!id) {
      setError(t('agents.idRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await window.tachi.gnap.registerAgent(activeRepo, {
        id,
        name,
        role:   'agent',
        type:   'human',
        status: 'active',
      })
      if (!res.ok) {
        setError(res.error || t('agents.registerFailed'))
        setBusy(false)
        return
      }
      setRegistering(false)
      setDraftId('')
      setDraftName('')
      setBusy(false)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div style={{
      width:         200,
      flexShrink:    0,
      borderRight:   '2px solid var(--border)',
      background:    'var(--bg-base)',
      display:       'flex',
      flexDirection: 'column',
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
        flexShrink:    0,
      }}>
        {t('agents.header', { count: agents.length })}
      </div>

      {/* Roster (scrollable) */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {agents.length === 0 && (
          <div style={{
            padding: '12px',
            fontSize: 11,
            color: 'var(--text-dim)',
            lineHeight: 1.5,
          }}>
            {t('agents.empty')}
          </div>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            style={{
              padding:      '8px 12px',
              borderBottom: 'var(--border-width) solid var(--border)',
              display:      'flex',
              flexDirection: 'column',
              gap:          2,
            }}
          >
            <div style={{
              fontSize:   12,
              fontWeight: 700,
              color:      'var(--text-primary)',
              overflow:   'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {agent.name}
            </div>
            <div style={{
              fontSize:   10,
              color:      'var(--text-dim)',
              overflow:   'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {agent.id}
            </div>
            <div style={{
              fontSize:   10,
              color:      statusColor(agent.status),
              fontWeight: 700,
              letterSpacing: '0.05em',
            }}>
              {statusGlyph(agent.status)}
            </div>
            {agent.role && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {t('agents.roleLabel')} {agent.role}
              </div>
            )}
            {agent.heartbeat_sec != null && (
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {t('agents.heartbeatLabel')} {agent.heartbeat_sec}s
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Register footer */}
      <div style={{
        borderTop: '2px solid var(--border)',
        padding:    8,
        flexShrink: 0,
        display:    'flex',
        flexDirection: 'column',
        gap:        6,
      }}>
        {!registering && (
          <button
            type="button"
            disabled={!activeRepo}
            onClick={() => { setRegistering(true); setError(null) }}
            style={{
              padding:    '6px 8px',
              border:     '2px solid var(--border-strong)',
              background: activeRepo ? 'var(--bg-elevated)' : 'transparent',
              color:      activeRepo ? 'var(--text-primary)' : 'var(--text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize:   10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor:     activeRepo ? 'pointer' : 'default',
            }}
          >
            {t('agents.register')}
          </button>
        )}
        {registering && (
          <>
            <input
              type="text"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder={t('agents.idPlaceholder')}
              disabled={busy}
              style={{
                padding:    '5px 6px',
                border:     '2px solid var(--border)',
                background: 'var(--bg-base)',
                color:      'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize:   11,
                outline:    'none',
              }}
            />
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t('agents.namePlaceholder')}
              disabled={busy}
              style={{
                padding:    '5px 6px',
                border:     '2px solid var(--border)',
                background: 'var(--bg-base)',
                color:      'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize:   11,
                outline:    'none',
              }}
            />
            {error && (
              <div style={{ fontSize: 10, color: 'var(--danger, #ff5252)' }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => { setRegistering(false); setError(null) }}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '4px 6px',
                  border: '2px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {t('agents.cancel')}
              </button>
              <button
                type="button"
                onClick={handleRegister}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '4px 6px',
                  border: '2px solid var(--accent)',
                  background: 'var(--accent)',
                  color: '#ffffff',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? '...' : t('agents.add')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
