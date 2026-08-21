// apps/desktop/src/pages/chat/chat-context.ts
//
// CHAT COMPACT — the PURE builder for a conversation's OUTGOING request
// context. Compaction is NON-DESTRUCTIVE: the store keeps every message; this
// helper only shapes what is sent to the provider on the next turn.
//
// Contract (mirrors the CODE tab's compactedUpTo idiom in AgentPage.tsx):
//   outgoing = [ compactSummary as a leading context note, ...messages.slice(compactedUpTo) ]
//
// When compactedUpTo is 0/undefined (or no summary), it is a plain passthrough:
// the flattened prior turns, unchanged. The input array is NEVER mutated.

// Type-only import — keeps this helper PURE (no zustand/persist/electron runtime
// pulled into the vitest 'node' env), exactly like chat-branching.ts.
import type { ChatMessage, ContentPart } from '../../store/chat.store'

/** A provider-ready chat turn (text-flattened). */
export interface OutgoingMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Flatten message content to plain text. Mirrors contentToText() in
 * chat.store.ts (kept inline so this module stays runtime-dependency-free).
 */
function flattenContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

/**
 * Leading context-note header prepended to the compaction summary. LLM-facing
 * (never shown in the UI), so it stays a plain English constant — same as the
 * CODE tab's static "[Context compacted…]" marker.
 */
export const COMPACT_NOTE_HEADER =
  '[CONTEXT NOTE — the earlier part of this conversation was compacted into the dense summary below to save context. Treat it as authoritative background: it preserves the key facts, decisions, names, and code references from those earlier messages.]'

function clampFrom(compactedUpTo: number | undefined, len: number): number {
  if (typeof compactedUpTo !== 'number' || compactedUpTo <= 0) return 0
  return Math.min(Math.floor(compactedUpTo), len)
}

/**
 * Build the provider-ready context for the next send.
 *
 * @param messages     the conversation's messages (prior turns; the current
 *                     user turn is sent separately by the caller)
 * @param compactedUpTo index into `messages`; everything before it is dropped
 *                     from the request and represented by `summary`
 * @param summary      dense summary of messages[0..compactedUpTo)
 * @param opts.cap     keep at most the last N flattened turns (safety bound);
 *                     the injected summary note does not count toward the cap
 */
export function buildChatContext(
  messages: ChatMessage[],
  compactedUpTo?: number,
  summary?: string,
  opts?: { cap?: number },
): OutgoingMessage[] {
  const from = clampFrom(compactedUpTo, messages.length)

  // slice() returns a fresh array; filter/map allocate new objects — the input
  // `messages` array and its elements are never mutated.
  const flat: OutgoingMessage[] = messages
    .slice(from)
    .filter(m => !m.streaming && !m.error)
    .map(m => ({ role: m.role, content: flattenContent(m.content) }))
    .filter(m => m.content.trim().length > 0)

  const capped = opts?.cap && opts.cap > 0 ? flat.slice(-opts.cap) : flat

  if (from > 0 && summary && summary.trim().length > 0) {
    return [{ role: 'user', content: `${COMPACT_NOTE_HEADER}\n\n${summary.trim()}` }, ...capped]
  }
  return capped
}

// ─── A CUT POINT THAT HOLDS STILL ────────────────────────────────────────────
//
// `buildChatContext`'s cap is a SLIDING window: `flat.slice(-cap)`. Past turn
// `cap` it drops the oldest turn every time it adds a new one, so the request's
// LEADING BYTES are different on every single send.
//
// Every cache in the path keys on those leading bytes:
//
//   • llama-server keeps a cached prompt prefix per slot and reuses the longest
//     common one; a moved start means the whole prompt is processed again, on
//     the owner's machine that is currently running the CPU build.
//   • Anthropic, OpenAI and DeepSeek all price a prefix hit at a fraction of a
//     fresh token, and all of them match on an exact leading prefix.
//
// So the sliding window converted a free re-read into a full re-processing,
// every turn, forever — for the sake of holding the window at exactly `cap`.
//
// The fix is to cut ONCE and hold the cut: keep sending from the same message
// index until the tail actually outgrows the cap, then re-cut down to about
// HALF of it. The halving is what makes it amortised — the next re-cut is
// `cap/2` turns away instead of one — so invalidations go from every turn to
// one per ten (at cap 20).
//
// WHAT IT COSTS, stated plainly: between re-cuts the model sees somewhere
// between cap/2 and cap turns rather than always exactly cap. Right after a
// re-cut it has the least. That is the trade — a shorter tail sometimes, in
// exchange for not re-reading the whole conversation every time.

