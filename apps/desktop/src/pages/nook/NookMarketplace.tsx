import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'
import type { NookListingView } from '../../types/electron'

const DOMAINS = ['all', 'research', 'code-review', 'data-analysis', 'translation', 'math'] as const
type DomainFilter = (typeof DOMAINS)[number]

type TokenSymbol = 'USDC' | 'NOOK' | 'BOTCOIN'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

// ── Hire (create agreement) modal ───────────────────────────────────────────
function HireModal({ listing, onClose, onHired }: { listing: NookListingView; onClose: () => void; onHired: () => void }) {
  const { t } = useTranslation('nook')
  const [terms, setTerms] = useState('')
  const [token, setToken] = useState<TokenSymbol>('USDC')
  const [amount, setAmount] = useState('')
  const [deadline, setDeadline] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
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
      await window.tachi.nookActions.hireService({
        listingId: listing.id, terms, deadline: deadlineUnix,
        token, amount: amount.trim() || undefined,
      })
      toast('success', t('hire.toast.created'))
      onHired()
      onClose()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setSubmitting(false) }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', boxShadow: 'var(--shadow-hard)', padding: 16, fontFamily: 'JetBrains Mono, monospace', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>{t('hire.title', { title: listing.title })}</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('hire.listingMeta', { id: listing.id, price: listing.priceDisplay })}</div>
        <div>
          <label style={label}>{t('hire.terms')}</label>
          <textarea value={terms} onChange={e => setTerms(e.target.value)} placeholder={t('hire.termsPlaceholder')} rows={4} style={{ ...field, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>{t('hire.escrowToken')}</label>
            <select value={token} onChange={e => setToken(e.target.value as TokenSymbol)} style={field}>
              {(['USDC', 'NOOK', 'BOTCOIN'] as TokenSymbol[]).map(tok => <option key={tok} value={tok}>{tok}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>{t('hire.escrowAmount')}</label>
            <input value={amount} onChange={e => setAmount(e.target.value)} placeholder={t('hire.amountPlaceholder')} inputMode="decimal" style={field} />
          </div>
        </div>
        <div>
          <label style={label}>{t('hire.deadline')}</label>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={field} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={submitting} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer' }}>{t('common.cancel')}</button>
          <button onClick={submit} disabled={submitting} style={{ padding: '5px 12px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer' }}>{submitting ? t('hire.creating') : t('hire.submit')}</button>
        </div>
      </div>
    </div>
  )
}

export function NookMarketplace() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const [listings, setListings] = useState<NookListingView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [domain, setDomain] = useState<DomainFilter>('all')
  const [hiring, setHiring] = useState<NookListingView | null>(null)

  const connected = !!status?.connected

  const load = useCallback(async () => {
    if (!connected) return
    setLoading(true); setError(null)
    try {
      setListings(await window.tachi.nook.listListings({ limit: 30 }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [connected])

  useEffect(() => { load() }, [load])

  const filtered = domain === 'all' ? listings : listings.filter(l => l.domains.includes(domain))
  const shortAddr = (a: string) => !a ? '' : a.length <= 12 ? a : a.slice(0, 6) + '…' + a.slice(-4)

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
    border: `var(--border-width) solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'JetBrains Mono, monospace' }}>
      {hiring && <HireModal listing={hiring} onClose={() => setHiring(null)} onHired={load} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('marketplace.title')}</div>
        <button onClick={load} disabled={loading} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer' }}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)', flexWrap: 'wrap' }}>
        {DOMAINS.map(d => <button key={d} onClick={() => setDomain(d)} style={chip(domain === d)}>{t(`marketplace.domains.${d}`)}</button>)}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {!connected && <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>{t('common.connecting')}</div>}
        {connected && error && <div style={{ padding: 12, fontSize: 11, color: 'var(--destructive)' }}>{t('common.error')} {error}</div>}
        {connected && !error && !loading && filtered.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>{t('marketplace.noServices')}</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {filtered.map(l => (
            <div key={l.id} style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-hard)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>{l.title}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45, maxHeight: 44, overflow: 'hidden' }}>{l.description}</div>
              {l.domains.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {l.domains.slice(0, 4).map(d => <span key={d} style={{ fontSize: 9, padding: '1px 5px', border: 'var(--border-width) solid var(--border)', color: 'var(--text-dim)' }}>{d}</span>)}
                </div>
              )}
              <div style={{ borderTop: 'var(--border-width) solid var(--border)', paddingTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{shortAddr(l.provider)}</span>
                <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>{l.priceDisplay}</span>
              </div>
              <button onClick={() => connected ? setHiring(l) : toast('error', t('common.connectFirst'))} title={status?.hasPrivateKey ? t('marketplace.hireTitle') : t('marketplace.hireNeedKey')} style={{ padding: '4px 10px', border: 'var(--border-width) solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>{t('marketplace.hire')}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
