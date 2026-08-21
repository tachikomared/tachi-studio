// apps/desktop/src/pages/chat/useMemoryAutoCapture.ts
//
// AUTO-CAPTURE v1 (USER-PAINS T16) — after a chat reply finishes streaming, run
// a cheap, zero-LLM heuristic over the USER message that prompted it. If it
// looks like a durable preference / identity statement ("always …", "call me
// …", "я предпочитаю …"), propose it as a memory fact via a sticky
// "Remember this?" toast. It NEVER saves on its own — only the [SAVE] click
// stores it. Precision-biased so it does not nag on ordinary messages.

import { useEffect, useRef } from 'react'
import type { TFunction } from 'i18next'
import { useChatStore, contentToText } from '../../store/chat.store'
import { useMemoryStore } from '../../store/memory.store'
import { showToast } from '../../components/Toaster'
import { detectCaptureCandidate } from '@tachi/core/src/memory/facts'

/**
 * Watches the chat store for the falling edge of streaming (a reply just
 * completed) and proposes a memory fact when the triggering user message is a
 * durable preference. `t` must be the 'chat' namespace translator.
 */
export function useMemoryAutoCapture(t: TFunction): void {
  const streamingMessageId = useChatStore(s => s.streamingMessageId)
  const prevStreaming = useRef<string | null>(null)
  // Normalized text of the last candidate we proposed — so a resend of the same
  // preference in one session doesn't re-toast.
  const lastProposed = useRef<string>('')
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    const was = prevStreaming.current
    prevStreaming.current = streamingMessageId
    // Only fire when streaming went non-null -> null (a reply finished).
    if (!was || streamingMessageId) return

    const conv = useChatStore.getState().getActive()
    if (!conv) return
    // The last USER message is the one that prompted the just-finished reply.
    const lastUser = [...conv.messages].reverse().find(m => m.role === 'user')
    if (!lastUser) return

    const candidate = detectCaptureCandidate(contentToText(lastUser.content))
    if (!candidate) return

    const norm = candidate.toLowerCase().trim()
    if (norm === lastProposed.current) return

    void proposeCapture(candidate, norm, lastProposed, tRef.current)
  }, [streamingMessageId])
}

async function proposeCapture(
  candidate: string,
  norm: string,
  lastProposed: React.MutableRefObject<string>,
  t: TFunction,
): Promise<void> {
  // Don't propose something already stored (enabled or not).
  try {
    const existing = await window.tachi.memoryFacts.list()
    if (existing.some(f => f.text.trim().toLowerCase() === norm)) {
      lastProposed.current = norm
      return
    }
  } catch { /* list failed — still offer to save */ }

  lastProposed.current = norm
  showToast({
    kind: 'info',
    ttl: 0, // sticky until the user acts — this is a decision, not a status
    text: `${t('capture.prompt', { defaultValue: 'Remember this?' })} “${candidate}”`,
    actions: [{
      label: t('capture.save', { defaultValue: 'Save' }),
      onClick: () => {
        window.tachi.memoryFacts.add(candidate, 'auto')
          .then(() => window.tachi.memoryFacts.list())
          .then(list => {
            useMemoryStore.getState().setFacts(list)
            showToast({ kind: 'success', text: t('capture.saved', { defaultValue: 'Saved to memory' }) })
          })
          .catch(() => { /* best-effort; user can add it by hand in Settings */ })
      },
    }],
  })
}