/** Is this message one the request would actually carry? */
function isEligible(m: ChatMessage): boolean {
  return !m.streaming && !m.error && flattenContent(m.content).trim().length > 0
}

/** How many eligible turns live at or after `from`. */
function countEligible(messages: ChatMessage[], from: number): number {
  let n = 0
  for (let i = from; i < messages.length; i++) if (isEligible(messages[i])) n++
  return n
}

/**
 * The message index that keeps roughly `target` eligible turns in the tail,
 * aligned forward onto a USER turn.
 *
 * The alignment is not cosmetic: a request whose first message is an assistant
 * turn is rejected outright by some providers and merely odd for the rest, and
 * the sliding window never had to think about it because it cut on flattened
 * turns rather than on the transcript. If no user turn exists at or after the
 * counted index, the count wins — an awkward opening beats an empty request.
 */
function cutForTail(messages: ChatMessage[], floor: number, target: number): number {
  let kept = 0
  let idx = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    if (!isEligible(messages[i])) continue
    kept++
    idx = i
    if (kept >= target) break
  }
  // THE ALIGNMENT HAS TO USE THE SAME TEST THE CUT DID.
  //
  // This walked forward on `role !== 'user'` alone, which is a strictly weaker
  // predicate than the `isEligible` the backward scan above uses — so it could
  // stop on a user turn that `buildChatContext` then FILTERS OUT, and the
  // request would open on the assistant turn after it. The exact thing this
  // alignment exists to prevent, produced by the alignment.
  //
  // Reachable with an ATTACHMENT-ONLY user turn: send an image with no caption
  // and `content` is `[{type:'image',…}]`, so `flattenContent` yields '' and the
  // message is ineligible while still carrying `role: 'user'`. Land there and
  // the head of the outgoing array is an assistant message — which some
  // providers reject outright. Worse, `from` is then PERSISTED as
  // `contextFrom`, so the broken opening is rebuilt on every send until the
  // next cap-driven recut, not just once.
  let aligned = idx
  while (aligned < messages.length
         && !(messages[aligned].role === 'user' && isEligible(messages[aligned]))) aligned++
  if (aligned >= messages.length) aligned = idx
  return Math.max(floor, Math.min(aligned, messages.length))
}

/** What the next request should carry, and where it was cut. */
export interface ChatContextPlan {
  /** Provider-ready turns, summary note included when the chat was compacted. */
  messages: OutgoingMessage[]
  /**
   * Index into `messages` this request starts at. PERSIST IT and pass it back
   * as `opts.pinnedFrom` next turn — that is the entire mechanism; an unstored
   * plan slides exactly like the window it replaces.
   */
  from: number
  /** The cut MOVED this turn, so the prefix cache is cold for one send. */
  recut: boolean
}

/**
 * Build the next request's context around a cut point that does not move on
 * its own.
 *
 * @param opts.pinnedFrom the `from` this conversation last used, if any
 * @param opts.cap        the most eligible turns a request may carry
 */
export function planChatContext(
  messages: ChatMessage[],
  compactedUpTo?: number,
  summary?: string,
  opts?: { cap?: number; pinnedFrom?: number },
): ChatContextPlan {
  const floor = clampFrom(compactedUpTo, messages.length)
  const cap   = opts?.cap && opts.cap > 0 ? Math.floor(opts.cap) : 0
  // A compaction that lands AFTER the pin wins: its summary already stands in
  // for those turns, and sending them twice is the one outcome neither is for.
  // `before` is what the CALLER BELIEVES, not what we do with it. Taking it any
  // later hid a whole class of move: a stale or floor-overridden pin got
  // silently corrected inside here, `recut` came back false, the caller stored
  // nothing, and the same wrong pin arrived again next turn — corrected again,
  // forever. The flag means "your stored value is no longer the one in use",
  // which includes moving BACKWARDS and includes never having had one.
  const before = clampFrom(opts?.pinnedFrom, messages.length)
  let from = Math.max(floor, before)

  // A STALE PIN MUST NOT EMPTY THE REQUEST. Edit-and-rewind truncates the
  // transcript, and a pin stored when it was longer can end up past everything
  // that survives — which would send the model no history at all while the
  // screen still shows a conversation. Falling back to the floor costs one cold
  // prefix; the alternative costs the conversation.
  if (from > floor && countEligible(messages, from) === 0) from = floor

  if (cap > 0 && countEligible(messages, from) > cap) {
    from = cutForTail(messages, floor, Math.max(1, Math.ceil(cap / 2)))
  }

  return {
    // No cap here — `from` IS the cut. Passing one back would re-introduce the
    // slide inside the very function that exists to remove it.
    messages: buildChatContext(messages, from, summary),
    from,
    recut: from !== before,
  }
}
