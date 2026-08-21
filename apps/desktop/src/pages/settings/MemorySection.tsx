import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMemoryStore } from '../../store/memory.store'
// Subpath import (NOT the '@tachi/core' barrel) keeps the Node-only barrel out
// of the renderer bundle — the pure fact helpers live under src/memory/facts.
import {
  joinEnabledFacts,
  factsBudget,
  FACT_BUDGET_CHARS,
  type MemoryFact,
} from '@tachi/core/src/memory/facts'

const MONO = 'JetBrains Mono, monospace'
const MAX_FACT_CHARS = 2000

/**
 * MEMORY FACT MANAGER (USER-PAINS T16). Replaces the single free-form blob with
 * a list of managed facts: each can be edited, disabled (kept but not sent), or
 * deleted. The joined ENABLED facts are what the model sees on every chat — the
 * live preview at the bottom shows exactly that, against a soft char budget.
 */
export function MemorySection() {
  const { t } = useTranslation('settings')
  const setStoreFacts = useMemoryStore(s => s.setFacts)

  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  // Keep the global store (topbar "MEMORY" badge + chat injection view) in sync
  // with whatever we just wrote.
  const commit = (list: MemoryFact[]) => {
    setFacts(list)
    setStoreFacts(list)
  }

  const refresh = React.useCallback(async () => {
    try {
      const list = await window.tachi.memoryFacts.list()
      commit(list)
    } catch { /* leave list as-is; a transient IPC error shouldn't blank the UI */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleAdd = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await window.tachi.memoryFacts.add(text, 'user')
      setDraft('')
      await refresh()
    } finally { setBusy(false) }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    await window.tachi.memoryFacts.toggle(id, enabled)
    await refresh()
  }

  const handleDelete = async (id: string) => {
    await window.tachi.memoryFacts.delete(id)
    await refresh()
  }

  const handleEditCommit = async (fact: MemoryFact, next: string) => {
    const text = next.trim()
    if (!text || text === fact.text) return
    await window.tachi.memoryFacts.edit(fact.id, text)
    await refresh()
  }

  // Live preview — computed from the local list (no round-trip), identical to
  // what the main process injects (joinEnabledFacts) + the same soft budget.
  const previewText = joinEnabledFacts(facts)
  const budget = factsBudget(facts)
  const enabledCount = facts.filter(f => f.enabled).length

  return (
    <div
      id="memory"
      style={{
        border: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-hard)',
        padding: 12,
        fontFamily: MONO,
      }}
    >
      {/* Header */}
      <div style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)',
      }}>
        {t('memory.title', { defaultValue: 'Memory' })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('memory.description', {
          defaultValue: 'Facts here are added to every chat as a system-prompt prefix, so you don’t re-explain yourself. Toggle a fact off to keep it without sending it.',
        })}
      </div>

      {/* Add row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value.slice(0, MAX_FACT_CHARS))}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
          placeholder={t('memory.addPlaceholder', { defaultValue: 'Add a fact — e.g. Always respond concisely. Use metric units.' })}
          aria-label={t('memory.addPlaceholder', { defaultValue: 'Add a fact' })}
          style={{
            flex: 1,
            boxSizing: 'border-box',
            padding: '6px 8px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            fontFamily: MONO,
            fontSize: 11,
            outline: 'none',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={!draft.trim() || busy}
          style={{
            fontSize: 9, fontWeight: 700, padding: '4px 12px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--accent)', color: '#fff',
            boxShadow: draft.trim() && !busy ? 'var(--shadow-hard)' : 'none',
            cursor: draft.trim() && !busy ? 'pointer' : 'default',
            fontFamily: MONO,
            textTransform: 'uppercase', letterSpacing: '0.06em',
            opacity: draft.trim() && !busy ? 1 : 0.4,
            flexShrink: 0,
          }}
        >
          {t('memory.add', { defaultValue: 'Add' })}
        </button>
      </div>

      {/* Fact list */}
      {facts.length === 0 ? (
        <div style={{
          fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic',
          padding: '10px 8px', border: '1px dashed var(--border)', marginBottom: 10,
        }}>
          {t('memory.empty', { defaultValue: 'No facts yet. Add one above, or let chat auto-capture propose them.' })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {facts.map(fact => (
            <FactRow
              key={fact.id}
              fact={fact}
              t={t}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEditCommit={handleEditCommit}
            />
          ))}
        </div>
      )}

      {/* "What the model sees" preview */}
      <div style={{
        borderTop: 'var(--border-width) solid var(--border)', paddingTop: 8, marginTop: 2,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: 'var(--text-muted)',
          }}>
            {t('memory.previewLabel', { defaultValue: 'What the model sees' })}
          </span>
          <span style={{
            fontSize: 9,
            padding: '2px 6px',
            border: 'var(--border-width) solid ' + (budget.overBudget ? 'var(--danger)' : 'var(--border)'),
            color: budget.overBudget ? 'var(--danger)' : 'var(--text-muted)',
            fontFamily: MONO,
            letterSpacing: '0.04em',
          }}>
            {budget.chars} / {FACT_BUDGET_CHARS}
          </span>
        </div>
        <pre style={{
          margin: 0,
          padding: '8px',
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-base)',
          color: enabledCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          fontFamily: MONO,
          fontSize: 10,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 160,
          overflowY: 'auto',
          fontStyle: enabledCount > 0 ? 'normal' : 'italic',
        }}>
          {enabledCount > 0 ? previewText : t('memory.previewEmpty', { defaultValue: 'Nothing — no enabled facts.' })}
        </pre>
        {budget.overBudget && (
          <div style={{ fontSize: 9, color: 'var(--danger)', marginTop: 4 }}>
            {t('memory.overBudget', { defaultValue: 'Over budget — trim or disable some facts.' })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── One fact row ──────────────────────────────────────────────────────────────

interface FactRowProps {
  fact: MemoryFact
  t: ReturnType<typeof useTranslation>['t']
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onEditCommit: (fact: MemoryFact, next: string) => void
}

function FactRow({ fact, t, onToggle, onDelete, onEditCommit }: FactRowProps) {
  const [text, setText] = useState(fact.text)
  const [confirmDel, setConfirmDel] = useState(false)

  // Re-sync when the underlying fact text changes from elsewhere (refresh).
  useEffect(() => { setText(fact.text) }, [fact.text])

  const dim = !fact.enabled
  const srcLabel = fact.source === 'auto'
    ? t('memory.sourceAuto', { defaultValue: 'Auto' })
    : t('memory.sourceUser', { defaultValue: 'You' })

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: 6,
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-base)',
      opacity: dim ? 0.55 : 1,
    }}>
      {/* Enable / disable pill */}
      <button
        onClick={() => onToggle(fact.id, !fact.enabled)}
        title={fact.enabled
          ? t('memory.disableAria', { defaultValue: 'Disable this fact' })
          : t('memory.enableAria', { defaultValue: 'Enable this fact' })}
        aria-label={fact.enabled
          ? t('memory.disableAria', { defaultValue: 'Disable this fact' })
          : t('memory.enableAria', { defaultValue: 'Enable this fact' })}
        aria-pressed={fact.enabled}
        style={{
          flexShrink: 0,
          width: 40,
          border: 'none',
          borderRight: 'var(--border-width) solid var(--border)',
          background: fact.enabled ? 'var(--accent)' : 'transparent',
          color: fact.enabled ? '#fff' : 'var(--text-muted)',
          fontFamily: MONO,
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        {fact.enabled ? t('memory.on', { defaultValue: 'On' }) : t('memory.off', { defaultValue: 'Off' })}
      </button>

      {/* Editable text */}
      <input
        value={text}
        onChange={e => setText(e.target.value.slice(0, MAX_FACT_CHARS))}
        onBlur={() => onEditCommit(fact, text)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { setText(fact.text); (e.target as HTMLInputElement).blur() }
        }}
        aria-label={t('memory.editAria', { defaultValue: 'Edit fact text' })}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontFamily: MONO,
          fontSize: 11,
          padding: '6px 4px',
          outline: 'none',
          textDecoration: dim ? 'line-through' : 'none',
        }}
      />

      {/* Source tag */}
      <span style={{
        flexShrink: 0,
        alignSelf: 'center',
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        padding: '0 2px',
      }}>
        {srcLabel}
      </span>

      {/* Delete (two-step to avoid an accidental wipe) */}
      <button
        onClick={() => {
          if (confirmDel) onDelete(fact.id)
          else { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000) }
        }}
        title={t('memory.delete', { defaultValue: 'Delete fact' })}
        aria-label={t('memory.delete', { defaultValue: 'Delete fact' })}
        style={{
          flexShrink: 0,
          width: 28,
          border: 'none',
          borderLeft: 'var(--border-width) solid var(--border)',
          background: confirmDel ? 'var(--danger)' : 'transparent',
          color: confirmDel ? '#fff' : 'var(--text-muted)',
          fontFamily: MONO,
          fontSize: 13,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        {confirmDel ? '!' : '×'}
      </button>
    </div>
  )
}
