import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore, type NookView } from '../../store/nook.store'
import type { NookWalletInfo } from '../../types/electron'
import { NookDashboard } from './NookDashboard'
import { NookBounties } from './NookBounties'
import { NookMarketplace } from './NookMarketplace'
import { NookAutonomous } from './NookAutonomous'
import { NookMining } from './NookMining'
import { NookNetwork } from './NookNetwork'
import { NookMessaging } from './NookMessaging'

const TABS: { id: NookView; labelKey: string }[] = [
  { id: 'dashboard',   labelKey: 'tabs.dashboard' },
  { id: 'bounties',    labelKey: 'tabs.bounties' },
  { id: 'marketplace', labelKey: 'tabs.marketplace' },
  { id: 'autonomous',  labelKey: 'tabs.autonomous' },
  { id: 'mining',      labelKey: 'tabs.mining' },
  { id: 'network',     labelKey: 'tabs.network' },
  { id: 'messages',    labelKey: 'tabs.messages' },
]

const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-base)',
  border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', boxSizing: 'border-box',
}
const label: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)',
  textTransform: 'uppercase', marginBottom: 4,
}
const primary = (enabled = true): React.CSSProperties => ({
  display: 'block', width: '100%', padding: '8px 12px',
  border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
  textAlign: 'left', boxShadow: 'var(--shadow-hard)',
})
const ghost: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 12px', border: 'var(--border-width) solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11, fontWeight: 700, cursor: 'pointer', textAlign: 'left',
}

/** Map a raw gateway/registration error to a short, human message. */
function friendlyRegError(e: unknown, t: (key: string) => string): string {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (m.includes('409') || m.includes('already')) return t('register.errors.already')
  if (m.includes('429') || m.includes('rate')) return t('register.errors.rate')
  if (m.includes('signature verification') || m.includes('nonce')) return t('register.errors.signature')
  if (m.includes('privacy') || m.includes('egress') || m.includes('blocked')) return t('register.errors.privacy')
  if (m.includes('403')) return t('register.errors.refused')
  return e instanceof Error ? e.message : t('register.errors.generic')
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace' }}>
      {children}
    </div>
  )
}
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100%', padding: '40px 24px' }}>
      <div style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-hard)', padding: 24, width: '100%', maxWidth: 440 }}>
        {children}
      </div>
    </div>
  )
}
function Title({ sub }: { sub: string }) {
  return (
    <>
      <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.05em', marginBottom: 6 }}>NOOK PROTOCOL</div>
      <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 14 }}>{sub}</div>
    </>
  )
}

