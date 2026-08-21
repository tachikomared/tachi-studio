// apps/desktop/src/pages/chat/ChatCompactControl.tsx
//
// CHAT COMPACT — the header affordance. Shows a [COMPACT] button once the active
// conversation is long enough to have a compactable head. Clicking generates a
// dense summary of the older messages (via the conversation's current model) and
// records a non-destructive compaction: the transcript is untouched, only the
// outgoing request context shrinks. Mirrors the CODE tab's ContextMeter →
// onCompact idiom (AgentPage.tsx), adapted to the plain chat store.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, conversationTokens } from '../../store/chat.store'
import { showToast } from '../../components/Toaster'
import { KEEP_TAIL, COMPACT_LONG_TOKENS, buildCompactionInput, requestCompactSummary } from './compact'

export function ChatCompactControl(): React.ReactElement | null {
  const { t } = useTranslation('chat')
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId) ?? null)
  const streamingConversationId = useChatStore(s => s.streamingConversationId)
  const setConversationCompaction = useChatStore(s => s.setConversationCompaction)
  const [busy, setBusy] = useState(false)

  if (!conv) return null

  const compactedUpTo = conv.compactedUpTo ?? 0
  const uncompacted = conv.messages.length - compactedUpTo
  const estTokens = conversationTokens(conv)
  // "Long enough": reuse the per-conversation token estimator AND require a head
  // beyond the verbatim tail that is actually worth folding into a summary.
  const isLong = estTokens >= COMPACT_LONG_TOKENS && uncompacted > KEEP_TAIL
  if (!isLong) return null

  const disabled = busy || Boolean(streamingConversationId)

  const onCompact = async () => {
    if (disabled) return
    const keepFrom = Math.max(0, conv.messages.length - KEEP_TAIL)
    if (keepFrom <= compactedUpTo) return
    setBusy(true)
    try {
      const input = buildCompactionInput(conv, keepFrom)
      if (!input.trim()) throw new Error('nothing to compact')
      const summary = await requestCompactSummary(conv, input)
      if (!summary) throw new Error('empty summary')
      setConversationCompaction(conv.id, keepFrom, summary)
      showToast({ kind: 'success', text: t('compact.done', { defaultValue: 'Compacted {{count}} messages into a summary', count: keepFrom }) })
    } catch {
      showToast({ kind: 'error', text: t('compact.failed', { defaultValue: 'Could not compact this chat — try again' }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onCompact}
      disabled={disabled}
      title={t('compact.title', { defaultValue: 'Compress older messages into a summary to free up context — the full transcript stays on screen' })}
      style={{
        padding: '1px 6px',
        border: '2px solid var(--accent)',
        background: disabled ? 'var(--bg-inset)' : 'transparent',
        color: disabled ? 'var(--text-dim)' : 'var(--accent)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.05em',
        cursor: disabled ? 'default' : 'pointer',
        lineHeight: 1.6,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {busy
        ? t('compact.working', { defaultValue: 'COMPACTING…' })
        : `[${t('compact.button', { defaultValue: 'COMPACT' })}]`}
    </button>
  )
}
