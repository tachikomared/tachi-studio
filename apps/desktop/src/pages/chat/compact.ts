// apps/desktop/src/pages/chat/compact.ts
//
// CHAT COMPACT — summary generation + trigger logic for the plain chat page.
//
// The summary is produced with the conversation's CURRENT provider/model via
// the existing streaming send infra (window.tachi.chat.send). To keep it OUT of
// the visible transcript we route the one-shot stream to a THROWAWAY
// conversation id and hijack `streamingConversationId` so the store's chunk
// router (chat.store appendChunk) can never attach the phantom answer to a real
// conversation. We capture the streamed text with a private onChunk listener,
// then restore state. Nothing is written to the store or disk for the throwaway
// run. Compaction itself is non-destructive (see chat-context.ts).

import { useChatStore, contentToText, type Conversation, type ChatMessage } from '../../store/chat.store'
import type { ChatChunk } from '@tachi/core'

/** Messages kept verbatim after a compaction (≈ the last 6 turns). Mirrors the CODE tab's 12. */
export const KEEP_TAIL = 12
/**
 * "Long enough to offer COMPACT". Reuses conversationTokens (the existing
 * per-conversation estimator) against the chat TokenMeter's WARN step (4000).
 */
export const COMPACT_LONG_TOKENS = 4000

const COMPACT_PROMPT = [
  'You are compressing a conversation into a dense CONTEXT NOTE so the earlier',
  'messages can be dropped from the model\'s working memory without losing',
  'anything important.',
  '',
  'Write a compact summary (NOT a transcript) of the conversation below.',
  'Preserve: concrete FACTS, DECISIONS made, NAMES (people, files, functions,',
  'libraries, endpoints, ids), CODE references, open questions, and any user',
  'preferences or constraints. Drop pleasantries and filler. Prefer terse bullet',
  'points. Do not invent anything that is not present. Output only the summary.',
].join('\n')

/** One transcript line per message ("USER: …" / "ASSISTANT: …"), errors skipped. */
function transcript(messages: ChatMessage[]): string {
  return messages
    .filter(m => !m.error)
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${contentToText(m.content).trim()}`)
    .filter(line => line.length > 'ASSISTANT: '.length)
    .join('\n\n')
}

/**
 * Text handed to the summarizer for a compaction that keeps messages[keepFrom..]
 * verbatim. When the conversation was already compacted, the previous summary is
 * folded in so nothing from the older head is lost across repeated compactions.
 */
export function buildCompactionInput(conv: Conversation, keepFrom: number): string {
  const from = conv.compactedUpTo && conv.compactedUpTo > 0 ? Math.min(conv.compactedUpTo, keepFrom) : 0
  const head = transcript(conv.messages.slice(from, keepFrom))
  if (from > 0 && conv.compactSummary?.trim()) {
    return `Earlier summary of the conversation so far:\n${conv.compactSummary.trim()}\n\nNewer messages to fold into the summary:\n${head}`
  }
  return head
}

/**
 * Generate the compaction summary via a one-shot streaming send that is kept
 * out of the transcript. Resolves with the summary text (may reject on
 * provider error / timeout / abort). Never throws synchronously.
 */
export function requestCompactSummary(
  conv: Pick<Conversation, 'providerId' | 'model'>,
  inputText: string,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const throwawayId = globalThis.crypto.randomUUID()
    const store = useChatStore.getState()
    let summaryMsgId: string | null = null
    let acc = ''
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      try { off?.() } catch { /* ignore */ }
      // Only release the streaming flag if it is still ours (the store's own
      // 'done' handler normally clears it first — this is the failure path).
      if (useChatStore.getState().streamingConversationId === throwawayId) {
        useChatStore.getState().setStreamingConversation(null)
      }
    }
    const done = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn() }

    const off = window.tachi.chat.onChunk((chunk: ChatChunk) => {
      if (chunk.type === 'start') {
        // The first (and only, sends are blocked while we run) start after our
        // send is the summary stream.
        if (summaryMsgId === null) summaryMsgId = chunk.messageId
        return
      }
      if (summaryMsgId === null || chunk.messageId !== summaryMsgId) return
      if (chunk.type === 'delta') acc += chunk.text
      else if (chunk.type === 'done') done(() => resolve(acc.trim()))
      else if (chunk.type === 'error') done(() => reject(new Error(chunk.error.message)))
    })

    const timer = setTimeout(() => done(() => reject(new Error('compaction timed out'))), timeoutMs)

    // Route the phantom stream away from every real conversation transcript.
    store.setStreamingConversation(throwawayId)
    window.tachi.chat.send({
      conversationId: throwawayId,
      message: `${COMPACT_PROMPT}\n\n<conversation>\n${inputText}\n</conversation>`,
      history: [],
      model: conv.model,
      providerId: conv.providerId,
      systemMessage: '',
    }).catch((err: unknown) => done(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}
