// packages/core/src/chat/reasoning-stream.ts
//
// Some reasoning models (DeepSeek-R1, QwQ) don't emit their chain-of-thought
// inline as <think>…</think>; when routed through OpenRouter or the DeepSeek
// API they stream it in a SEPARATE delta field — `reasoning_content`
// (DeepSeek) or `reasoning` (OpenRouter) — with `content` empty until the
// thinking is done. Our stream parsers only read `delta.content`, so that
// thinking was dropped entirely (and, for models that stream reasoning FIRST,
// the answer arrived with an eerie silent gap).
//
// The renderer ALREADY renders inline <think>…</think> as a collapsed
// "thinking" disclosure (see chat/reasoning.ts). So instead of a new chunk
// type + renderer path, we transform the separate reasoning field back INTO an
// inline <think> block on the fly: open the tag on the first reasoning
// fragment, close it when real content begins. The result is well-formed
// <think>…</think> the existing parser handles, including the streaming-open
// case (unclosed tag while still thinking).

/** Read the separate reasoning field from an OpenAI-compatible SSE chunk. */
export function extractReasoningDelta(parsed: unknown): string | undefined {
  const delta = (parsed as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices?.[0]?.delta
  if (!delta) return undefined
  // DeepSeek: reasoning_content · OpenRouter: reasoning
  const r = delta.reasoning_content ?? delta.reasoning
  return typeof r === 'string' && r.length > 0 ? r : undefined
}

/**
 * Stateful transformer that folds a stream's separate reasoning + content
 * fragments into one inline stream with <think>…</think> boundaries.
 *
 * Usage per chunk: `next(reasoningFragment, contentFragment)` → the text to
 * emit as a delta (possibly with an opening/closing tag spliced in). Call
 * `flush()` once at stream end to close a still-open block.
 */
export function createThinkWrapper(): {
  next(reasoning: string | undefined, content: string | undefined): string
  flush(): string
  isOpen(): boolean
} {
  let open = false
  return {
    next(reasoning, content) {
      let out = ''
      if (reasoning) {
        if (!open) { out += '<think>'; open = true }
        out += reasoning
      }
      if (content) {
        if (open) { out += '</think>'; open = false }
        out += content
      }
      return out
    },
    flush() {
      if (open) { open = false; return '</think>' }
      return ''
    },
    isOpen() { return open },
  }
}
