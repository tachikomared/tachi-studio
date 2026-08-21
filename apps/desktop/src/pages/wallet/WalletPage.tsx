import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../store/ui.store'
import type { WalletInfoView, WalletListEntry, AggregatedToken, NetworkDef } from '../../types/electron'
import { WalletSwitcher } from './components/WalletSwitcher'
import { NetworkSwitcher } from './components/NetworkSwitcher'
import { SendCard } from './components/SendCard'
import { FundingCard } from './components/FundingCard'
import { AgentLimitsCard } from './components/AgentLimitsCard'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

export const card: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)',
  boxShadow: 'var(--shadow-hard)', padding: 16, fontFamily: 'JetBrains Mono, monospace', marginBottom: 14,
}
export const lbl: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8 }
export const field: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', boxSizing: 'border-box',
}
export const primary = (on = true): React.CSSProperties => ({
  padding: '7px 14px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.5, boxShadow: 'var(--shadow-hard)',
})
export const ghost: React.CSSProperties = {
  padding: '7px 14px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
}
export const tokenColor = (s: string) => s === 'ETH' ? 'var(--text-primary)' : s === 'USDC' ? 'var(--success)' : s === 'TACHI' ? 'var(--accent)' : s === 'BNKR' ? 'var(--warning)' : 'var(--text-muted)'

