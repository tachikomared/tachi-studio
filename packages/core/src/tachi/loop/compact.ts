// packages/core/src/tachi/loop/compact.ts
//
// Agent-loop history compaction — a context backstop for LONG agentic runs.
//
// The TACHI loop drives AI SDK streamText with multi-step tool calling. Across a
// long run the SDK accumulates the full message history (every assistant
// tool-call + every tool result) and resends it each step. A handful of bulky
// tool results — a 256 KiB file read, a long command transcript — can push the
// history past the model's context window and the run dies mid-task. This module
// gives the loop (via streamText's `prepareStep`) a deterministic, LLM-free way
// to bound that growth.
//
// Strategy: HEAD + TAIL drop of WHOLE messages, never content rewriting.
//   * Keep the first message (the task — the anchor the model needs throughout).
//   * Keep the last `keepRecent` messages verbatim (recent tool results matter
//     most for the next step).
//   * Drop the middle, replacing it with ONE short user-role notice.
//
// Why drop whole messages instead of eliding message bodies (as chat does in
// budget-history.ts)? An assistant message carries tool-CALL parts that the
// provider pairs with the matching tool-RESULT message; rewriting or splitting a
// body risks orphaning a tool result from its call (a hard provider error).
// Dropping at TURN boundaries keeps every kept tool result paired with its call:
// the tail is a suffix of the original (valid) sequence, and the notice carries
// no tool calls. We also refuse to let the tail BEGIN on a 'tool' message (whose
// issuing assistant would have been dropped) — we pull the boundary back to
// include that assistant.
//
// Char count is a tokenizer-free proxy (~3.5 chars/token); the budget is a
// safety backstop, not a precise token cap.

/** Minimal structural view of an AI SDK ModelMessage (role + opaque content). */
export interface AgentMessageLike {
  role: string
  content: unknown
}

export interface CompactAgentOptions {
  /** Total budget, in chars, across all messages. Compaction triggers above it. */
  maxChars: number
  /** Always keep this many most-recent messages verbatim (min 1). */
  keepRecent: number
  /** Notice text for the elided block; `{n}` → number of dropped messages. */
  noticeTemplate?: string
}

const DEFAULT_NOTICE = '[agent context: {n} earlier message(s) elided to fit the context budget — the task and the most recent steps are kept verbatim]'

// ~3.5 chars/token (conservative for English/code) × the fraction of the context
// window we let the message history occupy (leaving room for the system prompt,
// the next response, and tokenizer slack).
const CHARS_PER_TOKEN = 3.5
const HISTORY_WINDOW_FRACTION = 0.5

/**
 * The char budget the agent message history may occupy for a model with the
 * given context window (in tokens). A backstop, generous by design.
 */
export function agentHistoryBudgetChars(contextWindowTokens: number): number {
  const tokens = Math.max(0, contextWindowTokens)
  return Math.round(tokens * CHARS_PER_TOKEN * HISTORY_WINDOW_FRACTION)
}

/** Approximate size of one message in chars (string body, else JSON length). */
function messageChars(m: AgentMessageLike): number {
  const c = m.content
  if (typeof c === 'string') return c.length
  try { return JSON.stringify(c).length } catch { return 0 }
}

/** Total char size across a message list. */
export function totalMessageChars(messages: readonly AgentMessageLike[]): number {
  let n = 0
  for (const m of messages) n += messageChars(m)
  return n
}

/**
 * Bound the agent message history to ~`maxChars` by dropping whole oldest
 * turns from the middle (keeping the first message + the last `keepRecent`),
 * inserting one user-role notice in their place.
 *
 * Returns the SAME array reference when already within budget or when nothing
 * can be safely dropped — callers can use `result === messages` as a cheap
 * "no compaction happened" signal. The tail is always a suffix of the input, so
 * tool-call/tool-result pairing inside it is preserved; the tail never begins on
 * a 'tool' message.
 */
export function compactAgentMessages<T extends AgentMessageLike>(
  messages: T[],
  opts: CompactAgentOptions,
): T[] {
  const maxChars = Math.max(0, opts.maxChars)
  const keepRecent = Math.max(1, Math.floor(opts.keepRecent))
  if (messages.length <= 2) return messages
  if (totalMessageChars(messages) <= maxChars) return messages

  // Tail = the last `keepRecent` messages. Never drop the first message (head).
  const naive = Math.max(1, messages.length - keepRecent)

  // ── AND THEN QUANTISE IT, SO THE CUT DOES NOT WALK ────────────────────────
  // `naive` is a function of messages.length, which grows by ~2 every step
  // (one assistant tool-call, one tool result). So once a run is over budget
  // the cut ADVANCED ON EVERY STEP — and with it the notice's `{n}` and the
  // first tail message. Everything after the head was a different prefix each
  // time, which is precisely what a prompt cache cannot survive: Anthropic,
  // OpenAI and DeepSeek all match on an exact leading prefix, and llama-server
  // reuses the longest common one per slot. A long agentic run is where prefix
  // reuse is worth the most, and it was the one place we guaranteed a miss.
  //
  // Snapping the boundary to a grid of `keepRecent` holds it still for about
  // half that many steps and then moves it by a whole block. Kept messages
  // range from keepRecent to 2×keepRecent — always MORE than before, never
  // fewer, so nothing the old behaviour retained is lost.
  let tailStart = 1 + Math.floor((naive - 1) / keepRecent) * keepRecent

  // …unless holding it costs more than it saves. The larger tail is only
  // affordable if it FITS: this function is a backstop against a run dying on
  // a context overflow, and a cache hit is not worth a dead run. When the held
  // tail is over budget on its own, take the tight cut and pay the miss.
  if (tailStart < naive && totalMessageChars(messages.slice(tailStart)) > maxChars) tailStart = naive

  // Don't let the tail begin on a 'tool' result whose issuing assistant would be
  // dropped — pull the boundary back to include that assistant (keeps pairing).
  while (tailStart > 1 && messages[tailStart]!.role === 'tool') tailStart--

  const dropped = tailStart - 1
  if (dropped <= 0) return messages // nothing safely droppable → best-effort no-op

  const head = messages[0]!
  const tail = messages.slice(tailStart)
  const notice = {
    role: 'user',
    content: (opts.noticeTemplate ?? DEFAULT_NOTICE).replace('{n}', String(dropped)),
  } as unknown as T
  return [head, notice, ...tail]
}
