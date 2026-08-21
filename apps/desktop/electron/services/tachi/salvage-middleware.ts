// apps/desktop/electron/services/tachi/salvage-middleware.ts
//
// Wires the (previously dead) tool-call SALVAGE parser into the streamText loop
// for `native-then-salvage` models. Many gateway/OSS models (DeepSeek, Qwen-coder
// on vLLM, Groq-Llama, MiMo) refuse to emit native `tool_calls` and instead print
// the call as TEXT. Without this, a step on such a model finishes as plain text,
// no tool-call part ever fires, and the run is a silent no-op — exactly the
// "provider zoo" case TACHI exists to handle.
//
// Approach: an AI SDK LanguageModelMiddleware that intercepts the model's output
// stream. It buffers assistant text and watches for any NATIVE tool indicator. If
// a step finishes with NO native tool-call but the buffered text contains
// salvageable calls (parsed by @tachi/core salvageToolCalls), it injects synthetic
// `tool-call` stream parts and rewrites the finish reason to 'tool-calls'. The
// SDK's own tool loop then executes them through the normal (gated) tool path —
// no separate execution lane, no manual message threading. Native tool-calls and
// plain prose pass through untouched (salvage only fires on the empty-native case).

import { type LanguageModelMiddleware } from 'ai'
import { salvageToolCalls } from '@tachi/core'

// ── Holding back a tool marker instead of streaming it ───────────────────────
//
// The salvage above only runs at `finish`. Every text-delta was forwarded the
// instant it arrived, so on a `native-then-salvage` model the user WATCHED the
// raw call appear in the answer —
//
//     I'll check that for you. <tool_call>{"name":"read_file","arg…
//
// — and then the tool ran anyway. The parse was right and the presentation was
// broken: this middleware knew the text was a tool call, and said so only after
// showing it.
//
// So text is now emitted with a small tail held back. Two rules:
//   1. a suffix of the buffer that could be the START of a marker is withheld
//      until the next delta proves it either way (`<tool` is three keystrokes
//      from `<tool_call>` and also from a sentence about tooling);
//   2. once a marker actually opens, text stops flowing entirely, because
//      everything after it is call payload, not prose.
//
// The buffer the PARSER sees is untouched — it still receives every character.
// Only what reaches the screen is filtered, so salvage behaviour is identical.

/** The openings `salvageToolCalls` recognises (salvage.ts scanners). Bare JSON
 *  is deliberately absent: it is the loosest matcher, only fires when nothing
 *  delimited was found, and suppressing on a leading `{` would eat prose. */
const TOOL_MARKERS = ['<tool_call>', '<function', '```json'] as const

/** Longest marker, so the held-back tail is bounded and predictable. */
const MAX_MARKER_LEN = Math.max(...TOOL_MARKERS.map(m => m.length))

/**
 * How many trailing characters of `s` must be withheld because they could be
 * the beginning of a marker. 0 when nothing is pending.
 *
 * Checks the longest possible overlap first so `<tool_call` (10) is preferred
 * over the accidental `<` (1) — withholding too little is the bug, withholding
 * too much only delays a character by one delta.
 */
export function pendingMarkerOverlap(s: string): number {
  const max = Math.min(s.length, MAX_MARKER_LEN - 1)
  for (let n = max; n > 0; n--) {
    const tail = s.slice(s.length - n)
    if (TOOL_MARKERS.some(m => m.startsWith(tail))) return n
  }
  return 0
}

/** Index of the first complete marker opening in `s`, or -1. */
export function firstMarkerIndex(s: string): number {
  let best = -1
  for (const m of TOOL_MARKERS) {
    const at = s.indexOf(m)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/**
 * Build a middleware that recovers text-encoded tool calls when a model emits no
 * native tool-call. `idPrefix` disambiguates synthetic ids across wrapped models.
 */
export function createSalvageMiddleware(idPrefix = 'salvage'): LanguageModelMiddleware {
  // Persists across steps (one middleware instance per run) so synthetic
  // toolCallIds stay unique across the whole request.
  let counter = 0
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream()
      let text = ''
      let sawNativeTool = false
      let salvaged = false // latch: never salvage twice (e.g. a stream with two 'finish' parts)
      // Text accepted but not yet forwarded: either a possible marker prefix,
      // or nothing. Flushed on `finish` when no marker ever opened.
      let held = ''
      // Latch: a marker HAS opened, so no further text reaches the screen.
      let suppressing = false
      // The shape of the last text-delta (it carries the part id the SDK
      // groups deltas by), so a flush emits a real one instead of a
      // hand-built object cast into place.
      let lastTextChunk: { type: 'text-delta'; id: string; delta: string } | null = null
      return {
        stream: stream.pipeThrough(
          new TransformStream({
            transform: (chunk, controller) => {
              if (chunk.type === 'text-delta') {
                // The PARSER always sees everything — only the screen is filtered.
                text += chunk.delta
                lastTextChunk = chunk
                if (suppressing) return

                held += chunk.delta
                const at = firstMarkerIndex(held)
                if (at >= 0) {
                  // A real marker opened. Emit the prose before it (if any) and
                  // stop: everything from here is call payload.
                  suppressing = true
                  const before = held.slice(0, at)
                  held = ''
                  if (before) controller.enqueue({ ...chunk, delta: before })
                  return
                }
                const keep = pendingMarkerOverlap(held)
                const emit = held.slice(0, held.length - keep)
                held = held.slice(held.length - keep)
                if (emit) controller.enqueue({ ...chunk, delta: emit })
                return
              } else if (chunk.type === 'tool-call' || chunk.type === 'tool-input-start') {
                // The model produced a real tool call — never salvage on top of it.
                sawNativeTool = true
              }

              if (chunk.type === 'finish') {
                // A held tail that never became a marker is ordinary prose and
                // must not be swallowed — withholding is a delay, never a
                // deletion. Suppressed text stays suppressed: a marker DID
                // open, so it was a call, whether or not the parse succeeds.
                if (held && !suppressing && lastTextChunk) {
                  controller.enqueue({ ...lastTextChunk, delta: held })
                }
                held = ''
              }

              if (chunk.type === 'finish' && !sawNativeTool && !salvaged) {
                const calls = salvageToolCalls(text)
                if (calls.length > 0) {
                  salvaged = true
                  for (const c of calls) {
                    controller.enqueue({
                      type: 'tool-call',
                      toolCallId: `${idPrefix}-${counter++}`,
                      toolName: c.name,
                      input: JSON.stringify(c.args),
                    })
                  }
                  // Keep the finish reason coherent with the injected calls. The SDK
                  // drives loop continuation off the EXECUTED tool-calls, not this
                  // field (so the rewrite is cosmetic) — but emitting 'stop' next to
                  // tool-calls would be incoherent, so we set 'tool-calls'.
                  controller.enqueue({ ...chunk, finishReason: { unified: 'tool-calls' as const, raw: chunk.finishReason.raw } })
                  return
                }
              }
              controller.enqueue(chunk)
            },
          }),
        ),
        ...rest,
      }
    },
  }
}
