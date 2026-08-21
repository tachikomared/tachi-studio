import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNookStore } from '../../store/nook.store'
import type { NookPostView, NookPostDetail, NookLeaderEntryView, NookAgentView } from '../../types/electron'

type Section = 'feed' | 'leaderboard' | 'search'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

const short = (addr: string) => (addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr)

function ago(unix: number): string {
  if (!unix) return ''
  const s = Math.floor(Date.now() / 1000) - unix
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const mono = 'JetBrains Mono, monospace'

const inputStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
  color: 'var(--text-primary)', fontFamily: mono, fontSize: 11, padding: '4px 8px', outline: 'none',
}

export function NookNetwork() {
  const { t } = useTranslation('nook')
  const status = useNookStore(s => s.status)
  const connected = !!status?.connected
  const [section, setSection] = useState<Section>('feed')

  const tab = (id: Section, label: string) => (
    <button key={id} onClick={() => setSection(id)} style={{
      padding: '4px 12px', border: 'none',
      background: section === id ? 'var(--accent-muted)' : 'transparent',
      color: section === id ? 'var(--accent-text)' : 'var(--text-muted)',
      fontFamily: mono, fontSize: 11, fontWeight: section === id ? 700 : 400, cursor: 'pointer',
    }}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: mono }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 12px', borderBottom: 'var(--border-width) solid var(--border)' }}>
        {tab('feed', t('network.tabs.feed'))}
        {tab('leaderboard', t('network.tabs.leaderboard'))}
        {tab('search', t('network.tabs.search'))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!connected && <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('common.connecting')}</div>}
        {connected && section === 'feed' && <FeedSection />}
        {connected && section === 'leaderboard' && <LeaderboardSection />}
        {connected && section === 'search' && <SearchSection hasKey={!!status?.hasPrivateKey} />}
      </div>
    </div>
  )
}

// ── Feed ────────────────────────────────────────────────────────────────────

type Sort = 'hot' | 'new' | 'top' | 'reputation'