export function NookPage() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const view   = useNookStore(s => s.view)
  const setStatus = useNookStore(s => s.setStatus)
  const pushFeed  = useNookStore(s => s.pushFeed)
  const setView   = useNookStore(s => s.setView)

  const [mode, setMode] = useState<'import' | 'create'>('import')
  const [pk, setPk] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [backup, setBackup] = useState<NookWalletInfo | null>(null)
  const [skipReg, setSkipReg] = useState(false)
  // In-app registration (Step C) form + progress.
  const [agentName, setAgentName] = useState('')
  const [agentDesc, setAgentDesc] = useState('')
  const [regPhase, setRegPhase] = useState<'idle' | 'working' | 'done'>('idle')
  const [regError, setRegError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    window.tachi.nook.getStatus().then(s => { if (mounted) setStatus(s) }).catch(() => {})
    const offStatus = window.tachi.nook.onStatus(s => setStatus(s as never))
    const offEvent  = window.tachi.nook.onEvent(e => pushFeed(e as never))
    return () => { mounted = false; offStatus(); offEvent() }
  }, [setStatus, pushFeed])

  // Auto-connect ONCE when credentials first appear. Never auto-retry on status
  // changes — a failing connect would otherwise loop (connecting↔offline blink).
  // After an error the user retries explicitly via the banner button.
  const triedConnect = useRef(false)
  useEffect(() => {
    const hasCreds = status?.hasApiKey || status?.hasPrivateKey
    if (!hasCreds || backup) return
    if (status?.connected || status?.connecting || status?.error) return
    if (triedConnect.current) return
    triedConnect.current = true
    window.tachi.nook.connect().then(setStatus).catch(() => {})
  }, [status, backup, setStatus])

  const retryConnect = async () => {
    triedConnect.current = true
    setStatus(await window.tachi.nook.connect())
  }

  // Forget the stored wallet/key and return to the import screen so the user can
  // switch to a different agent (e.g. the one they already registered on the web).
  const resetCreds = async () => {
    setBusy(true)
    try { setStatus(await window.tachi.nook.clearCredentials()) }
    finally { setBackup(null); setSkipReg(false); setPk(''); setApiKey(''); triedConnect.current = false; setBusy(false) }
  }

  const hasCreds = !!(status?.hasApiKey || status?.hasPrivateKey)

  // ── Step A: no credentials → connect (import-first) ──────────────────────────
  if (!hasCreds && !backup) {
    const importAndConnect = async () => {
      setBusy(true)
      try {
        await window.tachi.nook.configure({ privateKey: pk, apiKey })
        triedConnect.current = true
        setStatus(await window.tachi.nook.connect())
        setPk(''); setApiKey('')
      } finally { setBusy(false) }
    }
    return (
      <Shell><Centered>
        {mode !== 'create' ? (
          <>
            <Title sub={t('connect.title')} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 18 }}>
              {t('connect.intro')}
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={label}>{t('connect.privateKeyLabel')}</div>
              <input type="password" value={pk} onChange={e => setPk(e.target.value)} placeholder="0x…" style={input} onKeyDown={e => { if (e.key === 'Enter' && (pk.trim() || apiKey.trim())) importAndConnect() }} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={label}>{t('connect.apiKeyLabel')}</div>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="nk_…" style={input} onKeyDown={e => { if (e.key === 'Enter' && (pk.trim() || apiKey.trim())) importAndConnect() }} />
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.5 }}>
              {t('connect.keyHint')}
            </div>
            <button style={{ ...primary(!!pk.trim() || !!apiKey.trim()), marginBottom: 14 }} disabled={busy || (!pk.trim() && !apiKey.trim())} onClick={importAndConnect}>
              {busy ? t('connect.connecting') : t('connect.connect')}
            </button>
            <div style={{ borderTop: 'var(--border-width) solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>{t('connect.noAgentYet')}</div>
              <button style={ghost} onClick={() => setMode('create')}>{t('connect.createNew')}</button>
            </div>
          </>
        ) : (
          <>
            <Title sub={t('create.title')} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 18 }}>
              {t('create.intro')}
            </div>
            <button style={{ ...primary(), marginBottom: 10 }} disabled={busy} onClick={async () => {
              setBusy(true)
              try { setBackup(await window.tachi.nook.generateWallet()) } finally { setBusy(false) }
            }}>{busy ? t('create.generating') : t('create.generate')}</button>
            <button style={ghost} onClick={() => setMode('import')}>{t('create.backToImport')}</button>
          </>
        )}
        <div style={{ marginTop: 14, fontSize: 10, color: 'var(--text-dim)' }}>
          {t('connect.docs')}{' '}
          <span onClick={() => window.tachi.shell.openExternal('https://nookplot.com/docs/getting-started')} style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>getting-started</span>
        </div>
      </Centered></Shell>
    )
  }

  // ── Step B: freshly generated wallet → one-time backup ───────────────────────
  if (backup) {
    return (
      <Shell><Centered>
        <Title sub={t('backup.title')} />
        <div style={{ fontSize: 11, color: 'var(--destructive)', lineHeight: 1.5, marginBottom: 12 }}>
          {t('backup.warning')}
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={label}>{t('backup.addressLabel')}</div>
          <div style={{ ...input, userSelect: 'all', wordBreak: 'break-all' }}>{backup.address}</div>
        </div>
        {backup.mnemonic && (
          <div style={{ marginBottom: 14 }}>
            <div style={label}>{t('backup.recoveryLabel')}</div>
            <textarea readOnly value={backup.mnemonic} onFocus={e => e.currentTarget.select()} style={{ ...input, height: 54, resize: 'none', userSelect: 'all', wordBreak: 'break-word' }} />
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>{t('backup.recoveryHint')}</div>
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <div style={label}>{t('backup.privateKeyLabel')}</div>
          <textarea readOnly value={backup.privateKey} onFocus={e => e.currentTarget.select()} style={{ ...input, height: 54, resize: 'none', userSelect: 'all', wordBreak: 'break-all' }} />
        </div>
        <button style={{ ...primary(), marginBottom: 10 }} onClick={async () => {
          setBusy(true)
          try {
            const s = await window.tachi.nook.connect()
            setStatus(s); setBackup(null)
          } finally { setBusy(false) }
        }} disabled={busy}>{busy ? t('connect.connecting') : t('backup.saved')}</button>
        <button style={ghost} disabled={busy} onClick={resetCreds}>{t('backup.discard')}</button>
      </Centered></Shell>
    )
  }

  // ── Step C: wallet not yet registered on-chain → registration handoff ────────
  // Brand-new on-chain registration is a one-time, two-signature gasless flow the
  // gateway runs on nookplot.com (the runtime SDK doesn't expose the bootstrap
  // signature scheme). We generate the wallet in-app, then hand off that single
  // step; afterwards "reconnect" mints the session key and the app drives the rest.
  if (status?.registered === false && !skipReg) {
    const doRegister = async () => {
      if (!agentName.trim()) { setRegError(t('register.errors.nameRequired')); return }
      setRegError(null); setRegPhase('working'); setBusy(true)
      try {
        const s = await window.tachi.nook.registerInApp({ name: agentName.trim(), description: agentDesc.trim() || undefined })
        setRegPhase('done'); setStatus(s)
      } catch (e) {
        setRegPhase('idle'); setRegError(friendlyRegError(e, t))
      } finally { setBusy(false) }
    }
    const regLabel = regPhase === 'working' ? t('register.registering') : regPhase === 'done' ? t('register.registered') : t('register.register')
    return (
      <Shell><Centered>
        <Title sub={t('register.title')} />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          {t('register.intro')}
        </div>
        {status.address && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>{t('register.walletLabel')}</div>
            <div style={{ ...input, userSelect: 'all', wordBreak: 'break-all' }}>{status.address}</div>
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <div style={label}>{t('register.nameLabel')}</div>
          <input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder={t('register.namePlaceholder')} style={input}
            onKeyDown={e => { if (e.key === 'Enter' && agentName.trim() && !busy) doRegister() }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={label}>{t('register.descLabel')}</div>
          <input value={agentDesc} onChange={e => setAgentDesc(e.target.value)} placeholder={t('register.descPlaceholder')} style={input} />
        </div>
        <button style={{ ...primary(!busy && !!agentName.trim() && regPhase !== 'done'), marginBottom: 10 }}
          disabled={busy || !agentName.trim() || regPhase === 'done'} onClick={doRegister}>
          {regLabel}
        </button>
        <button style={{ ...ghost, marginBottom: 10 }} disabled={busy} onClick={async () => {
          setBusy(true); try { setStatus(await window.tachi.nook.connect()) } finally { setBusy(false) }
        }}>{busy && regPhase !== 'working' ? t('register.checking') : t('register.reconnect')}</button>
        <button style={{ ...ghost, marginBottom: 10 }} disabled={busy} onClick={resetCreds}>{t('register.useDifferent')}</button>
        <button style={ghost} onClick={() => setSkipReg(true)}>{t('register.browseReadOnly')}</button>
        {(regError || status.error) && <div style={{ marginTop: 12, fontSize: 10, color: 'var(--destructive)' }}>{regError || status.error}</div>}
      </Centered></Shell>
    )
  }

  // ── Connected shell ──────────────────────────────────────────────────────────
  const connStateLabel = status?.connecting ? t('conn.connecting') : status?.connected ? t('conn.connected') : t('conn.offline')
  const dot = status?.connected ? 'var(--success)' : status?.connecting ? 'var(--warning)' : 'var(--text-dim)'

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)' }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setView(tab.id)} style={{
            padding: '4px 12px', border: 'none',
            background: view === tab.id ? 'var(--accent-muted)' : 'transparent',
            color: view === tab.id ? 'var(--accent-text)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: view === tab.id ? 700 : 400, cursor: 'pointer',
          }}>
            {t(tab.labelKey)}
            {tab.id === 'autonomous' && status?.online && <span style={{ marginLeft: 5, width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {status?.registered === false && (
          <button onClick={() => setSkipReg(false)} style={{ marginRight: 10, padding: '2px 8px', border: 'var(--border-width) solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>{t('shell.register')}</button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-dim)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />{connStateLabel}
        </div>
      </div>

      {status?.error && !status.connected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: 'var(--border-width) solid var(--border)', background: 'rgba(212,63,0,0.08)' }}>
          <span style={{ fontSize: 10, color: 'var(--destructive)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('shell.connectionFailed')} {status.error}
          </span>
          <button onClick={retryConnect} style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{t('shell.retry')}</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {view === 'dashboard' && <div style={{ flex: 1, overflowY: 'auto' }}><NookDashboard /></div>}
        {view === 'bounties'    && <NookBounties />}
        {view === 'marketplace' && <NookMarketplace />}
        {view === 'autonomous'  && <NookAutonomous />}
        {view === 'mining'      && <NookMining />}
        {view === 'network'     && <NookNetwork />}
        {view === 'messages'    && <NookMessaging />}
      </div>
    </Shell>
  )
}
