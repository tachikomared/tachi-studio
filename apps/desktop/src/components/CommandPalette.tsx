// apps/desktop/src/components/CommandPalette.tsx
//
// Cmd+K (Ctrl+K on Win/Linux) command palette. Brutalist style — 2px border,
// hard shadow, JetBrains Mono, no rounding. Lists navigation, conversations,
// providers, and skill/slash actions. Fuzzy-match by substring on label.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../store/chat.store'
import { usePrivacyStore } from '../store/privacy.store'
import { PROVIDER_OPTIONS } from '../pages/chat/ProviderPicker'
import { useFocusRegion } from '../hooks/useFocusStack'
import { rankItems } from '../utils/command-score'

// Platform-aware modifier glyph for shortcut hints (Cmd on macOS, Ctrl elsewhere).
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')
const MOD = IS_MAC ? 'Cmd' : 'Ctrl'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  group: 'Navigate' | 'Conversation' | 'Provider' | 'Skill' | 'Action'
  shortcut?: string
  run: () => void | Promise<void>
}

interface Props { open: boolean; onClose: () => void }

export function CommandPalette({ open, onClose }: Props) {
  const navigate                = useNavigate()
  const conversations           = useChatStore(s => s.conversations)
  const activeConversationId    = useChatStore(s => s.activeConversationId)
  const newConversation         = useChatStore(s => s.newConversation)
  const setProvider             = useChatStore(s => s.setProvider)
  const privacyMode             = usePrivacyStore(s => s.mode)
  const setPrivacyMode          = usePrivacyStore(s => s.setMode)
  const [q, setQ]               = useState('')
  const [cursor, setCursor]     = useState(0)
  const inputRef                = useRef<HTMLInputElement>(null)
  const itemRefs                = useRef<Map<number, HTMLButtonElement>>(new Map())
  // Installed skills for the palette — loaded async, always a plain array.
  const [skillItems, setSkillItems] = useState<Array<{ id: string; name: string; hint?: string }>>([])
  useEffect(() => {
    let alive = true
    window.tachi.skills?.list?.()
      .then(r => {
        if (!alive) return
        const rows = Array.isArray(r?.skills) ? r.skills : []
        setSkillItems(rows.map(s => ({ id: s.name, name: s.name, hint: s.description })))
      })
      .catch(() => { /* palette works fine without skills */ })
    return () => { alive = false }
  }, [])

  // Block global shortcuts while the palette is open (focus-stack modal region).
  useFocusRegion('command-palette', open, 'modal')

  useEffect(() => {
    if (open) {
      setQ(''); setCursor(0)
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Build the full command list
  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = [
      // ── Navigate
      { id: 'nav-home',     label: 'Go to Home',         group: 'Navigate', run: () => navigate('/home') },
      { id: 'nav-chat',     label: 'Go to Chat',         group: 'Navigate', shortcut: `${MOD}+N`, run: () => navigate('/chat') },
      { id: 'nav-code',     label: 'Go to Code (Agent)', group: 'Navigate', run: () => navigate('/agent') },
      { id: 'nav-nodes',    label: 'Go to Nodes',        group: 'Navigate', run: () => navigate('/nodes') },
      { id: 'nav-media',    label: 'Go to Media',        group: 'Navigate', run: () => navigate('/media') },
      { id: 'nav-artifacts',label: 'Go to Artifacts',    group: 'Navigate', run: () => navigate('/artifacts') },
      { id: 'nav-catalog',  label: 'Go to Catalog',      group: 'Navigate', run: () => navigate('/catalog') },
      { id: 'nav-studio',   label: 'Go to Studio',       group: 'Navigate', run: () => navigate('/studio') },
      { id: 'nav-aeon',     label: 'Go to Aeon',         group: 'Navigate', run: () => navigate('/aeon') },
      { id: 'nav-swarm',    label: 'Go to Swarm',        group: 'Navigate', run: () => navigate('/swarm') },
      { id: 'nav-inbox',    label: 'Go to Inbox',        group: 'Navigate', run: () => navigate('/inbox') },
      { id: 'nav-openclaw', label: 'Go to OpenClaw',     group: 'Navigate', run: () => navigate('/openclaw') },
      { id: 'nav-freellmapi', label: 'Go to FreeLLM API', group: 'Navigate', run: () => navigate('/freellmapi') },
      { id: 'nav-nook',     label: 'Go to Nook',         group: 'Navigate', run: () => navigate('/nook') },
      { id: 'nav-wallet',   label: 'Go to Wallet',       group: 'Navigate', run: () => navigate('/wallet') },
      { id: 'nav-learn',    label: 'Go to Learn',        group: 'Navigate', run: () => navigate('/learn') },
      { id: 'nav-settings', label: 'Go to Settings',     group: 'Navigate', shortcut: `${MOD}+,`, run: () => navigate('/settings') },

      // ── Action
      { id: 'act-new-chat', label: 'New chat',       group: 'Action', shortcut: `${MOD}+N`, run: () => {
          const id = newConversation()
          navigate(`/chat/${id}`)
      }},
      { id: 'act-shortcuts', label: 'Show keyboard shortcuts', group: 'Action', shortcut: `${MOD}+/`, run: () => {
          window.dispatchEvent(new CustomEvent('tachi:show-shortcut-help'))
      }},
      { id: 'act-toggle-console', label: 'Toggle Console (Terminal / Trace / Observability)', group: 'Action', shortcut: `${MOD}+\``, run: () => {
          window.dispatchEvent(new CustomEvent('tachi:toggle-console'))
      }},
      // PRIVATE MODE (Tier 1) — flip between open and private. The subtitle is
      // a dynamic "Currently: <mode>" that re-renders whenever the privacy store
      // changes (the component subscribes to usePrivacyStore above, and items is
      // memoized on privacyMode below).
      { id: 'act-toggle-private-mode',
        label: 'Toggle PRIVATE MODE',
        hint:  `Currently: ${privacyMode}`,
        group: 'Action',
        run: () => {
          setPrivacyMode(privacyMode === 'private' ? 'open' : 'private')
        },
      },

      // ── Provider switch (only for active conversation)
      ...PROVIDER_OPTIONS.map(p => ({
        id:    `prov-${p.id}`,
        label: `Switch provider → ${p.label}`,
        hint:  p.hint,
        group: 'Provider' as const,
        run: () => {
          if (activeConversationId) setProvider(activeConversationId, p.id, p.defaultModel)
        },
      })),
    ]

    // ── Recent conversations
    for (const c of conversations.slice(0, 10)) {
      list.push({
        id:    `conv-${c.id}`,
        label: `Open: ${c.title || '(untitled)'}`,
        hint:  new Date(c.updatedAt).toLocaleDateString(),
        group: 'Conversation',
        run:   () => navigate(`/chat/${c.id}`),
      })
    }

    // ── Skills — from the async skills IPC (loaded once into state below).
    // HARD LESSON (white-screen 2026-07-19): this used to be a synchronous
    // placeholder call guarded by `?? []`. When the real async API landed
    // under the same name, it returned a PROMISE — truthy, so the guard never
    // fired and `for…of promise` crashed the whole tree at boot. Async data
    // belongs in state; the render path only ever iterates a real array.
    for (const s of skillItems) {
      list.push({
        id:    `skill-${s.id}`,
        label: `Run skill /${s.id}`,
        hint:  s.hint || s.name,
        group: 'Skill',
        run:   () => {
          const ev = new CustomEvent('tachi:run-skill', { detail: { id: s.id } })
          window.dispatchEvent(ev)
        },
      })
    }

    return list
  }, [navigate, conversations, activeConversationId, newConversation, setProvider, privacyMode, setPrivacyMode, skillItems])

  // Ranked match: exact > prefix > word-prefix > substring > subsequence.
  // rankItems returns the array unchanged when the query is blank, so the
  // natural group ordering (Action > Navigate > …) is preserved at rest.
  const filtered = useMemo(
    () => rankItems(q, items, it => [it.label, it.hint ?? '', it.group]),
    [items, q],
  )

  const groups = useMemo(() => {
    const order: PaletteItem['group'][] = ['Action', 'Navigate', 'Conversation', 'Provider', 'Skill']
    const byG = new Map<PaletteItem['group'], PaletteItem[]>()
    for (const it of filtered) {
      if (!byG.has(it.group)) byG.set(it.group, [])
      byG.get(it.group)!.push(it)
    }
    return order.filter(g => byG.has(g)).map(g => ({ group: g, items: byG.get(g)! }))
  }, [filtered])

  // Flat list for cursor logic
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups])

  useEffect(() => { setCursor(0) }, [q])

  // Keep the highlighted row visible as the cursor moves with the arrow keys.
  useEffect(() => {
    itemRefs.current.get(cursor)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runAt = useCallback((idx: number) => {
    const item = flat[idx]
    if (!item) return
    onClose()
    Promise.resolve(item.run()).catch(err => console.warn('[palette] item failed:', err))
  }, [flat, onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape')      { e.preventDefault(); onClose() }
    if (e.key === 'ArrowDown')   { e.preventDefault(); setCursor(c => Math.min(c + 1, flat.length - 1)) }
    if (e.key === 'ArrowUp')     { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    if (e.key === 'Enter')       { e.preventDefault(); runAt(cursor) }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Command palette"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 'min(15vh, 120px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(620px, 92vw)',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          border: '2px solid var(--border)',
          boxShadow: 'var(--shadow-hard)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '2px solid var(--border)',
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}>
          <span style={{ color: 'var(--accent)' }}>⌘K</span>
          <span>Command Palette</span>
          <div style={{ flex: 1 }} />
          <kbd>esc</kbd>
        </div>

        {/* Search input */}
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command, page, or chat title…"
          style={{
            padding: '12px 14px',
            border: 'none',
            borderBottom: '2px solid var(--border)',
            background: 'var(--bg-inset)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 14,
            outline: 'none',
          }}
        />

        {/* Results */}
        <div
          role="listbox"
          aria-label="Commands"
          style={{
            flex: 1,
            overflowY: 'auto',
          }}
        >
          {flat.length === 0 && (
            <div style={{ padding: '20px 14px', color: 'var(--text-dim)', fontSize: 11 }}>
              No matches.
            </div>
          )}
          {(() => {
            let idx = -1
            return groups.map(g => (
              <div key={g.group}>
                <div style={{
                  padding: '6px 14px',
                  fontSize: 9,
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  borderBottom: 'var(--border-width) solid var(--border)',
                  background: 'var(--bg-inset)',
                }}>{g.group}</div>
                {g.items.map(it => {
                  idx += 1
                  const isCursor = idx === cursor
                  const itemIdx  = idx
                  return (
                    <button
                      key={it.id}
                      ref={el => { if (el) itemRefs.current.set(itemIdx, el) }}
                      role="option"
                      aria-selected={isCursor}
                      onMouseEnter={() => setCursor(itemIdx)}
                      onClick={() => runAt(itemIdx)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 14px',
                        border: 'none',
                        borderLeft: isCursor ? '3px solid var(--accent)' : '3px solid transparent',
                        background: isCursor ? 'var(--accent-muted)' : 'transparent',
                        color: 'var(--text-primary)',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ flex: 1 }}>{it.label}</span>
                      {it.hint && <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{it.hint}</span>}
                      {it.shortcut && <kbd>{it.shortcut}</kbd>}
                    </button>
                  )
                })}
              </div>
            ))
          })()}
        </div>

        {/* Footer */}
        <div style={{
          padding: '6px 14px',
          borderTop: '2px solid var(--border)',
          fontSize: 9,
          color: 'var(--text-dim)',
          display: 'flex',
          gap: 12,
          background: 'var(--bg-elevated)',
        }}>
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