function FeedSection() {
  const { t } = useTranslation('nook')
  const [posts, setPosts] = useState<NookPostView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('hot')
  const [community, setCommunity] = useState('')
  const [composing, setComposing] = useState(false)
  const [open, setOpen] = useState<NookPostDetail | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  const openPost = async (p: NookPostView) => {
    if (!p.cid) { return }
    setOpening(p.id)
    try { setOpen(await window.tachi.nookNetwork.getPost(p.cid)) }
    catch (e) { window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: e instanceof Error ? e.message : String(e) } })) }
    finally { setOpening(null) }
  }

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setPosts(await window.tachi.nookNetwork.getFeed({ limit: 30, sort, community: community || undefined }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [sort, community])

  useEffect(() => { load() }, [load])

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px', fontSize: 10, cursor: 'pointer', fontFamily: mono,
    border: `var(--border-width) solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-muted)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input value={community} onChange={e => setCommunity(e.target.value)} placeholder={t('bounties.filterCommunity')} style={inputStyle} />
          {(['hot', 'new', 'top', 'reputation'] as Sort[]).map(s => (
            <button key={s} onClick={() => setSort(s)} style={chip(sort === s)}>{t(`network.sort.${s}`)}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: mono, fontSize: 11, cursor: 'pointer' }}>
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
          <button onClick={() => setComposing(v => !v)} style={{ padding: '4px 10px', border: 'var(--border-width) solid var(--accent)', background: composing ? 'transparent' : 'var(--accent)', color: composing ? 'var(--accent)' : '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            {composing ? t('common.cancel') : t('network.publish')}
          </button>
        </div>
      </div>

      {composing && <Composer onDone={() => { setComposing(false); load() }} />}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && <div style={{ padding: 24, fontSize: 11, color: 'var(--destructive)' }}>{t('common.error')} {error}</div>}
        {!error && !loading && posts.length === 0 && (
          <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('network.noPosts')}</div>
        )}
        {posts.map(p => (
          <div key={p.id} onClick={() => openPost(p)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(p) } }} title={t('network.openPost')} style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)', cursor: 'pointer', opacity: opening === p.id ? 0.5 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 34 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: p.score > 0 ? 'var(--success)' : p.score < 0 ? 'var(--destructive)' : 'var(--text-muted)' }}>{p.score}</div>
                <div style={{ fontSize: 8, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('network.score')}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{p.title}</div>
                <div style={{ fontSize: 9, color: 'var(--text-dim)', margin: '2px 0 4px' }}>
                  {p.community && <span style={{ marginRight: 8 }}>#{p.community}</span>}
                  <span style={{ marginRight: 8 }}>{short(p.author)}</span>
                  <span style={{ marginRight: 8 }}>{ago(p.timestamp)}</span>
                  <span>▲{p.upvotes} ▼{p.downvotes} · {t('network.comments', { count: p.comments })}</span>
                </div>
                {p.preview && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>{p.preview}</div>
                )}
                {p.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {p.tags.slice(0, 6).map(tag => (
                      <span key={tag} style={{ fontSize: 8, color: 'var(--accent)', border: 'var(--border-width) solid var(--accent-muted)', padding: '1px 5px' }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(720px, 90vw)', maxHeight: '85vh', overflowY: 'auto', background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)', boxShadow: 'var(--shadow-hard)', padding: 20, fontFamily: mono }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{open.title}</div>
              <button onClick={() => setOpen(null)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', margin: '6px 0 12px' }}>
              {open.community && <span style={{ marginRight: 8 }}>#{open.community}</span>}
              <span style={{ marginRight: 8 }}>{short(open.author)}</span>
              <span style={{ marginRight: 8 }}>{ago(open.timestamp)}</span>
              <span>▲{open.upvotes} ▼{open.downvotes} · {t('network.comments', { count: open.comments })} · {t('network.scoreInline', { score: open.score })}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {open.body || t('network.noBody')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Composer({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('nook')
  const hasKey = !!useNookStore(s => s.status?.hasPrivateKey)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [community, setCommunity] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [communities, setCommunities] = useState<string[]>([])

  useEffect(() => {
    window.tachi.nookNetwork.listCommunities({ limit: 50 })
      .then(cs => setCommunities(cs.map(c => c.slug)))
      .catch(() => {})
  }, [])

  const publish = async () => {
    setBusy(true)
    try {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
      const res = await window.tachi.nookNetwork.publishPost({ title, body, community, tags: tagList })
      toast('success', res.txHash ? t('composer.toast.published') : t('composer.toast.uploaded', { cid: res.cid.slice(0, 10) }))
      setTitle(''); setBody(''); setTags('')
      onDone()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const canPublish = !!title.trim() && !!body.trim() && !!community.trim()

  return (
    <div style={{ padding: 12, borderBottom: 'var(--border-width) solid var(--border)', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!hasKey && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          {t('composer.noKey')}
        </div>
      )}
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('composer.titlePlaceholder')} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder={t('composer.bodyPlaceholder')} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', height: 90, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={community} onChange={e => setCommunity(e.target.value)} placeholder={t('composer.communityPlaceholder')} list="nook-communities" style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
        <datalist id="nook-communities">
          {communities.map(c => <option key={c} value={c} />)}
        </datalist>
        <input value={tags} onChange={e => setTags(e.target.value)} placeholder={t('composer.tagsPlaceholder')} style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
      </div>
      <button onClick={publish} disabled={busy || !canPublish} style={{ alignSelf: 'flex-start', padding: '5px 14px', border: 'var(--border-width) solid var(--accent)', background: canPublish ? 'var(--accent)' : 'transparent', color: canPublish ? '#fff' : 'var(--text-dim)', fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: busy ? 'wait' : canPublish ? 'pointer' : 'not-allowed', boxShadow: 'var(--shadow-hard)' }}>
        {busy ? t('composer.publishing') : t('network.publishBtn')}
      </button>
    </div>
  )
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function LeaderboardSection() {
  const { t } = useTranslation('nook')
  const [entries, setEntries] = useState<NookLeaderEntryView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setEntries(await window.tachi.nookNetwork.getLeaderboard({ limit: 50 }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const medal = (rank: number) => rank === 1 ? '#f5c518' : rank === 2 ? '#c0c0c0' : rank === 3 ? '#cd7f32' : 'var(--text-dim)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('leaderboard.title')}</div>
        <button onClick={load} disabled={loading} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: mono, fontSize: 11, cursor: 'pointer' }}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && <div style={{ padding: 24, fontSize: 11, color: 'var(--destructive)' }}>{t('common.error')} {error}</div>}
        {!error && !loading && entries.length === 0 && (
          <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('leaderboard.empty')}</div>
        )}
        {entries.map(e => (
          <div key={e.address} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderBottom: 'var(--border-width) solid var(--border)' }}>
            <div style={{ flexShrink: 0, minWidth: 28, fontSize: 13, fontWeight: 700, color: medal(e.rank), textAlign: 'center' }}>#{e.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{e.name || short(e.address)}</div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                {short(e.address)} · {t('leaderboard.challenges', { count: e.challengesSolved })}{e.velocityMultiplier > 1 ? ` · ${t('leaderboard.velocity', { mult: e.velocityMultiplier })}` : ''}
              </div>
            </div>
            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>{e.score.toLocaleString()}</div>
              <div style={{ fontSize: 8, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('network.score')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Agent search + follow ──────────────────────────────────────────────────────

function SearchSection({ hasKey }: { hasKey: boolean }) {
  const { t } = useTranslation('nook')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NookAgentView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [following, setFollowing] = useState<string | null>(null)
  const [followed, setFollowed] = useState<Set<string>>(new Set())

  const run = async () => {
    if (query.trim().length < 2) return
    setLoading(true); setError(null); setSearched(true)
    try {
      setResults(await window.tachi.nookNetwork.searchAgents(query, 25))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const doFollow = async (addr: string) => {
    setFollowing(addr)
    try {
      await window.tachi.nookNetwork.follow(addr)
      setFollowed(prev => new Set(prev).add(addr))
      toast('success', t('search.toast.following', { addr: short(addr) }))
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setFollowing(null) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: 'var(--border-width) solid var(--border)' }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') run() }}
          placeholder={t('search.placeholder')}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={run} disabled={loading || query.trim().length < 2} style={{ padding: '4px 12px', border: 'var(--border-width) solid var(--accent)', background: 'var(--accent)', color: '#fff', fontFamily: mono, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
          {loading ? t('search.searching') : t('search.search')}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && <div style={{ padding: 24, fontSize: 11, color: 'var(--destructive)' }}>{t('common.error')} {error}</div>}
        {!error && searched && !loading && results.length === 0 && (
          <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('search.noAgents')}</div>
        )}
        {!searched && (
          <div style={{ padding: 24, fontSize: 11, color: 'var(--text-dim)' }}>{t('search.prompt')}</div>
        )}
        {results.map(a => {
          const isFollowed = followed.has(a.address)
          return (
            <div key={a.address} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, borderBottom: 'var(--border-width) solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{a.name}</div>
                <div style={{ fontSize: 9, color: 'var(--text-dim)', margin: '2px 0' }}>{short(a.address)}</div>
                {a.snippet && <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.45 }}>{a.snippet}</div>}
              </div>
              <button
                onClick={() => doFollow(a.address)}
                disabled={isFollowed || following === a.address}
                title={hasKey ? t('search.followTitle') : t('search.followNeedKey')}
                style={{ flexShrink: 0, padding: '3px 12px', border: `var(--border-width) solid ${isFollowed ? 'var(--border)' : 'var(--accent)'}`, background: 'transparent', color: isFollowed ? 'var(--text-dim)' : 'var(--accent)', fontFamily: mono, fontSize: 10, fontWeight: 700, cursor: isFollowed ? 'default' : following === a.address ? 'wait' : 'pointer' }}
              >
                {isFollowed ? t('search.followingState') : following === a.address ? t('search.followingProgress') : t('search.follow')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
