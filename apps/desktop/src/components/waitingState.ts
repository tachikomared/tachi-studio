// apps/desktop/src/components/waitingState.ts
//
// "IS THE MODEL MAKING US WAIT?" — the pure derivation behind the animated
// tail indicator on both transcripts (CODE tab and CHAT tab).
//
// The distinction that matters is NOT "is a run in flight" — the status badge
// already answers that. It is "is a run in flight AND nothing is landing on
// screen right now", i.e. the two dead gaps an operator actually stares at:
//
//   1. between pressing send and the first streamed token
//   2. between a tool result and the next model text
//
// While tokens ARE arriving (the agent store coalesces consecutive `text`
// events into one growing block) the prose itself is the progress indicator,
// and a running tool already renders its own live tool card — so both of those
// states deliberately return false. Framework-free on purpose: every rule here
// is asserted in test/unit/waitingState.test.ts without a DOM.

/** The shape of the transcript's last event, reduced to what the rule needs. */
export type TranscriptTail =
  /** No events yet — the run just started. */
  | 'empty'
  /** The operator's own message is the last thing on screen. */
  | 'user-text'
  /** Model prose with at least one character in it — tokens are landing. */
  | 'text'
  /** A `text` block that exists but is still empty (first chunk was blank). */
  | 'text-empty'
  /** A tool is executing; its own card carries the running state. */
  | 'tool-call'
  /** A tool finished — we are now waiting on the model's next move. */
  | 'tool-done'
  /** Anything else (fusion panel, error, done, …). */
  | 'other'

/** Classify the transcript's last event. `null`/`undefined` ⇒ empty transcript. */
export function transcriptTail(last?: { type: string; text?: string } | null): TranscriptTail {
  if (!last) return 'empty'
  switch (last.type) {
    case 'user-text': return 'user-text'
    case 'text':      return (last.text ?? '').length > 0 ? 'text' : 'text-empty'
    case 'tool-call': return 'tool-call'
    case 'tool-done': return 'tool-done'
    default:          return 'other'
  }
}

export interface TranscriptWaitingInput {
  /** Agent run status ('idle' | 'starting' | 'running' | 'done' | 'error'). */
  status: string
  tail: TranscriptTail
  /**
   * Surface ownership latch — the transcript on screen belongs to another tab
   * (or an archive) and is rendered empty. Never animate a borrowed surface.
   */
  blocked?: boolean
  /** A permission card is up: the run is parked on the OPERATOR, not the model. */
  awaitingPermission?: boolean
}

export function isTranscriptWaiting(input: TranscriptWaitingInput): boolean {
  const { status, tail, blocked, awaitingPermission } = input
  if (blocked || awaitingPermission) return false
  if (status !== 'running' && status !== 'starting') return false
  // Tokens landing / a tool card already showing its own spinner — both are
  // visible progress, so an extra indicator would just be noise.
  if (tail === 'text' || tail === 'tool-call') return false
  return true
}

export interface ChatWaitingInput {
  /** True when THIS conversation is the one currently streaming. */
  streaming: boolean
  /** Role of the last message in the conversation; absent ⇒ empty transcript. */
  lastRole?: 'user' | 'assistant' | null
  /** Rendered text of the last assistant message (empty ⇒ nothing to look at). */
  lastAssistantText?: string
  /** The last assistant message already carries a non-text part (image, audio…). */
  lastAssistantHasParts?: boolean
  /** The stream failed — the bubble shows the error, not a wait. */
  lastAssistantErrored?: boolean
}

/**
 * CHAT tab twin of {@link isTranscriptWaiting}. The chat store only appends the
 * assistant bubble on the provider's `start` chunk, so between send and first
 * byte the last message is the USER's — that is the gap this catches.
 */
export function isChatWaiting(input: ChatWaitingInput): boolean {
  const { streaming, lastRole, lastAssistantText, lastAssistantHasParts, lastAssistantErrored } = input
  if (!streaming) return false
  if (!lastRole) return false
  if (lastRole === 'user') return true
  if (lastAssistantErrored) return false
  if (lastAssistantHasParts) return false
  return (lastAssistantText ?? '').length === 0
}
