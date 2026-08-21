import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUIStore } from '../store/ui.store'
import type { WalletInfoView, WalletBalances } from '../types/electron'

const tokenColor = (s: string) =>
  s === 'ETH' ? 'var(--text-primary)' : s === 'USDC' ? 'var(--success)' : s === 'TACHI' ? 'var(--accent)' : s === 'BNKR' ? 'var(--warning)' : 'var(--text-muted)'

/**
 * Compact app-wide wallet card pinned in the sidebar. Shows the Base balances
 * (ETH / TACHI / BNKR / USDC) at a glance; click to open the full WalletPanel
 * for send / receive / backup / switch.
 */
export function WalletWidget() {
  const navigate = useNavigate()
  const openPanel = () => navigate('/wallet')
  const hidden = useUIStore(s => s.balancesHidden)
  const toggleHidden = useUIStore(s => s.toggleBalances)
  const [info, setInfo] = useState<WalletInfoView | null>(null)
  const [bal, setBal] = useState<WalletBalances | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeLabel, setActiveLabel] = useState('App')

  const loadActiveLabel = useCallback(async () => {
    try {
      const list = await window.tachi.wallet.listWallets()
      const active = list.find(e => e.active)
      setActiveLabel(active ? active.label : 'App')
    } catch { setActiveLabel('App') }
  }, [])

  const loadInfo = useCallback(async () => { setInfo(await window.tachi.wallet.getInfo()) }, [])
  const loadBal = useCallback(async () => {
    setLoading(true)
    try { setBal(await window.tachi.wallet.getBalances()) } catch { setBal(null) } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadInfo()
    loadActiveLabel()
    const off = window.tachi.wallet.onChanged((i) => { setInfo(i as WalletInfoView); setBal(null); loadBal(); loadActiveLabel() })
    return off
  }, [loadInfo, loadBal, loadActiveLabel])

  useEffect(() => { if (info?.hasKey) loadBal() }, [info?.hasKey, loadBal])

  const addr = info?.address ?? null
  const shortAddr = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
  const rows = bal ? [bal.native, ...bal.tokens] : [{ symbol: 'ETH', amount: '·' }, { symbol: 'TACHI', amount: '·' }, { symbol: 'BNKR', amount: '·' }, { symbol: 'USDC', amount: '·' }]

  return (
    <div style={{
      margin: 12, border: 'var(--border-width) solid var(--border-strong)', background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)', fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
    }}>
      {/* Header */}
      <button
        onClick={() => openPanel()}
        title="Open wallet"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 9px',
          background: 'transparent', border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
          cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <span style={{ width: 7, height: 7, background: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.08em' }}>WALLET</span>
        {addr && <span style={{ fontSize: 9, color: 'var(--text-dim)', marginLeft: 'auto' }}>{shortAddr}</span>}
        <span
          role="button"
          onClick={(e) => { e.stopPropagation(); toggleHidden() }}
          title={hidden ? 'Show balances' : 'Hide balances'}
          style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: addr ? 6 : 'auto', cursor: 'pointer' }}
        >{hidden ? '🙈' : '👁'}</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 4 }}>⤢</span>
      </button>

      {/* Active account label (App | darksol agent wallet) */}
      <div style={{ fontSize: 9, color: 'var(--text-dim)', padding: '3px 9px', borderBottom: 'var(--border-width) solid var(--border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeLabel}</div>

      {!info?.hasKey ? (
        <div style={{ padding: 9 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 6 }}>No wallet yet · Base</div>
          <button
            onClick={() => openPanel()}
            style={{
              width: '100%', padding: '6px 8px', border: 'var(--border-width) solid var(--accent)',
              background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10, fontWeight: 700, cursor: 'pointer',
            }}
          >Create / import</button>
        </div>
      ) : (
        <div style={{ padding: '6px 9px' }}>
          {rows.map(t => (
            <div key={t.symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: tokenColor(t.symbol) }}>{t.symbol}</span>
              <span style={{ fontSize: 10, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                {hidden ? '•••' : (loading && !bal ? '…' : t.amount)}
              </span>
            </div>
          ))}
          <button
            onClick={(e) => { e.stopPropagation(); loadBal() }}
            style={{ width: '100%', marginTop: 4, border: 'none', background: 'transparent', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, cursor: 'pointer', textAlign: 'right' }}
          >{loading ? 'refreshing…' : '↻ refresh'}</button>
        </div>
      )}
    </div>
  )
}
