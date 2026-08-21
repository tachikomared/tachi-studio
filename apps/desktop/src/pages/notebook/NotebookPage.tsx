// apps/desktop/src/pages/notebook/NotebookPage.tsx
//
// Notebook surface v1 (STEAL 2026-06-21 #7, open-notebook — CAG-first). Collect
// named text sources, ask a question grounded ONLY in them. "Ask in Chat" hands
// the assembled prompt to the existing chat via the proven pendingMessage path
// (same as HomePage quick-starts) so streaming + provider routing are reused —
// no bespoke LLM call here. Local-first: sources never leave until you ask.

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../../store/chat.store'
import { showToast } from '../../components/Toaster'
import { buildNotebookPrompt, type NotebookSource } from './buildNotebookPrompt'

interface SourceRow extends NotebookSource { id: string }

const newRow = (): SourceRow => ({ id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: '', text: '' })

const label: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }
const field: React.CSSProperties = { boxSizing: 'border-box', width: '100%', padding: '6px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, outline: 'none' }
const btn: React.CSSProperties = { padding: '6px 12px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer' }

export function NotebookPage() {
  const navigate = useNavigate()
  const setPendingMessage = useChatStore((s) => s.setPendingMessage)
  const newConversation = useChatStore((s) => s.newConversation)

  const [sources, setSources] = useState<SourceRow[]>([newRow()])
  const [question, setQuestion] = useState('')

  const update = (id: string, patch: Partial<SourceRow>) =>
    setSources((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const remove = (id: string) => setSources((rows) => (rows.length > 1 ? rows.filter((r) => r.id !== id) : rows))

  const usableCount = sources.filter((s) => s.text.trim().length > 0).length
  const canAsk = question.trim().length > 0

  const prompt = () => buildNotebookPrompt(sources, question)

  const askInChat = () => {
    if (!canAsk) return
    setPendingMessage(prompt())
    newConversation()
    navigate('/chat')
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt())
      showToast({ kind: 'success', text: 'Grounded prompt copied — paste it into any chat.' })
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : 'Could not copy.' })
    }
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent)' }}>Notebook</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            Add your sources, ask a question, and get an answer grounded only in them. Local-first — nothing is sent until you ask.
          </div>
        </div>

        {/* Sources */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={label}>Sources ({usableCount})</span>
          {sources.map((s, i) => (
            <div key={s.id} style={{ border: '2px solid var(--border)', background: 'var(--bg-surface)', padding: 10, display: 'flex', flexDirection: 'column', gap: 6, boxShadow: 'var(--shadow-hard)' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ ...field, flex: 1 }} placeholder={`Source ${i + 1} title…`} value={s.title} onChange={(e) => update(s.id, { title: e.target.value })} />
                <button style={btn} onClick={() => remove(s.id)} disabled={sources.length <= 1} title="Remove source">✕</button>
              </div>
              <textarea style={{ ...field, minHeight: 90, resize: 'vertical' }} placeholder="Paste the source text…" value={s.text} onChange={(e) => update(s.id, { text: e.target.value })} />
            </div>
          ))}
          <button style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => setSources((rows) => [...rows, newRow()])}>+ Add source</button>
        </div>

        {/* Question */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>Question</span>
          <textarea
            style={{ ...field, minHeight: 64, resize: 'vertical' }}
            placeholder="Ask something answerable from your sources…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askInChat() }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)' }} onClick={askInChat} disabled={!canAsk} title="Open chat with the grounded prompt prefilled (⌘/Ctrl+Enter)">
            Ask in Chat →
          </button>
          <button style={btn} onClick={copyPrompt} disabled={!canAsk}>Copy prompt</button>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>Uses your current chat provider/model.</span>
        </div>
      </div>
    </div>
  )
}
