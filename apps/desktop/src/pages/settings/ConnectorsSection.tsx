// apps/desktop/src/pages/settings/ConnectorsSection.tsx
//
// Brutalist connector management card.
// Lists registered connectors (currently: GitHub only).
// Connect button reuses the Aeon OAuth Device Flow.
// Disconnect button removes the keychain entry.
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectorStatus } from '../../types/electron'

// ── Shared brutalist style helpers ────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const LABEL_STYLE: React.CSSProperties = {
  ...MONO,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-primary)',
}

const BTN_BASE: React.CSSProperties = {
  ...MONO,
  fontSize: 9,
  fontWeight: 700,
  padding: '4px 12px',
  cursor: 'pointer',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  boxShadow: 'var(--shadow-hard)',
}

// ── ConnectorRow ──────────────────────────────────────────────────────────────

interface ConnectorRowProps {
  connector: ConnectorStatus
  onConnect:    () => void
  onDisconnect: () => void
  connecting:   boolean
}

function ConnectorRow({ connector, onConnect, onDisconnect, connecting }: ConnectorRowProps) {
  const { t } = useTranslation('settings')
  const { authStatus, connectedAs } = connector

  const statusColor =
    authStatus === 'connected'    ? 'var(--accent)' :
    authStatus === 'error'        ? 'var(--destructive)' :
                                    'var(--text-muted)'

  const statusLabel =
    authStatus === 'connected'    ? t('connectors.connectedAs', { user: connectedAs ?? '' }) :
    authStatus === 'error'        ? t('connectors.authError') :
                                    t('connectors.notConnected')

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px',
      borderBottom: 'var(--border-width) solid var(--border)',
      gap: 12,
    }}>
      {/* Left: name + description + status */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...LABEL_STYLE, marginBottom: 2 }}>{connector.name}</div>
        <div style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
          {connector.description}
        </div>
        <div style={{ ...MONO, fontSize: 10, color: statusColor }}>
          {statusLabel}
        </div>
      </div>

      {/* Right: action button */}
      <div style={{ flexShrink: 0 }}>
        {authStatus === 'connected' ? (
          <button
            onClick={onDisconnect}
            style={{
              ...BTN_BASE,
              border: 'var(--border-width) solid var(--destructive)',
              background: 'transparent',
              color: 'var(--destructive)',
            }}
          >
            {t('connectors.disconnect')}
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={connecting}
            style={{
              ...BTN_BASE,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--accent)',
              color: '#fff',
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? t('connectors.connecting') : t('connectors.connect')}
          </button>
        )}
      </div>
    </div>
  )
}

// ── ConnectorsSection ─────────────────────────────────────────────────────────

export function ConnectorsSection() {
  const { t } = useTranslation('settings')
  const [connectors, setConnectors] = React.useState<ConnectorStatus[]>([])
  const [loading, setLoading]       = React.useState(true)
  const [connecting, setConnecting] = React.useState<string | null>(null)
  const [error, setError]           = React.useState<string | null>(null)
  // refresh token to force a re-fetch after connect/disconnect
  const [refresh, setRefresh]       = React.useState(0)

  // ── Load connector statuses ─────────────────────────────────────────────────
  React.useEffect(() => {
    setLoading(true)
    window.tachi.connectors.list()
      .then(cs => { setConnectors(cs); setError(null) })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [refresh])

  // ── GitHub OAuth callbacks ──────────────────────────────────────────────────
  React.useEffect(() => {
    // Listen for the GitHub login completion event
    const unsub = window.tachi.aeon.onLoginDone(d => {
      setConnecting(null)
      if (d.ok) {
        setRefresh(r => r + 1)
      } else {
        setError(d.error ?? t('connectors.loginFailed'))
      }
    })
    return unsub
  }, [t])

  const handleConnect = (id: string) => {
    if (id !== 'github') return
    setConnecting(id)
    setError(null)
    // Reuse Aeon's existing OAuth Device Flow — same token, same keychain entry.
    window.tachi.aeon.loginStart().catch(err => {
      setConnecting(null)
      setError(String(err))
    })
  }

  const handleDisconnect = async (id: string) => {
    setError(null)
    try {
      await window.tachi.connectors.disconnect(id)
      setRefresh(r => r + 1)
    } catch (err) {
      setError(String(err))
    }
  }

  if (loading) {
    return (
      <div style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)', padding: 12 }}>
        {t('connectors.loading')}
      </div>
    )
  }

  return (
    <div>
      <div style={{
        border: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-hard)',
      }}>
        {/* No card-level header: this card renders inside the Settings
            "Sign-in / Other" Section wrapper, which already provides the
            heading — the old bg-inset "CONNECTORS" strip read as a second
            stacked section header (QA 2026-07-18). The row itself carries
            the GitHub name + description. */}

        {/* Connector rows */}
        {connectors.length === 0 ? (
          <div style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)', padding: 12 }}>
            {t('connectors.empty')}
          </div>
        ) : (
          connectors.map(c => (
            <ConnectorRow
              key={c.id}
              connector={c}
              connecting={connecting === c.id}
              onConnect={() => handleConnect(c.id)}
              onDisconnect={() => handleDisconnect(c.id)}
            />
          ))
        )}
      </div>

      {/* GitHub-specific note about /gh skill */}
      <div style={{
        ...MONO,
        fontSize: 9,
        color: 'var(--text-dim)',
        marginTop: 8,
        lineHeight: 1.5,
      }}>
        {t('connectors.ghNote.before')} <span style={{ color: 'var(--accent)' }}>/gh</span> {t('connectors.ghNote.after')}
      </div>

      {error && (
        <div style={{
          ...MONO,
          fontSize: 9,
          color: 'var(--destructive)',
          marginTop: 8,
          padding: '4px 8px',
          border: 'var(--border-width) solid var(--destructive)',
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
