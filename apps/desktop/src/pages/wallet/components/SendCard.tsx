// apps/desktop/src/pages/wallet/components/SendCard.tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { card, lbl, field, primary } from '../WalletPage'
import type { WalletListEntry, NetworkDef } from '../../../types/electron'

const toast = (kind: string, text: string) => window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

export function SendCard({ wallet, networks, chainId }: { wallet: WalletListEntry; networks: NetworkDef[]; chainId: number | null }) {
  const { t } = useTranslation('wallet')
  const [tokenSymbol, setTokenSymbol] = useState('ETH')
  const [to, setTo] = useState(''); const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const net = chainId ?? networks[0]?.id ?? 8453
  const send = async () => {
    setBusy(true)
    try {
      const { hash } = await window.tachi.wallet.sendToken({
        kind: wallet.id.kind, name: wallet.id.name, chainId: net, tokenSymbol, to: to.trim(), amount: amount.trim(),
      })
      toast('success', t('send.toast.success', { hash: hash.slice(0, 12) })); setTo(''); setAmount('')
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div style={{ ...card, borderColor: 'var(--accent)' }}>
      <div style={lbl}>{t('send.title')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div><div style={lbl}>{t('send.token')}</div><input style={{ ...field, width: 120 }} value={tokenSymbol} onChange={e => setTokenSymbol(e.target.value)} placeholder={t('send.tokenPlaceholder')} /></div>
        <div style={{ flex: 2, minWidth: 180 }}><div style={lbl}>{t('send.recipient')}</div><input style={field} value={to} onChange={e => setTo(e.target.value)} placeholder={t('send.recipientPlaceholder')} /></div>
        <div style={{ width: 120 }}><div style={lbl}>{t('send.amount')}</div><input style={field} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" /></div>
        <button style={primary(!busy && !!to.trim() && !!amount.trim())} disabled={busy || !to.trim() || !amount.trim()} onClick={send}>{busy ? t('send.sending') : t('send.send')}</button>
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6 }}>{t('send.note')}</div>
    </div>
  )
}
