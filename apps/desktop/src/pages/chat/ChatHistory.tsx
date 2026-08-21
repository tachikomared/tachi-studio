// apps/desktop/src/pages/chat/ChatHistory.tsx
//
// Collapsible sidebar listing past conversations. Search, rename, delete, export.

import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useChatStore, contentToText, type Conversation, type ChatFolder } from '../../store/chat.store'
import { showToast } from '../../components/Toaster'
import { SplitHandle } from '../../components/SplitHandle'
import { useResizablePanel } from '../../hooks/useResizablePanel'
// F16 — folder (project) settings: defaults adoption for new chats.
import { effectiveNewConversationTarget, toFolderSendSettings } from './folder-settings'
import { PROVIDER_OPTIONS } from './ProviderPicker'

function formatRelative(iso: string, t: TFunction): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('history.time.justNow')
  if (diff < 3600_000) return t('history.time.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('history.time.hoursAgo', { count: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('history.time.daysAgo', { count: Math.floor(diff / 86400_000) })
  return d.toLocaleDateString()
}

// 'New Chat' is the STORED default-title sentinel (chat.store) — compare against
// the literal, but translate the DISPLAYED fallback via the optional t.
function deriveTitle(conv: Conversation, t?: (key: string) => string): string {
  const untitled = t?.('history.untitled') ?? 'New Chat'
  if (conv.title && conv.title !== 'New Chat') return conv.title
  const first = conv.messages.find(m => m.role === 'user')
  if (!first) return untitled
  const text = contentToText(first.content).trim()
  return text.length > 50 ? text.slice(0, 50) + '…' : (text || untitled)
}

