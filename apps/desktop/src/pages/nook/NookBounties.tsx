import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'
import type { NookBountyView } from '../../types/electron'

type TokenFilter = 'USDC' | 'NOOK' | 'BOTCOIN'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

const rewardColor = (t: string) => t === 'USDC' ? 'var(--success)' : t === 'NOOK' ? 'var(--accent)' : t === 'BOTCOIN' ? 'var(--warning)' : 'var(--text-muted)'

// Returns the localized label plus an `expired` flag so callers can pick the
// destructive colour without string-matching the translated text.
function deadlineText(unix: number, t: (key: string, opts?: Record<string, unknown>) => string): { label: string; expired: boolean } {
  if (!unix) return { label: '', expired: false }
  const days = Math.ceil((unix * 1000 - Date.now()) / 86_400_000)
  return days <= 0
    ? { label: t('bounties.expired'), expired: true }
    : { label: t('bounties.expiresIn', { days }), expired: false }
}

// ── Post Bounty modal ─────────────────────────────────────────────────────────
function PostBountyModal({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const { t } = useTranslation('nook')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [community, setCommunity] = useState('')
  const [token, setToken] = useState<TokenFilter>('USDC')
  const [amount, setAmount] = useState('')
  // default deadline: 7 days out, as a yyyy-mm-dd date input
  const [deadline, setDeadline] = useState(() => {
    const d = new Date(Date.now() + 7 * 86_400_000)
    return d.toISOString().slice(0, 10)
  })
  const [submitting, setSubmitting] = useState(false)

  const field: React.CSSProperties = {
    border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
    color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
    padding: '6px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
  }
  const label: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--text-dim)', marginBottom: 4, display: 'block',
  }

  const submit = async () => {
    const deadlineUnix = Math.floor(new Date(deadline + 'T23:59:59').getTime() / 1000)
    setSubmitting(true)
    try {
      const res = await window.tachi.nookActions.postBounty({ title, description, community, token, amount, deadline: deadlineUnix })
      toast('success', res?.bountyId != null ? t('postBounty.toast.postedId', { id: res.bountyId }) : t('postBounty.toast.posted'))
      onPosted()
      onClose()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setSubmitting(false) }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 420, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', boxShadow: 'var(--shadow-hard)', padding: 16, fontFamily: 'JetBrains Mono, monospace', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>{t('postBounty.title')}</div>

        <div>
          <label style={label}>{t('postBounty.community')}</label>
          <input value={community} onChange={e => setCommunity(e.target.value)} placeholder={t('postBounty.communityPlaceholder')} style={field} />
        </div>
        <div>
          <label style={label}>{t('postBounty.titleLabel')}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('postBounty.titlePlaceholder')} style={field} />
        </div>
        <div>
          <label style={label}>{t('postBounty.description')}</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('postBounty.descriptionPlaceholder')} rows={4} style={{ ...field, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>{t('postBounty.rewardToken')}</label>
            <select value={token} onChange={e => setToken(e.target.value as TokenFilter)} style={field}>
              {(['USDC', 'NOOK', 'BOTCOIN'] as TokenFilter[]).map(tok => <option key={tok} value={tok}>{tok}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>{t('postBounty.amount')}</label>
            <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="250" inputMode="decimal" style={field} />
          </div>
        </div>
        <div>
          <label style={label}>{t('postBounty.deadline')}</label>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={field} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={submitting} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer' }}>{t('common.cancel')}</button>
          <button onClick={submit} disabled={submitting} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer' }}>{submitting ? t('postBounty.posting') : t('postBounty.submit')}</button>
        </div>
      </div>
    </div>
  )
}

export function NookBounties() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const [bounties, setBounties] = useState<NookBountyView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [community, setCommunity] = useState('')
  const [tokens, setTokens] = useState<Set<TokenFilter>>(new Set())
  const [openOnly, setOpenOnly] = useState(true)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  const [showPost, setShowPost] = useState(false)
  const [applyFor, setApplyFor] = useState<string | null>(null)
  const [applyMsg, setApplyMsg] = useState('')

  const connected = !!status?.connected

  const load = useCallback(async () => {
    if (!connected) return
    setLoading(true); setError(null)
    try {
      setBounties(await window.tachi.nook.listBounties({ limit: 30 }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [connected])

  useEffect(() => { load() }, [load])

  // Sidebar "+ Post bounty" dispatches this to open the composer.
  useEffect(() => {
    const open = () => setShowPost(true)
    window.addEventListener('nook:post-bounty', open as EventListener)
    return () => window.removeEventListener('nook:post-bounty', open as EventListener)
  }, [])

  const toggleToken = (t: TokenFilter) =>
    setTokens(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })

  const claim = async (id: string) => {
    setClaiming(id)
    try {
      await window.tachi.nook.claimBounty(id)
      toast('success', t('bounties.toast.claimed', { id }))
      load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setClaiming(null) }
  }

  // window.prompt() is unsupported in Electron's renderer — use an in-app modal.
  const apply = (id: string) => { setApplyMsg(''); setApplyFor(id) }

  const submitApply = async () => {
    const id = applyFor
    if (!id || !applyMsg.trim()) return
    setApplying(id)
    try {
      await window.tachi.nookActions.applyBounty({ id, message: applyMsg.trim() })
      toast('success', t('bounties.toast.applied', { id }))
      setApplyFor(null); setApplyMsg(''); load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setApplying(null) }
  }

  const filtered = bounties.filter(b => {
    if (community && !b.community.toLowerCase().includes(community.toLowerCase())) return false
    if (tokens.size > 0 && !tokens.has(b.rewardToken as TokenFilter)) return false
    if (openOnly && b.status !== 'open') return false
    return true
  })

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
    border: `var(--border-width) solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'JetBrains Mono, monospace' }}>
      {showPost && <PostBountyModal onClose={() => setShowPost(false)} onPosted={load} />}

      {applyFor && (
        <div onClick={() => setApplyFor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 440, maxWidth: '90vw', background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', boxShadow: 'var(--shadow-hard)', padding: 16, fontFamily: 'JetBrains Mono, monospace', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>{t('applyModal.title', { id: applyFor })}</div>
            <textarea autoFocus value={applyMsg} onChange={e => setApplyMsg(e.target.value)} placeholder={t('applyModal.placeholder')} rows={5}
              style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '6px 8px', outline: 'none', resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setApplyFor(null)} disabled={applying === applyFor} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer' }}>{t('common.cancel')}</button>
              <button onClick={submitApply} disabled={applying === applyFor || !applyMsg.trim()} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, cursor: applyMsg.trim() ? 'pointer' : 'not-allowed', opacity: applyMsg.trim() ? 1 : 0.5 }}>{applying === applyFor ? t('bounties.applying') : t('applyModal.submit')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('bounties.title')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer' }}>
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
          <button
            onClick={() => connected ? setShowPost(true) : toast('error', t('common.connectFirst'))}
            title={status?.hasPrivateKey ? t('bounties.postTitle') : t('bounties.postNeedKey')}
            style={{ padding: '4px 10px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
          >{t('bounties.post')}</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)', flexWrap: 'wrap' }}>
        <input value={community} onChange={e => setCommunity(e.target.value)} placeholder={t('bounties.filterCommunity')} style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, padding: '4px 8px', outline: 'none' }} />
        {(['USDC', 'NOOK', 'BOTCOIN'] as TokenFilter[]).map(tok => (
          <button key={tok} onClick={() => toggleToken(tok)} style={chip(tokens.has(tok))}>{tok}</button>
        ))}
        <button onClick={() => setOpenOnly(o => !o)} style={chip(openOnly)}>{openOnly ? t('bounties.openOnly') : t('bounties.all')}</button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!connected && <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('common.connecting')}</div>}
        {connected && error && <div style={{ padding: 24, fontSize: 11, color: 'var(--destructive)' }}>{t('common.error')} {error}</div>}
        {connected && !error && !loading && filtered.length === 0 && (
          <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('bounties.noMatch')}</div>
        )}
        {filtered.map(b => (
          <div key={b.id} style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flexShrink: 0, padding: '2px 6px', border: `var(--border-width) solid ${rewardColor(b.rewardToken)}`, color: rewardColor(b.rewardToken), fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {b.rewardDisplay}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{b.title}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: b.status === 'open' ? 'var(--success)' : 'var(--text-dim)' }}>{b.status}</span>
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-dim)', margin: '2px 0 4px' }}>
                  {b.community && <span style={{ marginRight: 8 }}>#{b.community}</span>}
                  {(() => { const dl = deadlineText(b.deadline, t); return <span style={{ color: dl.expired ? 'var(--destructive)' : 'var(--text-dim)' }}>{dl.label}</span> })()}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 6 }}>
                  {b.description.length > 160 ? b.description.slice(0, 160) + '…' : b.description}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('bounties.applicants', { count: b.applicationCount })}</span>
                  {b.status === 'open' && (
                    <>
                      <button
                        onClick={() => apply(b.id)}
                        disabled={applying === b.id}
                        title={t('bounties.applyTitle')}
                        style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: applying === b.id ? 'wait' : 'pointer' }}
                      >
                        {applying === b.id ? t('bounties.applying') : t('bounties.apply')}
                      </button>
                      <button
                        onClick={() => claim(b.id)}
                        disabled={claiming === b.id}
                        title={status?.hasPrivateKey ? t('bounties.claimTitle') : t('bounties.claimNeedKey')}
                        style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: claiming === b.id ? 'wait' : 'pointer' }}
                      >
                        {claiming === b.id ? t('bounties.claiming') : t('bounties.claim')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
