// apps/desktop/src/pages/chat/reasoning.ts
//
// Reasoning-tag parsing for "thinking" models. Some models emit their chain of
// thought wrapped in <think>…</think> (also <thought>…</thought> and
// <reasoning>…</reasoning>) before the real answer. We split assistant text into
// an ordered list of segments so MessageBubble can render reasoning as a
// collapsed disclosure and the answer as normal markdown.
//
// Streaming-safe: an UNCLOSED opening tag (the model is still emitting its
// thoughts) yields a reasoning segment flagged `open: true` so the UI can show
// it as in-progress rather than swallowing the text.

export type ReasoningSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; open: boolean }

// Recognised reasoning tag names (case-insensitive). Keep this list tight —
// only well-known chain-of-thought wrappers, never generic HTML.
const TAG_NAMES = ['think', 'thought', 'reasoning'] as const

// One regex that matches any opening or closing reasoning tag. The captured
// groups tell us the tag name and whether it's a closer.
const TAG_RE = new RegExp(`<(/?)(?:${TAG_NAMES.join('|')})\\s*>`, 'gi')

/**
 * Split assistant text into ordered text / reasoning segments.
 *
 * - Balanced <think>…</think> → one closed reasoning segment.
 * - Unclosed <think> at the tail (streaming) → one open reasoning segment that
 *   absorbs the remainder of the string.
 * - Text outside any tag → text segments.
 *
 * Adjacent same-kind segments are NOT merged here; callers can merge if needed.
 * Empty segments are dropped.
 */
export function parseReasoning(input: string): ReasoningSegment[] {
  if (!input) return []
  // Fast path: no reasoning tags at all → single text segment.
  TAG_RE.lastIndex = 0
  if (!TAG_RE.test(input)) return [{ kind: 'text', text: input }]

  const segments: ReasoningSegment[] = []
  TAG_RE.lastIndex = 0
  let cursor = 0
  // Depth > 0 means we're inside (possibly nested) reasoning tags.
  let depth = 0
  let reasoningStart = 0 // index just AFTER the opening tag at depth 1

  const pushText = (text: string) => {
    if (text) segments.push({ kind: 'text', text })
  }
  const pushReasoning = (text: string, open: boolean) => {
    // Keep whitespace-only reasoning out unless it's the in-progress (open) one.
    if (text.trim() || open) segments.push({ kind: 'reasoning', text, open })
  }

  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(input)) !== null) {
    const isClose = match[1] === '/'
    const tagStart = match.index
    const tagEnd = TAG_RE.lastIndex

    if (!isClose) {
      if (depth === 0) {
        // Emit any plain text leading up to this opening tag.
        pushText(input.slice(cursor, tagStart))
        reasoningStart = tagEnd
      }
      depth++
    } else {
      if (depth > 0) {
        depth--
        if (depth === 0) {
          // Closed a top-level reasoning block.
          pushReasoning(input.slice(reasoningStart, tagStart), false)
          cursor = tagEnd
        }
      }
      // A stray closing tag with depth 0 is ignored (cursor unchanged).
    }
  }

  if (depth > 0) {
    // Unclosed reasoning block — still streaming. Everything after the opener
    // is in-progress reasoning.
    pushReasoning(input.slice(reasoningStart), true)
  } else {
    // Trailing text after the last balanced block.
    pushText(input.slice(cursor))
  }

  return segments
}

/** True if the text contains any (opening) reasoning tag. */
export function hasReasoning(input: string): boolean {
  TAG_RE.lastIndex = 0
  const m = TAG_RE.exec(input)
  return m !== null
}
