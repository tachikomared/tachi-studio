// apps/desktop/src/pages/wallet/components/FundingCard.tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { card, lbl, field, primary } from '../WalletPage'
const toast = (k: string, t: string) => window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: k, text: t } }))
export function FundingCard({ agentName, chainId }: { agentName: string; chainId: number }) {
  const { t } = useTranslation('wallet')
  const [amt, setAmt] = useState(''); const [busy, setBusy] = useState(false)
  const move = async () => {
    setBusy(true)
    try { const { hash } = await window.tachi.wallet.fundAgentWallet({ toAgent: agentName, chainId, amountEth: amt.trim() }); toast('success', t('funding.toast.success', { hash: hash.slice(0, 12) })); setAmt('') }
    catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div style={{ ...card, borderColor: 'var(--accent)' }}>
      <div style={lbl}>{t('funding.title', { agentName })}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}><div style={lbl}>{t('funding.amount')}</div><input style={field} value={amt} onChange={e => setAmt(e.target.value)} placeholder="0.05" inputMode="decimal" /></div>
        <button style={primary(!busy && !!amt.trim())} disabled={busy || !amt.trim()} onClick={move}>{busy ? t('funding.moving') : t('funding.move')}</button>
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6 }}>{t('funding.note')}</div>
    </div>
  )
}
