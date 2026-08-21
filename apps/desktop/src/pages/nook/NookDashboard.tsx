import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'

const card: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)',
  boxShadow: 'var(--shadow-hard)', padding: 12, fontFamily: 'JetBrains Mono, monospace', marginBottom: 12,
}
const sectionLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)',
  textTransform: 'uppercase', marginBottom: 6,
}
const secondaryBtn: React.CSSProperties = {
  display: 'block', width: '100%', padding: '6px 12px', border: 'none', background: 'transparent',
  color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer', textAlign: 'left',
}
const primaryBtn: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 12px', border: 'var(--border-width) solid var(--accent)',
  background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
  fontWeight: 700, cursor: 'pointer', textAlign: 'left', boxShadow: 'var(--shadow-hard)',
}

function trunc(a: string | null): string {
  if (!a) return '—'
  return a.length < 14 ? a : a.slice(0, 8) + '…' + a.slice(-6)
}

// `status` is a stable logic key (drives colour + status label); `nameKey`/the
// status label are resolved via t() at render so the layer list localizes.
const layers = [
  ['1', 'identity', 'complete'], ['2', 'storage', 'complete'], ['3', 'registry', 'complete'],
  ['4', 'communication', 'complete'], ['5', 'action', 'complete'], ['6', 'coordination', 'complete'],
  ['7', 'economy', 'live'], ['8', 'governance', 'coming'],
] as const
const layerColor = (s: string) => s === 'complete' ? 'var(--accent)' : s === 'live' ? 'var(--success)' : 'var(--text-dim)'

interface McpStatus { registered: boolean; credentialsReady: boolean; status?: string; toolCount?: number }

// Toggle that exposes the full nookplot toolset to the app's LLM agents
// (Chat/Code/Swarm) by running @nookplot/mcp as a managed MCP server.
function McpCard() {
  const { t } = useTranslation('nook')
  const [st, setSt] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)

  React.useEffect(() => { window.tachi.nook.mcpStatus().then(setSt).catch(() => {}) }, [])

  const running = st?.status === 'running' || st?.status === 'connected'

  const toggle = async () => {
    setBusy(true)
    try {
      setSt(running ? await window.tachi.nook.mcpDisable() : await window.tachi.nook.mcpEnable())
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'success', text: running ? t('mcp.toast.stopped') : t('mcp.toast.started') } }))
    } catch (e) {
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: e instanceof Error ? e.message : String(e) } }))
    } finally { setBusy(false) }
  }

  return (
    <div style={card}>
      <div style={sectionLabel}>{t('mcp.title')}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
        {t('mcp.description')}
        {running && st?.toolCount ? ` ${t('mcp.toolsLive', { count: st.toolCount })}` : ''}
      </div>
      {!st?.credentialsReady && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>{t('mcp.needKey')}</div>
      )}
      <button
        style={running ? { ...secondaryBtn, color: 'var(--destructive)' } : primaryBtn}
        disabled={busy || !st?.credentialsReady}
        onClick={toggle}
      >
        {busy ? '…' : running ? t('mcp.disable') : t('mcp.enable')}
      </button>
    </div>
  )
}

interface DarksolMcpStatus { registered: boolean; walletReady: boolean; darksolReady: boolean; status?: string; toolCount?: number }

// Toggle that exposes the darksol harness toolset (price/gas/wallet-balance/
// portfolio/market/swap/send/wiretap-*) to the app's LLM agents + Nodes workflows
// by running the darksol MCP shim as a managed MCP server.
function DarksolMcpCard() {
  const { t } = useTranslation('nook')
  const [st, setSt] = useState<DarksolMcpStatus | null>(null)
  const [busy, setBusy] = useState(false)

  React.useEffect(() => { window.tachi.nook.darksolMcpStatus().then(setSt).catch(() => {}) }, [])

  const running = st?.status === 'running' || st?.status === 'connected'
  const ready = !!st?.walletReady && !!st?.darksolReady

  const toggle = async () => {
    setBusy(true)
    try {
      setSt(running ? await window.tachi.nook.darksolMcpDisable() : await window.tachi.nook.darksolMcpEnable())
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'success', text: running ? t('darksol.toast.stopped') : t('darksol.toast.started') } }))
    } catch (e) {
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: e instanceof Error ? e.message : String(e) } }))
    } finally { setBusy(false) }
  }

  return (
    <div style={card}>
      <div style={sectionLabel}>{t('darksol.title')}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
        {t('darksol.description')}
        {running && st?.toolCount ? ` ${t('darksol.toolsLive', { count: st.toolCount })}` : ''}
      </div>
      {!st?.walletReady && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>{t('darksol.needWallet')}</div>
      )}
      {st?.walletReady && !st?.darksolReady && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>{t('darksol.needInstall')}</div>
      )}
      <button
        style={running ? { ...secondaryBtn, color: 'var(--destructive)' } : primaryBtn}
        disabled={busy || !ready}
        onClick={toggle}
      >
        {busy ? '…' : running ? t('darksol.disable') : t('darksol.enable')}
      </button>
    </div>
  )
}

