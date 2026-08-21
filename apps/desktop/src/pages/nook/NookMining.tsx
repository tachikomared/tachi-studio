// apps/desktop/src/pages/nook/NookMining.tsx
//
// Real mining: live track stats + open challenges + rewards, with in-app
// "solve once" / "start loop" actions driven by the runtime MiningManager.
// No CLI — the knowledge solver runs through the gateway (spends credits).

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'
import type { NookTrackStat, NookMiningChallengeView, NookMiningRewardsView, NookMiningStats } from '../../types/electron'

const mono = 'JetBrains Mono, monospace'
const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

const sectionLabel: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 8, fontFamily: mono }
const diffColor = (d: string) => d === 'easy' ? 'var(--success)' : d === 'hard' ? 'var(--destructive)' : 'var(--warning)'

function fmtNook(wei: string): string {
  // baseReward may be a wei string (18d) or a plain number; show a compact value.
  try {
    if (/^\d{16,}$/.test(wei)) { const n = BigInt(wei) / 10n ** 16n; return (Number(n) / 100).toString() }
    return String(Number(wei) || 0)
  } catch { return wei }
}

export function NookMining() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const connected = !!status?.connected
  const hasKey = !!status?.hasPrivateKey

  const [tracks, setTracks] = useState<NookTrackStat[]>([])
  const [challenges, setChallenges] = useState<NookMiningChallengeView[]>([])
  const [rewards, setRewards] = useState<NookMiningRewardsView | null>(null)
  const [stats, setStats] = useState<NookMiningStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!connected) return
    setLoading(true)
    try {
      const [t, c, r, s] = await Promise.all([
        window.tachi.nookMining.getTrackStats().catch(() => []),
        window.tachi.nookMining.listChallenges({ limit: 30 }).catch(() => []),
        window.tachi.nookMining.getRewards().catch(() => null),
        window.tachi.nookMining.stats().catch(() => null),
      ])
      setTracks(t); setChallenges(c); setRewards(r); setStats(s)
    } finally { setLoading(false) }
  }, [connected])

  useEffect(() => { load() }, [load])
  // Poll stats while the loop is running.
  useEffect(() => {
    if (!stats?.running) return
    const id = setInterval(async () => { try { setStats(await window.tachi.nookMining.stats()) } catch { /* ignore */ } }, 5000)
    return () => clearInterval(id)
  }, [stats?.running])

  const solveOnce = async () => {
    setBusy(true)
    try {
      const s = await window.tachi.nookMining.solveOnce() as NookMiningStats & { detail?: string }
      setStats(s)
      if (s.submitted > 0) toast('success', t('mining.toast.submitted', { count: s.submitted }))
      else toast(s.errors > 0 ? 'error' : 'info', s.detail ? t('mining.toast.nothingDetail', { detail: s.detail }) : t('mining.toast.tickDone', { skipped: s.skipped, errors: s.errors }))
    }
    catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const toggleLoop = async () => {
    setBusy(true)
    try {
      if (stats?.running) { await window.tachi.nookMining.stopLoop(); toast('info', t('mining.toast.loopStopped')) }
      else { await window.tachi.nookMining.startLoop({ maxCredits: 2000 }); toast('success', t('mining.toast.loopStarted')) }
      setStats(await window.tachi.nookMining.stats())
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const primary = (on = true): React.CSSProperties => ({
    display: 'block', width: '100%', padding: '8px 12px', border: 'var(--border-width) solid var(--accent)',
    background: 'var(--accent)', color: '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700,
    cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.5, textAlign: 'left', boxShadow: 'var(--shadow-hard)', marginBottom: 8,
  })
  const ghost: React.CSSProperties = { display: 'block', width: '100%', padding: '7px 12px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: mono, fontSize: 11, cursor: 'pointer' }

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: mono }}>
      {/* Left: rewards + controls + tracks */}
      <div style={{ width: 340, flexShrink: 0, borderRight: 'var(--border-width) solid var(--border)', overflowY: 'auto' }}>
        <div style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div style={sectionLabel}>{t('mining.rewardsTitle')}</div>
          {([['pending', rewards?.pendingNook], ['claimable', rewards?.claimableNook], ['epoch', rewards?.epoch]] as const).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-dim)' }}>{t(`mining.rewards.${k}`)}</span>
              <span style={{ color: k === 'claimable' && Number(v) > 0 ? 'var(--accent)' : 'var(--text-primary)', fontWeight: k === 'claimable' ? 700 : 400 }}>{v == null ? '—' : String(v)}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div style={sectionLabel}>{t('mining.solveTitle')}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
            {t('mining.solveIntroPre')}<b>{t('mining.solveIntroBold')}</b>{t('mining.solveIntroPost')}
          </div>
          <button style={primary(connected && hasKey && !busy)} disabled={!connected || !hasKey || busy} onClick={solveOnce}>{busy ? t('mining.working') : t('mining.solveOne')}</button>
          <button
            style={stats?.running ? { ...ghost, color: 'var(--destructive)', border: 'var(--border-width) solid var(--destructive)' } : ghost}
            disabled={!connected || !hasKey || busy}
            onClick={toggleLoop}
          >{stats?.running ? t('mining.stopLoop') : t('mining.startLoop')}</button>
          {!hasKey && <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6 }}>{t('mining.needKey')}</div>}
          {stats && (stats.ticks > 0 || stats.running) && (
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.6 }}>
              {t('mining.stats', { ticks: stats.ticks, submitted: stats.submitted, skipped: stats.skipped, errors: stats.errors, credits: stats.creditsSpent })}
            </div>
          )}
        </div>

        <div style={{ padding: 12 }}>
          <div style={sectionLabel}>{t('mining.tracksTitle')}</div>
          {tracks.length === 0 && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{loading ? t('common.loading') : t('mining.noTracks')}</div>}
          {tracks.map(tr => (
            <div key={tr.track} style={{ border: 'var(--border-width) solid var(--border)', padding: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{tr.track}</span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('mining.openCount', { count: tr.openCount })}</span>
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
                {t('mining.trackStats', { rate: (tr.successRate * 100).toFixed(0), avg: fmtNook(String(tr.avgRewardNook)) })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: open challenges */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.04em' }}>{t('mining.openChallenges')}</div>
          <button onClick={load} disabled={loading} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: mono, fontSize: 11, cursor: 'pointer' }}>{loading ? t('common.loading') : t('common.refresh')}</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!connected && <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('mining.connecting')}</div>}
          {connected && !loading && challenges.length === 0 && <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('mining.noChallenges')}</div>}
          {challenges.map(c => (
            <div key={c.id} style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flexShrink: 0, padding: '2px 6px', border: `var(--border-width) solid ${diffColor(c.difficulty)}`, color: diffColor(c.difficulty), fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>{c.difficulty}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{c.title}</span>
                    <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtNook(c.rewardNook)} NOOK</span>
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', margin: '2px 0 4px' }}>
                    <span style={{ marginRight: 8 }}>{c.track}</span>
                    <span style={{ marginRight: 8 }}>{t('mining.submissions', { count: c.submissionCount, max: c.maxSubmissions || '∞' })}</span>
                    {c.domainTags.slice(0, 3).map(tag => <span key={tag} style={{ marginRight: 6, color: 'var(--accent)' }}>#{tag}</span>)}
                  </div>
                  {c.description && <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>{c.description.length > 160 ? c.description.slice(0, 160) + '…' : c.description}</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
