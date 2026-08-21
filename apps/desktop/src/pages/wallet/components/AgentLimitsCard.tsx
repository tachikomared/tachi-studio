// apps/desktop/src/pages/wallet/components/AgentLimitsCard.tsx
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { card, lbl, field, primary } from '../WalletPage'
import type { AgentLimits } from '../../../types/electron'
const toast = (k: string, t: string) => window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: k, text: t } }))
export function AgentLimitsCard({ agentName }: { agentName: string }) {
  const { t } = useTranslation('wallet')
  const [l, setL] = useState<AgentLimits>({ maxPerTradeEth: '0.05', dailyLimitEth: '0.20', dryRun: true, allowlist: [] })
  useEffect(() => { window.tachi.wallet.getAgentLimits(agentName).then(setL).catch(() => {}) }, [agentName])
  const save = async () => { try { await window.tachi.wallet.setAgentLimits({ name: agentName, limits: l }); toast('success', t('limits.toast.saved')) } catch (e) { toast('error', String(e)) } }
  return (
    <div style={{ ...card, borderColor: 'var(--accent)' }}>
      <div style={lbl}>{t('limits.title')}</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>{t('limits.maxPerTrade')}</div><input style={field} value={l.maxPerTradeEth} onChange={e => setL({ ...l, maxPerTradeEth: e.target.value })} /></div>
        <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>{t('limits.daily')}</div><input style={field} value={l.dailyLimitEth} onChange={e => setL({ ...l, dailyLimitEth: e.target.value })} /></div>
        <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>{t('limits.dryRun')}</div>
          <button style={{ ...field, cursor: 'pointer', color: l.dryRun ? 'var(--success)' : 'var(--text-muted)', fontWeight: 700 }} onClick={() => setL({ ...l, dryRun: !l.dryRun })}>{l.dryRun ? t('limits.on') : t('limits.off')}</button>
        </div>
      </div>
      <button style={primary(true)} onClick={save}>{t('limits.save')}</button>
    </div>
  )
}
