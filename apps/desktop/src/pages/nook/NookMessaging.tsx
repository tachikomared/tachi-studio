import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const toast = (kind: string, text: string) =>
  window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind, text } }))

const sectionLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-dim)',
  textTransform: 'uppercase', marginBottom: 6,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-base)',
  border: 'var(--border-width) solid var(--border)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none', boxSizing: 'border-box',
}

interface DM {
  id: string; from: string; fromName: string | null; to: string
  content: string; messageType: string; unread: boolean; createdAt: string
  raw: Record<string, unknown>
}
interface Channel {
  id: string; slug: string; name: string; description: string | null
  channelType: string; isPublic: boolean; memberCount: number | null
  isMember: boolean; createdAt: string; raw: Record<string, unknown>
}
interface ChannelMsg {
  id: string; from: string; fromName: string | null; content: string
  messageType: string; createdAt: string; raw: Record<string, unknown>
}

function shortAddr(a: string): string {
  if (!a) return ''
  return a.length > 12 && a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}
function whenLabel(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

type Mode = 'dms' | 'channels'

export function NookMessaging() {
  const { t } = useTranslation('nook')
  const [mode, setMode] = useState<Mode>('dms')

  // DMs
  const [dms, setDms] = useState<DM[]>([])
  // Channels
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelMsgs, setChannelMsgs] = useState<ChannelMsg[]>([])

  const [selected, setSelected] = useState<string | null>(null) // peer address (dms) or channel id (channels)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [newDmAddr, setNewDmAddr] = useState('')
  const [sending, setSending] = useState(false)

  // ── DMs: group flat inbox into conversations keyed by peer address ───────────
  const conversations = useMemo(() => {
    const byPeer = new Map<string, { peer: string; peerName: string | null; last: DM; unread: number }>()
    for (const m of dms) {
      // The peer is whichever side isn't "from" the inbox owner. Inbox only
      // returns received messages reliably, so key on `from` (the sender).
      const peer = m.from
      const peerName = m.fromName
      const cur = byPeer.get(peer)
      if (!cur) byPeer.set(peer, { peer, peerName, last: m, unread: m.unread ? 1 : 0 })
      else {
        cur.unread += m.unread ? 1 : 0
        if (Date.parse(m.createdAt) > Date.parse(cur.last.createdAt)) { cur.last = m; cur.peerName = peerName }
      }
    }
    return Array.from(byPeer.values()).sort((a, b) => Date.parse(b.last.createdAt) - Date.parse(a.last.createdAt))
  }, [dms])

  const threadDMs = useMemo(
    () => dms.filter(m => m.from === selected || m.to === selected)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [dms, selected],
  )

  const loadDMs = useCallback(async () => {
    setLoadingList(true); setListError(null)
    try { setDms((await window.tachi.nookMessaging.inboxList({ limit: 100 })) as DM[]) }
    catch (e) {
      // Empty inbox is mapped to [] in the main process (gateway 500 quirk), so
      // anything reaching here is a genuine, usually transient error. Keep the UI
      // calm — fall back to empty (the user can still start a new DM below) and
      // log quietly (console.debug is hidden by default, no scary red errors).
      console.debug('[nook] inbox load error:', e)
      setDms([])
    }
    finally { setLoadingList(false) }
  }, [])

  const loadChannels = useCallback(async () => {
    setLoadingList(true); setListError(null)
    try { setChannels((await window.tachi.nookMessaging.listChannels({ limit: 100 })) as Channel[]) }
    catch (e) { setListError(e instanceof Error ? e.message : String(e)) }
    finally { setLoadingList(false) }
  }, [])

  const loadChannelThread = useCallback(async (id: string) => {
    setLoadingThread(true)
    try { setChannelMsgs((await window.tachi.nookMessaging.channelMessages(id, 80)) as ChannelMsg[]) }
    catch (e) { toast('error', e instanceof Error ? e.message : String(e)) }
    finally { setLoadingThread(false) }
  }, [])

  // Initial + mode-switch load.
  useEffect(() => {
    setSelected(null); setComposer('')
    if (mode === 'dms') loadDMs(); else loadChannels()
  }, [mode, loadDMs, loadChannels])

  // When a channel is selected, fetch its history.
  useEffect(() => {
    if (mode === 'channels' && selected) loadChannelThread(selected)
  }, [mode, selected, loadChannelThread])

  // Mark DMs read when opening a conversation.
  useEffect(() => {
    if (mode !== 'dms' || !selected) return
    const unread = dms.filter(m => m.from === selected && m.unread)
    if (unread.length === 0) return
    Promise.all(unread.map(m => window.tachi.nookMessaging.markRead(m.id).catch(() => {})))
      .then(() => setDms(prev => prev.map(m => (m.from === selected ? { ...m, unread: false } : m))))
  }, [mode, selected, dms])

  const refresh = () => { mode === 'dms' ? loadDMs() : loadChannels() }

  const selectedChannel = useMemo(
    () => channels.find(c => c.id === selected) ?? null,
    [channels, selected],
  )

  const send = async () => {
    const text = composer.trim()
    if (!text) return
    setSending(true)
    try {
      if (mode === 'dms') {
        const to = selected ?? newDmAddr.trim()
        if (!to) { toast('error', t('messaging.toast.pickConversation')); return }
        await window.tachi.nookMessaging.sendDM(to, text)
        setComposer(''); setNewDmAddr('')
        toast('success', t('messaging.toast.sent'))
        await loadDMs()
        setSelected(to)
      } else {
        if (!selected) { toast('error', t('messaging.toast.selectChannel')); return }
        if (selectedChannel && !selectedChannel.isMember) {
          await window.tachi.nookMessaging.joinChannel(selected)
        }
        await window.tachi.nookMessaging.sendChannel(selected, text)
        setComposer('')
        await loadChannelThread(selected)
      }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally { setSending(false) }
  }

  const onComposerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const tabBtn = (m: Mode, label: string) => (
    <button onClick={() => setMode(m)} style={{
      flex: 1, padding: '5px 8px', border: 'var(--border-width) solid var(--border)',
      background: mode === m ? 'var(--accent-muted)' : 'transparent',
      color: mode === m ? 'var(--accent-text)' : 'var(--text-muted)',
      fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: mode === m ? 700 : 400, cursor: 'pointer',
    }}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: 'JetBrains Mono, monospace' }}>
      {/* Left: conversation / channel list */}
      <div style={{ width: 300, flexShrink: 0, borderRight: 'var(--border-width) solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: 'var(--border-width) solid var(--border)' }}>
          {tabBtn('dms', t('messaging.tabs.direct'))}
          {tabBtn('channels', t('messaging.tabs.channels'))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px 4px' }}>
          <div style={sectionLabel}>{mode === 'dms' ? t('messaging.conversations') : t('messaging.channels')}</div>
          <button onClick={refresh} title={t('common.refresh')} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer' }}>↻</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingList && <div style={{ padding: 12, fontSize: 10, color: 'var(--text-dim)' }}>{t('common.loading')}</div>}
          {listError && !loadingList && <div style={{ padding: 12, fontSize: 10, color: 'var(--destructive)', lineHeight: 1.5 }}>{listError}</div>}

          {mode === 'dms' && !loadingList && !listError && conversations.length === 0 && (
            <div style={{ padding: 12, fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>{t('messaging.noConversations')}</div>
          )}
          {mode === 'dms' && conversations.map(c => (
            <button key={c.peer} onClick={() => setSelected(c.peer)} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
              border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
              background: selected === c.peer ? 'var(--accent-muted)' : 'transparent',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.peerName || shortAddr(c.peer)}
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-dim)', flexShrink: 0 }}>{whenLabel(c.last.createdAt)}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                {c.unread > 0 && <span style={{ color: 'var(--accent)', fontWeight: 700, marginRight: 4 }}>● {c.unread}</span>}
                {c.last.content}
              </div>
            </button>
          ))}

          {mode === 'channels' && !loadingList && !listError && channels.length === 0 && (
            <div style={{ padding: 12, fontSize: 10, color: 'var(--text-dim)' }}>{t('messaging.noChannels')}</div>
          )}
          {mode === 'channels' && channels.map(c => (
            <button key={c.id} onClick={() => setSelected(c.id)} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
              border: 'none', borderBottom: 'var(--border-width) solid var(--border)',
              background: selected === c.id ? 'var(--accent-muted)' : 'transparent',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  #{c.name || c.slug}
                </span>
                {c.isMember && <span style={{ fontSize: 8, color: 'var(--success)', flexShrink: 0 }}>{t('messaging.joined')}</span>}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
                {c.memberCount != null ? t('messaging.members', { count: c.memberCount }) : c.channelType}
              </div>
            </button>
          ))}
        </div>

        {mode === 'dms' && (
          <div style={{ padding: 8, borderTop: 'var(--border-width) solid var(--border)' }}>
            <div style={sectionLabel}>{t('messaging.newMessage')}</div>
            <input value={newDmAddr} onChange={e => { setNewDmAddr(e.target.value); setSelected(null) }} placeholder="0x…" style={inputStyle} />
          </div>
        )}
      </div>

      {/* Right: thread + composer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderBottom: 'var(--border-width) solid var(--border)', minHeight: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mode === 'dms'
              ? (selected ? (conversations.find(c => c.peer === selected)?.peerName || shortAddr(selected)) : (newDmAddr ? shortAddr(newDmAddr) : t('messaging.newMessageTitle')))
              : (selectedChannel ? `#${selectedChannel.name || selectedChannel.slug}` : t('messaging.selectChannelTitle'))}
          </div>
          <div style={{ flex: 1 }} />
          {mode === 'channels' && selectedChannel && !selectedChannel.isMember && (
            <button onClick={async () => {
              try { await window.tachi.nookMessaging.joinChannel(selectedChannel.id); toast('success', t('messaging.toast.joined')); await loadChannels() }
              catch (e) { toast('error', e instanceof Error ? e.message : String(e)) }
            }} style={{ padding: '3px 10px', border: 'var(--border-width) solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>{t('messaging.join')}</button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loadingThread && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('common.loading')}</div>}

          {mode === 'dms' && !selected && !newDmAddr && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('messaging.dmPrompt')}
            </div>
          )}
          {mode === 'dms' && selected && threadDMs.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('messaging.noThreadMessages')}</div>
          )}
          {mode === 'dms' && threadDMs.map(m => (
            <div key={m.id} style={{ border: 'var(--border-width) solid var(--border)', padding: 8, background: 'var(--bg-elevated)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginBottom: 4 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{m.fromName || shortAddr(m.from)}</span>
                <span>{whenLabel(m.createdAt)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
            </div>
          ))}

          {mode === 'channels' && !selected && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>{t('messaging.channelPrompt')}</div>
          )}
          {mode === 'channels' && selected && !loadingThread && channelMsgs.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('messaging.noChannelMessages')}</div>
          )}
          {mode === 'channels' && channelMsgs.map(m => (
            <div key={m.id} style={{ borderBottom: 'var(--border-width) solid var(--border)', paddingBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginBottom: 2 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{m.fromName || shortAddr(m.from)}</span>
                <span>{whenLabel(m.createdAt)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
            </div>
          ))}
        </div>

        {/* Composer */}
        {((mode === 'dms' && (selected || newDmAddr)) || (mode === 'channels' && selected)) && (
          <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: 'var(--border-width) solid var(--border)' }}>
            <textarea
              value={composer}
              onChange={e => setComposer(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder={t('messaging.composerPlaceholder')}
              rows={1}
              style={{ ...inputStyle, flex: 1, resize: 'none', minHeight: 32 }}
            />
            <button onClick={send} disabled={sending || !composer.trim()} style={{
              padding: '0 16px', border: 'var(--border-width) solid var(--accent)',
              background: 'var(--accent)', color: '#fff', fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11, fontWeight: 700, cursor: sending || !composer.trim() ? 'not-allowed' : 'pointer',
              opacity: sending || !composer.trim() ? 0.5 : 1, boxShadow: 'var(--shadow-hard)',
            }}>{sending ? '…' : t('messaging.send')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
