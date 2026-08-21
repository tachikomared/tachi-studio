// apps/desktop/src/pages/openclaw/OpenClawDashboardView.tsx
//
// Embed OpenClaw's local dashboard (http://127.0.0.1:18789) inside the app
// via iframe — same model as AeonDashboardView. The user asked for "open
// inside the app window like Aeon dashboard, not in a browser tab".
//
// We don't need the full Aeon dance (download → npm install → spawn next dev)
// because OpenClaw runs as a system service the user installs themselves;
// we just probe the URL on mount and either show the iframe or a hint
// asking the user to start OpenClaw via `claw daemon start`.

import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const DASHBOARD_URL = 'http://127.0.0.1:18789/'

type Probe =
  | { state: 'probing' }
  | { state: 'ready' }
  | { state: 'unreachable'; error: string }

export function OpenClawDashboardView() {
  const { t } = useTranslation('openclaw')
  const [probe, setProbe] = useState<Probe>({ state: 'probing' })
  const [iframeKey, setIframeKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ── Probe ────────────────────────────────────────────────────────────────
  // Try hitting the dashboard root. CORS may block us reading the response,
  // but a network-level success (no `TypeError: fetch failed`) is enough to
  // tell us the port is bound. We use `no-cors` to avoid the preflight
  // round-trip; if it resolves at all, we treat it as up.
  const probeNow = () => {
    setProbe({ state: 'probing' })
    fetch(DASHBOARD_URL, { mode: 'no-cors', cache: 'no-store' })
      .then(() => setProbe({ state: 'ready' }))
      .catch(err => setProbe({
        state: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      }))
  }

  useEffect(() => {
    probeNow()
  }, [])

  // ── Layout ───────────────────────────────────────────────────────────────
  // Toolbar (refresh / open-external escape hatch / probe state) then the
  // iframe (or status card while not-ready).
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', width: '100%',
      background: 'var(--bg-base)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-dim)',
        }}>
          {t('header.title')}
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
        }}>
          {DASHBOARD_URL}
        </span>
        <span style={{ flex: 1 }} />
        <StatusBadge state={probe.state} />
        <ToolButton onClick={() => { setIframeKey(k => k + 1); probeNow() }} label={t('actions.reload')} />
        <ToolButton
          onClick={() => window.tachi.shell.openExternal(DASHBOARD_URL).catch(() => {})}
          label={t('actions.openInBrowser')}
        />
      </div>

      {/* Body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {probe.state === 'ready' && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={DASHBOARD_URL}
            style={{
              width: '100%', height: '100%',
              border: 'none',
              background: '#ffffff',
            }}
            title={t('iframe.title')}
          />
        )}
        {probe.state === 'probing' && (
          <CenterCard>
            <span style={{ fontWeight: 700 }}>{t('probing.label', { url: DASHBOARD_URL })}</span>
          </CenterCard>
        )}
        {probe.state === 'unreachable' && (
          <CenterCard>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              {t('unreachable.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 520 }}>
              {t('unreachable.hint')}
              <pre style={{
                marginTop: 8, marginBottom: 8,
                padding: '6px 10px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: 11,
              }}>
                claw daemon start
              </pre>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {probe.error}
              </span>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <ToolButton onClick={probeNow} label={t('actions.reload')} />
              <ToolButton
                onClick={() =>
                  window.tachi.shell.openExternal('https://docs.openclaw.ai/cli/dashboard/').catch(() => {})
                }
                label={t('actions.openDocs')}
              />
            </div>
          </CenterCard>
        )}
      </div>
    </div>
  )
}

// ── Small bits ───────────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: Probe['state'] }) {
  const { t } = useTranslation('openclaw')
  const map: Record<Probe['state'], { label: string; color: string }> = {
    probing:     { label: t('status.probing'),    color: 'var(--warning)' },
    ready:       { label: t('status.live'),       color: 'var(--success)' },
    unreachable: { label: t('status.offline'),    color: 'var(--danger, #ff5252)' },
  }
  const m = map[state]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '2px 8px',
      border: `2px solid ${m.color}`,
      color: m.color,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>
      <span style={{ width: 5, height: 5, background: m.color, display: 'inline-block' }} />
      {m.label}
    </span>
  )
}

function ToolButton({ onClick, label }: { onClick: () => void; label: string }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '4px 10px',
        border: '2px solid var(--border)',
        background: hover ? 'var(--bg-elevated)' : 'transparent',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        padding: 24,
        border: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        boxShadow: 'var(--shadow-hard)',
      }}>
        {children}
      </div>
    </div>
  )
}