export function NookDashboard() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const setStatus = useNookStore(s => s.setStatus)
  const [pk, setPk] = useState('')
  const [savingPk, setSavingPk] = useState(false)

  const open = (url: string) => window.tachi.shell.openExternal(url)

  const disconnect = async () => setStatus(await window.tachi.nook.disconnect())
  const forget = async () => setStatus(await window.tachi.nook.clearCredentials())

  const addKey = async () => {
    if (!pk.trim()) return
    setSavingPk(true)
    try {
      await window.tachi.nook.configure({ privateKey: pk.trim() })
      // Reconnect so the runtime picks up signing capability.
      await window.tachi.nook.disconnect()
      setStatus(await window.tachi.nook.connect())
      setPk('')
    } finally { setSavingPk(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 12, padding: 16, alignItems: 'flex-start', fontFamily: 'JetBrains Mono, monospace' }}>
      {/* Left */}
      <div style={{ flex: 1 }}>
        <div style={card}>
          <div style={sectionLabel}>{t('identity.title')}</div>
          <div style={{ fontSize: 11, color: 'var(--text-primary)', marginBottom: 4, wordBreak: 'break-all' }}>{trunc(status?.address ?? null)}</div>
          {status?.name && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{status.name}</div>}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>{t('identity.rep')} {status?.reputation ?? 0}</div>
          <button style={secondaryBtn} onClick={disconnect}>{t('identity.disconnect')}</button>
          <button style={{ ...secondaryBtn, color: 'var(--destructive)' }} onClick={forget}>{t('identity.forget')}</button>
        </div>

        <div style={card}>
          <div style={sectionLabel}>{t('credits.title')}</div>
          <div style={{ fontSize: 24, color: 'var(--accent)', fontWeight: 700, marginBottom: 6 }}>
            {status?.credits != null ? status.credits.toLocaleString() : '—'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            {t('credits.description')}
          </div>
          <button style={primaryBtn} onClick={() => open('https://nookplot.com/settings')}>{t('credits.buy')}</button>
        </div>

        <McpCard />

        <DarksolMcpCard />

        {/* Signing key — unlocks on-chain actions */}
        {!status?.hasPrivateKey && (
          <div style={{ ...card, borderColor: 'var(--accent)' }}>
            <div style={sectionLabel}>{t('unlock.title')}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
              {t('unlock.description')}
            </div>
            <input
              type="password" value={pk} onChange={e => setPk(e.target.value)} placeholder="0x…"
              style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
            />
            <button style={{ ...primaryBtn, opacity: savingPk || !pk.trim() ? 0.5 : 1 }} disabled={savingPk || !pk.trim()} onClick={addKey}>
              {savingPk ? t('unlock.saving') : t('unlock.addKey')}
            </button>
          </div>
        )}
      </div>

      {/* Right */}
      <div style={{ flex: 1 }}>
        <div style={card}>
          <div style={sectionLabel}>{t('networkStats.title')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[['20', 'contracts'], ['400+', 'endpoints'], ['35', 'managers'], ['BASE', 'chain']].map(([v, l]) => (
              <div key={l} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{v}</div>
                <div style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t(`networkStats.${l}`)}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={card}>
          <div style={sectionLabel}>{t('protocol.title')}</div>
          {layers.map(([n, name, st]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, padding: '3px 0', borderBottom: 'var(--border-width) solid var(--border)', color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--text-dim)', minWidth: 12 }}>{n}</span>
              <span style={{ flex: 1 }}>{t(`protocol.layers.${name}`)}</span>
              <span style={{ color: layerColor(st), fontWeight: 600 }}>{t(`protocol.status.${st}`)}</span>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={sectionLabel}>{t('resources.title')}</div>
          {[['nookplot.com', 'https://nookplot.com'], ['GitHub', 'https://github.com/nookprotocol'], ['Gateway API', 'https://gateway.nookplot.com']].map(([l, u]) => (
            <button key={l} style={{ ...secondaryBtn, padding: '4px 0' }} onClick={() => open(u)}>{l}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