function exportConvAsMarkdown(conv: Conversation): string {
  const lines: string[] = []
  lines.push(`# ${deriveTitle(conv)}`)
  lines.push('')
  lines.push(`*Exported ${new Date().toISOString()} · provider=${conv.providerId} · model=${conv.model}*`)
  lines.push('')
  for (const m of conv.messages) {
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`)
    lines.push('')
    lines.push(contentToText(m.content))
    lines.push('')
  }
  return lines.join('\n')
}

export function ChatHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('chat')
  const pane = useResizablePanel({ storageKey: 'tachi-split:chat.history', initial: 260, min: 200, max: 460, side: 'right', collapsible: true })
  const navigate = useNavigate()
  const { id: activeId } = useParams<{ id: string }>()
  const conversations    = useChatStore(s => s.conversations)
  const newConversation  = useChatStore(s => s.newConversation)
  const renameConv       = useChatStore(s => s.renameConversation)
  const deleteConv       = useChatStore(s => s.deleteConversation)
  const folders                = useChatStore(s => s.folders)
  const createFolder           = useChatStore(s => s.createFolder)
  const renameFolder           = useChatStore(s => s.renameFolder)
  const deleteFolder           = useChatStore(s => s.deleteFolder)
  const toggleFolderCollapsed  = useChatStore(s => s.toggleFolderCollapsed)
  const setConversationFolder  = useChatStore(s => s.setConversationFolder)
  const setFolderSystemPrompt  = useChatStore(s => s.setFolderSystemPrompt)
  const setFolderRagFolder     = useChatStore(s => s.setFolderRagFolder)
  const setFolderDefaults      = useChatStore(s => s.setFolderDefaults)
  const togglePinned           = useChatStore(s => s.togglePinned)
  const [q, setQ]        = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  // F16: hover-visible PIN chip on conversation rows.
  const [hoveredConv, setHoveredConv] = useState<string | null>(null)
  // Folder UI state: inline rename, the per-folder actions strip, the inline
  // settings panel (instructions + defaults + knowledge), and the two-click
  // delete confirm.
  const [folderRenaming, setFolderRenaming] = useState<string | null>(null)
  const [folderRenameText, setFolderRenameText] = useState('')
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null)
  const [folderSettingsFor, setFolderSettingsFor] = useState<string | null>(null)
  const [folderPromptText, setFolderPromptText] = useState('')
  const [confirmingFolderDelete, setConfirmingFolderDelete] = useState<string | null>(null)

  const onNewFolder = () => {
    const id = createFolder(t('history.folders.defaultName'))
    setFolderRenaming(id)
    setFolderRenameText(t('history.folders.defaultName'))
  }

  // F16: toggle the per-folder settings panel; seed the instructions draft.
  const openFolderSettings = (f: ChatFolder) => {
    setFolderPromptText(f.systemPrompt ?? '')
    setFolderSettingsFor(cur => cur === f.id ? null : f.id)
  }

  // F16: a new chat born INSIDE a folder adopts the folder's default
  // provider/model (folder default > app default — the store's own defaults).
  const newConversationInFolder = (f: ChatFolder) => {
    const target = effectiveNewConversationTarget(
      toFolderSendSettings(f),
      { providerId: 'freellmapi-local', model: 'auto' },
    )
    const id = newConversation(target.providerId, target.model)
    setConversationFolder(id, f.id)
    navigate(`/chat/${id}`)
  }

  // Attach a knowledge folder to a chat folder — same pick+index flow as the
  // per-conversation composer button; conversations without their own
  // ragFolder inherit it at send time.
  const attachFolderKnowledge = async (folderId: string) => {
    const dir = await window.tachi.agent.pickFolder()
    if (!dir) return
    setFolderRagFolder(folderId, dir)
    showToast({ kind: 'info', text: t('composer.folderIndexing') })
    window.tachi.rag.index(dir)
      .then(r => showToast(r.ok
        ? { kind: 'success', text: t('composer.folderIndexed', { count: r.chunks ?? 0 }) }
        : { kind: 'error', text: r.error ?? t('composer.folderIndexError') }))
      .catch(() => showToast({ kind: 'error', text: t('composer.folderIndexError') }))
  }

  const filtered = useMemo(() => {
    const list = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (!q.trim()) return list
    const lc = q.toLowerCase()
    return list.filter(c => {
      const title = deriveTitle(c, t).toLowerCase()
      if (title.includes(lc)) return true
      return c.messages.some(m => contentToText(m.content).toLowerCase().includes(lc))
    })
  }, [conversations, q])

  // Full-text hits from the SQLite FTS5 archive index (ranked, snippeted) —
  // complements the instant substring filter above. Debounced; deduped to the
  // best hit per conversation; limited to conversations still in the store.
  type DeepHit = { convId: string; title: string; turnIndex: number; role: string; snippet: string; updatedAt: string }
  const [deepHits, setDeepHits] = useState<DeepHit[]>([])
  React.useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setDeepHits([]); return }
    const timer = setTimeout(() => {
      window.tachi.chatArchive?.search(query, 12)
        .then(res => {
          if (!res.ok || !res.hits) { setDeepHits([]); return }
          const known = new Set(useChatStore.getState().conversations.map(c => c.id))
          const seen = new Set<string>()
          const best: DeepHit[] = []
          for (const h of res.hits) {
            if (!known.has(h.convId) || seen.has(h.convId)) continue
            seen.add(h.convId)
            best.push(h)
          }
          setDeepHits(best)
        })
        .catch(() => setDeepHits([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [q])

  if (!open) return null

  return (
    <>
    <div style={{
      width: pane.width,
      borderRight: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'JetBrains Mono, monospace',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: '2px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--bg-elevated)',
      }}>
        <span style={{
          flex: 1,
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
        }}>{t('history.header', { count: conversations.length })}</span>
        <button
          onClick={() => {
            const id = newConversation()
            navigate(`/chat/${id}`)
          }}
          title={t('history.newChat')}
          aria-label={t('history.newChat')}
          style={{
            padding: '2px 8px',
            border: '2px solid var(--accent)',
            background: 'var(--accent-muted)',
            color: 'var(--accent-text)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >{t('history.new')}</button>
        <button
          onClick={onNewFolder}
          title={t('history.folders.new')}
          aria-label={t('history.folders.new')}
          style={{
            padding: '2px 6px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          {/* folder-plus glyph (inline SVG — no icon dep in this app) */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true">
            <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </button>
        <button
          onClick={onClose}
          title={t('history.hide')}
          aria-label={t('history.hide')}
          style={{
            padding: '2px 6px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >×</button>
      </div>

      {/* Search */}
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={t('history.searchPlaceholder')}
        style={{
          padding: '6px 10px',
          border: 'none',
          borderBottom: '2px solid var(--border)',
          background: 'var(--bg-inset)',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          outline: 'none',
        }}
      />

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>
            {q ? t('history.noMatches') : t('history.noConversations')}
          </div>
        )}
        {(() => {
          const folderIdSet = new Set(folders.map(f => f.id))
          const renderConv = (c: Conversation) => {
          const isActive = c.id === activeId
          const title = deriveTitle(c, t)
          return (
            <div
              key={c.id}
              className="tachi-pressable"
              onClick={() => navigate(`/chat/${c.id}`)}
              onMouseEnter={() => setHoveredConv(c.id)}
              onMouseLeave={() => setHoveredConv(cur => cur === c.id ? null : cur)}
              style={{
                padding: '8px 10px',
                borderBottom: 'var(--border-width) solid var(--border)',
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                background: isActive ? 'var(--accent-muted)' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {renaming === c.id ? (
                <input
                  autoFocus
                  value={renameText}
                  onClick={e => e.stopPropagation()}
                  onChange={e => setRenameText(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      renameConv(c.id, renameText.trim() || title)
                      setRenaming(null)
                    }
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => {
                    if (renameText.trim()) renameConv(c.id, renameText.trim())
                    setRenaming(null)
                  }}
                  style={{
                    padding: '2px 4px',
                    border: '2px solid var(--accent)',
                    background: 'var(--bg-inset)',
                    color: 'var(--text-primary)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    outline: 'none',
                  }}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <div style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    color: isActive ? 'var(--accent-text)' : 'var(--text-primary)',
                    fontWeight: isActive ? 700 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{title}</div>
                  {/* F16 PIN chip — hover-visible; always visible once pinned. */}
                  {(c.pinned || hoveredConv === c.id || isActive) && (
                    <button
                      data-testid={`pin-btn-${c.id}`}
                      title={c.pinned
                        ? t('history.pin.unpinTitle', { defaultValue: 'Unpin this chat' })
                        : t('history.pin.pinTitle', { defaultValue: 'Pin — keep this chat at the top of History' })}
                      aria-label={c.pinned
                        ? t('history.pin.unpin', { defaultValue: 'Unpin' })
                        : t('history.pin.pin', { defaultValue: 'Pin' })}
                      aria-pressed={!!c.pinned}
                      onClick={e => { e.stopPropagation(); togglePinned(c.id) }}
                      style={pinChipStyle(!!c.pinned)}
                    >{c.pinned ? '▪' : t('history.pin.pin', { defaultValue: 'Pin' })}</button>
                  )}
                </div>
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 9,
                color: 'var(--text-dim)',
              }}>
                <span>{t('history.msgCount', { count: c.messages.length })}</span>
                <span>·</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.providerId.replace('-local', '')}</span>
                <span>{formatRelative(c.updatedAt, t)}</span>
              </div>
              {isActive && (
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button
                    title={t('history.actions.rename')}
                    aria-label={t('history.actions.rename')}
                    onClick={e => { e.stopPropagation(); setRenameText(title); setRenaming(c.id) }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{t('history.actions.rename')}</button>
                  <button
                    title={t('history.actions.copyMdTitle')}
                    aria-label={t('history.actions.copyMdTitle')}
                    onClick={async e => {
                      e.stopPropagation()
                      const md = exportConvAsMarkdown(c)
                      await navigator.clipboard.writeText(md)
                      showToast({ kind: 'success', text: t('history.toast.copiedMarkdown') })
                    }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{t('history.actions.copyMd')}</button>
                  <button
                    title={t('history.actions.downloadTitle')}
                    aria-label={t('history.actions.downloadAria')}
                    onClick={e => {
                      e.stopPropagation()
                      const md = exportConvAsMarkdown(c)
                      const blob = new Blob([md], { type: 'text/markdown' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `${title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)}.md`
                      a.click()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                      showToast({ kind: 'success', text: t('history.toast.downloaded', { filename: a.download }) })
                    }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{t('history.actions.export')}</button>
                  <button
                    title={confirmingDelete === c.id ? t('history.actions.deleteConfirm') : t('history.actions.delete')}
                    aria-label={t('history.actions.delete')}
                    onClick={e => {
                      e.stopPropagation()
                      if (confirmingDelete !== c.id) {
                        setConfirmingDelete(c.id)
                        setTimeout(() => setConfirmingDelete(prev => prev === c.id ? null : prev), 2500)
                        return
                      }
                      deleteConv(c.id)
                      setConfirmingDelete(null)
                      showToast({ kind: 'info', text: t('history.toast.deleted', { title }) })
                      if (c.id === activeId) {
                        const remaining = conversations.find(x => x.id !== c.id)
                        if (remaining) navigate(`/chat/${remaining.id}`)
                        else {
                          const nid = newConversation()
                          navigate(`/chat/${nid}`)
                        }
                      }
                    }}
                    style={{
                      padding: '2px 6px',
                      border: '2px solid var(--danger)',
                      background: confirmingDelete === c.id ? 'var(--danger)' : 'var(--bg-elevated)',
                      color: confirmingDelete === c.id ? '#fff' : 'var(--danger)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 9,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >{confirmingDelete === c.id ? t('history.actions.deleteSure') : t('history.actions.deleteShort')}</button>
                  {folders.length > 0 && (
                    <select
                      value={c.folderId && folderIdSet.has(c.folderId) ? c.folderId : ''}
                      title={t('history.folders.moveTitle')}
                      aria-label={t('history.folders.moveTitle')}
                      onClick={e => e.stopPropagation()}
                      onChange={e => { e.stopPropagation(); setConversationFolder(c.id, e.target.value || null) }}
                      style={{
                        maxWidth: 74,
                        padding: '2px 2px',
                        border: '2px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 9,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      <option value="">{t('history.folders.none')}</option>
                      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  )}
                </div>
              )}
            </div>
          )
          }

          // Search mode: flat ranked list (folders don't interfere with search).
          if (q.trim()) return filtered.map(renderConv)

          // Grouped mode (F16): PINNED first, then folders (each collapsible,
          // with the project actions strip + inline settings panel), then
          // unfiled conversations. Pinned rows are pulled OUT of their groups.
          const pinnedConvs = filtered.filter(c => !!c.pinned)
          const unpinned    = filtered.filter(c => !c.pinned)
          const unfiled = unpinned.filter(c => !c.folderId || !folderIdSet.has(c.folderId))
          return (
            <>
              {pinnedConvs.length > 0 && (
                <div data-testid="pinned-section">
                  <div style={unfiledLabelStyle}>
                    {t('history.pinnedSection', { defaultValue: 'Pinned' })}
                  </div>
                  {pinnedConvs.map(renderConv)}
                </div>
              )}
              {folders.map(f => {
                const convs = unpinned.filter(c => c.folderId === f.id)
                const hasPowers = !!(f.systemPrompt || f.ragFolder || f.defaultProviderId)
                return (
                  <div key={f.id} data-testid={`chat-folder-${f.id}`}>
                    <div
                      className="tachi-pressable"
                      onClick={() => toggleFolderCollapsed(f.id)}
                      style={folderHeaderStyle}
                    >
                      <span style={{ width: 10 }}>{f.collapsed ? '▸' : '▾'}</span>
                      {folderRenaming === f.id ? (
                        <input
                          autoFocus
                          data-testid="folder-rename-input"
                          value={folderRenameText}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setFolderRenameText(e.target.value)}
                          onKeyDown={e => {
                            e.stopPropagation()
                            if (e.key === 'Enter') { renameFolder(f.id, folderRenameText); setFolderRenaming(null) }
                            if (e.key === 'Escape') setFolderRenaming(null)
                          }}
                          onBlur={() => { renameFolder(f.id, folderRenameText); setFolderRenaming(null) }}
                          style={folderRenameInputStyle}
                        />
                      ) : (
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.name}
                        </span>
                      )}
                      <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{convs.length}</span>
                      {hasPowers && (
                        <span title={t('history.folders.projectPowers')} style={{ color: 'var(--accent)' }}>◆</span>
                      )}
                      {/* F16: new chat born in this folder — adopts folder defaults */}
                      <button
                        data-testid={`folder-new-chat-${f.id}`}
                        onClick={e => { e.stopPropagation(); newConversationInFolder(f) }}
                        title={t('history.folders.newChatInFolder', { defaultValue: 'New chat in this folder — adopts the folder defaults' })}
                        aria-label={t('history.folders.newChatInFolder', { defaultValue: 'New chat in this folder — adopts the folder defaults' })}
                        style={folderKebabStyle}
                      >+</button>
                      {/* F16: folder settings — instructions / defaults / knowledge */}
                      <button
                        data-testid={`folder-settings-btn-${f.id}`}
                        onClick={e => { e.stopPropagation(); openFolderSettings(f) }}
                        title={t('history.folders.settingsTitle', { defaultValue: 'Folder settings — instructions, default provider/model, knowledge' })}
                        aria-label={t('history.folders.settings', { defaultValue: 'Folder settings' })}
                        aria-expanded={folderSettingsFor === f.id}
                        style={{
                          ...folderKebabStyle,
                          ...(folderSettingsFor === f.id
                            ? { borderColor: 'var(--accent)', color: 'var(--accent-text)', background: 'var(--accent-muted)' }
                            : {}),
                        }}
                      >⚙</button>
                      <button
                        onClick={e => { e.stopPropagation(); setFolderMenuFor(cur => cur === f.id ? null : f.id) }}
                        title={t('history.folders.actionsTitle')}
                        aria-label={t('history.folders.actionsTitle')}
                        style={folderKebabStyle}
                      >⋯</button>
                    </div>

                    {folderMenuFor === f.id && (
                      <div style={folderStripStyle}>
                        <button
                          style={folderStripBtn}
                          onClick={() => { setFolderRenameText(f.name); setFolderRenaming(f.id); setFolderMenuFor(null) }}
                        >{t('history.actions.rename')}</button>
                        <button
                          data-testid="folder-delete-btn"
                          style={{
                            ...folderStripBtn,
                            borderColor: 'var(--danger)',
                            color: confirmingFolderDelete === f.id ? '#fff' : 'var(--danger)',
                            background: confirmingFolderDelete === f.id ? 'var(--danger)' : 'var(--bg-elevated)',
                          }}
                          onClick={() => {
                            if (confirmingFolderDelete !== f.id) {
                              setConfirmingFolderDelete(f.id)
                              setTimeout(() => setConfirmingFolderDelete(prev => prev === f.id ? null : prev), 2500)
                              return
                            }
                            deleteFolder(f.id)
                            setConfirmingFolderDelete(null)
                            setFolderMenuFor(null)
                          }}
                        >{confirmingFolderDelete === f.id ? t('history.actions.deleteSure') : t('history.actions.deleteShort')}</button>
                      </div>
                    )}

                    {/* F16: inline folder settings panel — instructions, default
                        provider/model, knowledge folder. Not a modal. */}
                    {folderSettingsFor === f.id && (
                      <div data-testid={`folder-settings-panel-${f.id}`} style={folderSettingsPanelStyle}>
                        <div style={settingsMicroLabelStyle}>
                          {t('history.folders.instructions', { defaultValue: 'Instructions' })}
                        </div>
                        <textarea
                          data-testid="folder-prompt-input"
                          value={folderPromptText}
                          placeholder={t('history.folders.promptPlaceholder')}
                          onChange={e => setFolderPromptText(e.target.value)}
                          onBlur={() => setFolderSystemPrompt(f.id, folderPromptText)}
                          rows={4}
                          style={folderPromptStyle}
                        />

                        <div style={settingsMicroLabelStyle}>
                          {t('history.folders.defaultProviderModel', { defaultValue: 'Default provider / model' })}
                        </div>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
                          <select
                            data-testid="folder-default-provider-select"
                            value={f.defaultProviderId ?? ''}
                            aria-label={t('history.folders.defaultProviderModel', { defaultValue: 'Default provider / model' })}
                            onChange={e => {
                              const pid = e.target.value
                              const providerDefault = PROVIDER_OPTIONS.find(p => p.id === pid)?.defaultModel
                              setFolderDefaults(f.id, pid
                                ? { providerId: pid, model: providerDefault ?? null }
                                : { providerId: null })
                            }}
                            style={{ ...settingsInputStyle, flex: 1, minWidth: 0, cursor: 'pointer' }}
                          >
                            <option value="">{t('history.folders.providerAppDefault', { defaultValue: 'App default' })}</option>
                            {PROVIDER_OPTIONS.map(p => (
                              <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                          </select>
                          <input
                            data-testid="folder-default-model-input"
                            // Uncontrolled draft; keyed so a provider change re-seeds it.
                            key={`${f.id}:${f.defaultProviderId ?? ''}`}
                            defaultValue={f.defaultModel ?? ''}
                            disabled={!f.defaultProviderId}
                            placeholder={t('history.folders.defaultModelPlaceholder', { defaultValue: 'auto' })}
                            aria-label={t('history.folders.defaultModelPlaceholder', { defaultValue: 'auto' })}
                            onBlur={e => setFolderDefaults(f.id, { model: e.target.value || null })}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            style={{ ...settingsInputStyle, width: 104, opacity: f.defaultProviderId ? 1 : 0.5 }}
                          />
                        </div>

                        <div style={settingsMicroLabelStyle}>
                          {t('history.folders.knowledgeLabel', { defaultValue: 'Knowledge folder' })}
                        </div>
                        {f.ragFolder ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span
                              title={f.ragFolder}
                              style={{
                                flex: 1, minWidth: 0, fontSize: 10, color: 'var(--text-muted)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}
                            >{f.ragFolder.split(/[\\/]/).pop()}</span>
                            <button
                              style={folderStripBtn}
                              onClick={() => setFolderRagFolder(f.id, null)}
                            >{t('history.folders.detach')}</button>
                          </div>
                        ) : (
                          <button
                            style={{ ...folderStripBtn, alignSelf: 'flex-start' }}
                            onClick={() => { void attachFolderKnowledge(f.id) }}
                          >{t('history.folders.knowledge')}</button>
                        )}
                      </div>
                    )}

                    {!f.collapsed && convs.map(renderConv)}
                  </div>
                )
              })}
              {folders.length > 0 && unfiled.length > 0 && (
                <div style={unfiledLabelStyle}>{t('history.folders.unfiled')}</div>
              )}
              {unfiled.map(renderConv)}
            </>
          )
        })()}

        {/* Full-text hits (FTS5 archive index) — ranked, with snippets */}
        {q.trim().length >= 2 && deepHits.length > 0 && (
          <div data-testid="deep-search-section">
            <div style={{
              padding: '6px 10px',
              fontSize: 9,
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontWeight: 700,
              background: 'var(--bg-elevated)',
              borderTop: '2px solid var(--border)',
              borderBottom: 'var(--border-width) solid var(--border)',
            }}>{t('history.deepSearch')}</div>
            {deepHits.map(h => (
              <div
                key={`${h.convId}:${h.turnIndex}`}
                data-testid="deep-search-hit"
                className="tachi-pressable"
                onClick={() => navigate(`/chat/${h.convId}`)}
                style={{
                  padding: '8px 10px',
                  borderBottom: 'var(--border-width) solid var(--border)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div style={{
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{h.title || t('history.untitled')}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {h.snippet}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    <SplitHandle panel={pane} side="right" dataId="chat.history" />
    </>
  )
}

// ── Folder (project) row styles ───────────────────────────────────────────────

const folderHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  borderBottom: 'var(--border-width) solid var(--border)',
  cursor: 'pointer',
}
const folderRenameInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '1px 4px',
  border: '2px solid var(--accent)',
  background: 'var(--bg-inset)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  outline: 'none',
}
const folderKebabStyle: React.CSSProperties = {
  padding: '0 5px',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
  lineHeight: 1.4,
}
const folderStripStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  flexWrap: 'wrap',
  padding: '4px 10px 6px',
  background: 'var(--bg-elevated)',
  borderBottom: 'var(--border-width) solid var(--border)',
}
const folderStripBtn: React.CSSProperties = {
  padding: '2px 6px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  cursor: 'pointer',
  textTransform: 'uppercase',
}
const folderPromptStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  border: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  lineHeight: 1.5,
  outline: 'none',
  resize: 'vertical',
}
// F16 — pin chip + folder settings panel styles (brutalist idiom: 2px borders,
// hard uppercase micro-labels, JetBrains Mono).
const pinChipStyle = (pinned: boolean): React.CSSProperties => ({
  padding: '0 4px',
  border: `2px solid ${pinned ? 'var(--accent)' : 'var(--border)'}`,
  background: pinned ? 'var(--accent-muted)' : 'var(--bg-elevated)',
  color: pinned ? 'var(--accent-text)' : 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  lineHeight: 1.6,
  flexShrink: 0,
})
const folderSettingsPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 10px 8px',
  background: 'var(--bg-inset)',
  borderBottom: '2px solid var(--accent)',
}
const settingsMicroLabelStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  marginTop: 2,
}
const settingsInputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  padding: '3px 6px',
  border: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  outline: 'none',
}
const unfiledLabelStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 9,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontWeight: 700,
  background: 'var(--bg-elevated)',
  borderBottom: 'var(--border-width) solid var(--border)',
}
