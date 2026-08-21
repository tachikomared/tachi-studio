import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

const sectionLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)',
  textTransform: 'uppercase', marginBottom: 6,
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function NookAutonomous() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const feed = useNookStore(s => s.feed)
  const clearFeed = useNookStore(s => s.clearFeed)
  const setStatus = useNookStore(s => s.setStatus)

  const brainProvider = useNookStore(s => s.brainProvider)
  const setBrainProvider = useNookStore(s => s.setBrainProvider)
  const brainModel = useNookStore(s => s.brainModel)
  const setBrainModel = useNookStore(s => s.setBrainModel)
  const [providers, setProviders] = useState<{ id: string; label: string; available: boolean; reason?: string; defaultModel: string }[]>([])
  const [models, setModels] = useState<string[]>([])

  const [approvals, setApprovals] = useState<Record<string, unknown>[]>([])
  const [busy, setBusy] = useState(false)

  const online = !!status?.online
  const canAct = !!status?.hasPrivateKey
  const current = providers.find(p => p.id === brainProvider)

  const loadApprovals = useCallback(async () => {
    try { setApprovals((await window.tachi.nook.getApprovals()) as Record<string, unknown>[]) } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadApprovals() }, [loadApprovals, feed.length])
  // Providers are TachiDesk's own (same as Chat/Code/Nodes) — keys already in the app.
  useEffect(() => { window.tachi.nook.listBrainProviders().then(setProviders).catch(() => {}) }, [])
  // Models come from the app's existing per-provider model discovery.
  useEffect(() => {
    let alive = true
    window.tachi.provider.listModels(brainProvider)
      .then((res: unknown) => {
        const arr = Array.isArray(res) ? res : (res as { models?: unknown[] })?.models ?? []
        const ids = (arr as Record<string, unknown>[]).map(m => String(m.id ?? m.name ?? m)).filter(Boolean)
        if (alive) setModels(ids)
      })
      .catch(() => { if (alive) setModels([]) })
    return () => { alive = false }
  }, [brainProvider])
  // Keep main-process brain in sync (mining uses the same provider+model).
  useEffect(() => { window.tachi.nook.setBrain(brainProvider, brainModel || undefined).catch(() => {}) }, [brainProvider, brainModel])

  const toggle = async () => {
    if (!online && current && !current.available) {
      const reason = current.reason ?? t('autonomous.toast.providerUnavailable', { provider: brainProvider })
      toast('error', t('autonomous.toast.cantGoOnline', { reason }))
      return
    }
    setBusy(true)
    try {
      if (online) {
        setStatus(await window.tachi.nook.goOffline())
        toast('info', t('autonomous.toast.offline'))
      } else {
        const s = await window.tachi.nook.goOnline(brainProvider, brainModel || undefined)
        setStatus(s)
        if (s.online) {
          toast('success', t('autonomous.toast.online', { provider: current?.label ?? brainProvider }))
          window.tachi.nook.getApprovals().then(a => setApprovals(a as Record<string, unknown>[])).catch(() => {})
        } else {
          toast('error', s.error ?? t('autonomous.toast.couldNotGoOnline'))
        }
      }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const decide = async (id: string, approve: boolean) => {
    try {
      if (approve) await window.tachi.nook.approveAction(id)
      else await window.tachi.nook.rejectAction(id)
      toast('success', approve ? t('autonomous.toast.approved') : t('autonomous.toast.rejected'))
      loadApprovals()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    }
  }

  const idOf = (a: Record<string, unknown>) => String(a.id ?? a.actionId ?? '')
  const descOf = (a: Record<string, unknown>) => String(a.description ?? a.action ?? a.type ?? JSON.stringify(a).slice(0, 80))

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: 'JetBrains Mono, monospace' }}>
      {/* Left: control + approvals */}
      <div style={{ width: 340, flexShrink: 0, borderRight: 'var(--border-width) solid var(--border)', overflowY: 'auto' }}>
        <div style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div style={sectionLabel}>{t('autonomous.title')}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
            {t('autonomous.intro')}{' '}<b>{t('autonomous.introScanner')}</b>{t('autonomous.introScannerNote')}<b>{t('autonomous.introResponder')}</b>{t('autonomous.introResponderNote')}{' '}<b>{t('autonomous.introStops')}</b>
          </div>

          {/* Agent brain — YOUR providers (same as Chat / Code / Nodes). Powers
              both the autonomous responder AND the mining solver. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4 }}>{t('autonomous.brainProvider')}</div>
            <select value={brainProvider} disabled={online} onChange={e => { setBrainProvider(e.target.value); setBrainModel('') }}
              style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', marginBottom: 8 }}>
              {providers.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.label}{p.available ? '' : ` — ${p.reason ?? t('autonomous.unavailable')}`}</option>)}
            </select>

            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4 }}>{t('autonomous.model')}</div>
            {models.length > 0 ? (
              <select value={brainModel} disabled={online} onChange={e => setBrainModel(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none' }}>
                <option value="">{t('autonomous.modelDefault', { model: current?.defaultModel ?? 'auto' })}</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input value={brainModel} disabled={online} onChange={e => setBrainModel(e.target.value)} placeholder={t('autonomous.modelPlaceholder', { model: current?.defaultModel ?? 'auto' })}
                style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', boxSizing: 'border-box' }} />
            )}

            <div style={{ fontSize: 9, color: current?.available ? 'var(--text-dim)' : 'var(--warning)', marginTop: 6 }}>
              {current?.available
                ? t('autonomous.providerOk')
                : (current?.reason ?? t('autonomous.providerUnavailableHint'))}
            </div>
          </div>

          <button
            onClick={toggle}
            disabled={busy || !canAct}
            title={canAct ? '' : t('autonomous.needKeyTitle')}
            style={{
              display: 'block', width: '100%', padding: '8px 12px',
              border: `var(--border-width) solid ${online ? 'var(--destructive)' : 'var(--accent)'}`,
              background: online ? 'transparent' : 'var(--accent)',
              color: online ? 'var(--destructive)' : '#fff',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
              cursor: busy || !canAct ? 'not-allowed' : 'pointer', opacity: busy || !canAct ? 0.5 : 1,
              textAlign: 'left', boxShadow: online ? 'none' : 'var(--shadow-hard)',
            }}
          >
            {busy ? (online ? t('autonomous.stopping') : t('autonomous.starting')) : online ? t('autonomous.goOffline') : t('autonomous.goOnline')}
          </button>

          {/* Live online status so it's obvious something is happening */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: busy ? 'var(--warning)' : online ? 'var(--success)' : 'var(--text-dim)' }} />
            <span style={{ color: online ? 'var(--success)' : 'var(--text-dim)', fontWeight: 700 }}>
              {busy ? (online ? t('autonomous.statusStopping') : t('autonomous.statusStarting')) : online ? t('autonomous.statusOnline') : t('autonomous.statusOffline')}
            </span>
            {online && !busy && (
              <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
                {current?.label ?? brainProvider} · {t('autonomous.signals', { count: feed.length })}
              </span>
            )}
          </div>
          {!canAct && <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6 }}>{t('autonomous.needKeyHint')}</div>}
        </div>

        <div style={{ padding: 12 }}>
          <div style={sectionLabel}>{t('autonomous.approvalQueue', { count: approvals.length })}</div>
          {approvals.length === 0 && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('autonomous.noApprovals')}</div>}
          {approvals.map((a, i) => (
            <div key={idOf(a) || i} style={{ border: 'var(--border-width) solid var(--border)', padding: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-primary)', lineHeight: 1.4, marginBottom: 6 }}>{descOf(a)}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => decide(idOf(a), true)} style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--success)', background: 'transparent', color: 'var(--success)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{t('autonomous.approve')}</button>
                <button onClick={() => decide(idOf(a), false)} style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--destructive)', background: 'transparent', color: 'var(--destructive)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{t('autonomous.reject')}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: live event feed */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.04em' }}>{t('autonomous.liveFeed')}</div>
          <button onClick={clearFeed} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer' }}>{t('autonomous.clear')}</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {feed.length === 0 && (
            <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('autonomous.feedEmpty')}
            </div>
          )}
          {feed.map((ev, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 12px', borderBottom: 'var(--border-width) solid var(--border)', fontSize: 10 }}>
              <span style={{ color: 'var(--text-dim)', minWidth: 30 }}>{timeAgo(ev.at)}</span>
              <span style={{ color: 'var(--accent)', fontWeight: 700, minWidth: 140 }}>{ev.type}</span>
              <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {typeof ev.data === 'object' ? JSON.stringify(ev.data).slice(0, 120) : String(ev.data)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