function downloadJson(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function WalletPage() {
  const { t } = useTranslation('wallet')
  const hidden = useUIStore(s => s.balancesHidden)
  const toggleHidden = useUIStore(s => s.toggleBalances)

  // Active wallet (from the switcher) + selected network (null = all networks).
  const [selected, setSelected] = useState<WalletListEntry | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [networks, setNetworks] = useState<NetworkDef[]>([])

  // Per-wallet info (app wallet only — used for the legacy "no key yet" flow).
  const [info, setInfo] = useState<WalletInfoView | null>(null)
  const [tokens, setTokens] = useState<AggregatedToken[]>([])
  const [addr, setAddr] = useState<string | null>(null)
  const [loadingBal, setLoadingBal] = useState(false)
  const [busy, setBusy] = useState(false)

  const [pw, setPw] = useState('')
  const [impRaw, setImpRaw] = useState(''); const [impJson, setImpJson] = useState(''); const [impPw, setImpPw] = useState('')
  const [impName, setImpName] = useState('')
  const [newWallet, setNewWallet] = useState<{ address: string; privateKey: string } | null>(null)

  const isApp = selected?.id.kind === 'app'
  const agentName = selected?.id.kind === 'agent' ? selected.id.name! : null

  const loadInfo = useCallback(async () => setInfo(await window.tachi.wallet.getInfo()), [])

  // Aggregated balances for the selected wallet, scoped to the selected network.
  const loadBal = useCallback(async () => {
    if (!selected) { setTokens([]); setAddr(null); return }
    setLoadingBal(true)
    try {
      const res = await window.tachi.wallet.walletBalances({
        kind: selected.id.kind, name: selected.id.name, chainId: chainId ?? undefined,
      })
      setTokens(res.tokens); setAddr(res.address)
    } catch { setTokens([]); setAddr(selected.address) } finally { setLoadingBal(false) }
  }, [selected, chainId])

  useEffect(() => {
    loadInfo()
    window.tachi.wallet.listNetworks().then(setNetworks).catch(() => setNetworks([]))
    const off = window.tachi.wallet.onChanged((i) => { setInfo(i as WalletInfoView) })
    return off
  }, [loadInfo])

  // Reload balances whenever the active wallet / network changes (app wallet
  // only when it actually has a key).
  useEffect(() => {
    if (!selected) return
    if (selected.id.kind === 'app' && !selected.address) { setTokens([]); setAddr(null); return }
    loadBal()
  }, [selected, chainId, loadBal])

  const copy = () => { if (addr) { navigator.clipboard?.writeText(addr); toast('success', t('toast.addressCopied')) } }

  // ── App-wallet lifecycle (legacy routes — the shared nookplot/x402 account) ──
  const create = async () => { setBusy(true); try { const w = await window.tachi.wallet.create(); setNewWallet({ address: w.address, privateKey: w.privateKey }); await loadInfo() } finally { setBusy(false) } }
  const exportKs = async () => { setBusy(true); try { const { keystore } = await window.tachi.wallet.exportKeystore(pw); downloadJson(`wallet-${(addr ?? 'agent').slice(2, 8)}.json`, keystore); setPw(''); toast('success', t('toast.backupDownloaded')) } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }

  // Import scoped to the selected wallet: app wallet → legacy routes; agent
  // wallet → the named agent routes (a name is required for an agent import).
  const importRaw = async () => {
    setBusy(true)
    try {
      if (isApp) await window.tachi.wallet.importRaw(impRaw)
      else await window.tachi.wallet.importAgentWallet(impName.trim() || agentName || 'agent', impRaw)
      setImpRaw(''); toast('success', t('toast.walletImported')); loadBal()
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const importKs = async () => { setBusy(true); try { await window.tachi.wallet.importKeystore(impJson, impPw); setImpJson(''); setImpPw(''); toast('success', t('toast.walletImported')); loadBal() } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }

  const forget = async () => {
    if (isApp) { await window.tachi.wallet.forget(); toast('info', t('toast.walletRemoved')) }
    else if (agentName) { await window.tachi.wallet.forgetAgentWallet(agentName); toast('info', t('toast.agentWalletRemoved', { agentName })) }
    setTokens([])
  }

  const appHasNoKey = isApp && !info?.hasKey && !selected?.address

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, fontFamily: 'JetBrains Mono, monospace', background: 'var(--bg-base)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.04em', marginBottom: 4 }}>{t('header.title')}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>{t('header.subtitle')}</div>
          </div>
          <NetworkSwitcher value={chainId} onChange={setChainId} />
        </div>

        {/* Account switcher (App | agent wallets | + New) */}
        <WalletSwitcher onSelect={setSelected} />

        {appHasNoKey ? (
          newWallet ? (
            <div style={card}>
              <div style={{ ...lbl, color: 'var(--destructive)' }}>{t('newKey.backupNow')}</div>
              <div style={lbl}>{t('newKey.address')}</div>
              <code style={{ ...field, display: 'block', userSelect: 'all', wordBreak: 'break-all', marginBottom: 8 }}>{newWallet.address}</code>
              <div style={lbl}>{t('newKey.privateKey')}</div>
              <textarea readOnly value={newWallet.privateKey} onFocus={e => e.currentTarget.select()} rows={2} style={{ ...field, resize: 'none', userSelect: 'all', wordBreak: 'break-all', marginBottom: 10 }} />
              <button style={primary()} onClick={() => { setNewWallet(null); loadInfo(); loadBal() }}>{t('newKey.done')}</button>
            </div>
          ) : (
            <div style={card}>
              <div style={lbl}>{t('empty.title')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
                {t('empty.description')}
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <button style={primary(!busy)} disabled={busy} onClick={create}>{busy ? t('empty.creating') : t('empty.create')}</button>
              </div>
              <div style={lbl}>{t('empty.importKey')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" value={impRaw} onChange={e => setImpRaw(e.target.value)} placeholder={t('empty.keyPlaceholder')} style={field} />
                <button style={ghost} disabled={busy || !impRaw.trim()} onClick={importRaw}>{t('empty.import')}</button>
              </div>
            </div>
          )
        ) : selected ? (
          <>
            {/* Account + aggregated balances */}
            <div style={card}>
              <div style={lbl}>{t('account.title', { label: selected.label })}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <code style={{ ...field, flex: 1, userSelect: 'all', wordBreak: 'break-all' }}>{addr ?? t('account.noAddress')}</code>
                <button style={ghost} onClick={copy}>{t('account.copy')}</button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={lbl}>{t('balances.title')} {chainId == null ? t('balances.allNetworks') : t('balances.networkSuffix', { network: networks.find(n => n.id === chainId)?.name ?? chainId })}</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <button style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer' }} onClick={toggleHidden}>{hidden ? t('balances.show') : t('balances.hide')}</button>
                  <button style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer' }} onClick={loadBal}>{loadingBal ? t('balances.refreshing') : t('balances.refresh')}</button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {(tokens.length ? tokens : [{ symbol: 'ETH', total: '·', byChain: [] }]).map(t => (
                  <div key={t.symbol} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: tokenColor(t.symbol) }}>{t.symbol}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{hidden ? '•••' : t.total}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Send — native + any ERC-20 (or raw contract) on the selected network */}
            <SendCard wallet={selected} networks={networks} chainId={chainId} />

            {/* Agent-only: App→agent funding + agent-signer limits */}
            {agentName && (
              <>
                <FundingCard agentName={agentName} chainId={chainId ?? 8453} />
                <AgentLimitsCard agentName={agentName} />
              </>
            )}

            {/* Backup (app wallet only — keystore export operates on the shared key) */}
            {isApp && (
              <div style={card}>
                <div style={lbl}>{t('backup.title')}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>{t('backup.description')}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}><div style={lbl}>{t('backup.password')}</div><input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••" style={field} /></div>
                  <button style={primary(!busy && pw.length >= 8)} disabled={busy || pw.length < 8} onClick={exportKs}>{t('backup.download')}</button>
                </div>
              </div>
            )}

            {/* Switch / import — scoped to the selected wallet */}
            <div style={card}>
              <div style={lbl}>{isApp ? t('switch.title') : t('switch.replaceTitle', { label: selected.label })}</div>
              <div style={{ fontSize: 9, color: 'var(--destructive)', marginBottom: 10 }}>{t('switch.warning')}</div>
              {!isApp && (
                <div style={{ marginBottom: 8 }}>
                  <div style={lbl}>{t('switch.agentName')}</div>
                  <input value={impName} onChange={e => setImpName(e.target.value)} placeholder={agentName ?? 'agent'} style={field} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input type="password" value={impRaw} onChange={e => setImpRaw(e.target.value)} placeholder={t('switch.keyPlaceholder')} style={field} />
                <button style={ghost} disabled={busy || !impRaw.trim()} onClick={importRaw}>{t('switch.importKey')}</button>
              </div>
              {isApp && (
                <>
                  <div style={lbl}>{t('switch.orKeystore')}</div>
                  <textarea value={impJson} onChange={e => setImpJson(e.target.value)} rows={2} placeholder='{"version":3,…}' style={{ ...field, resize: 'vertical', fontSize: 10, marginBottom: 8 }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="password" value={impPw} onChange={e => setImpPw(e.target.value)} placeholder={t('switch.keystorePassword')} style={field} />
                    <button style={ghost} disabled={busy || !impJson.trim() || !impPw} onClick={importKs}>{t('switch.importKeystore')}</button>
                  </div>
                </>
              )}
            </div>

            {/* Danger */}
            <div style={{ ...card, borderColor: 'var(--destructive)' }}>
              <div style={lbl}>{t('danger.title')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {isApp && <button style={ghost} disabled={busy} onClick={create}>{t('danger.generate')}</button>}
                <button style={{ ...ghost, color: 'var(--destructive)', borderColor: 'var(--destructive)' }} onClick={forget}>{isApp ? t('danger.forget') : t('danger.forgetNamed', { label: selected.label })}</button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
