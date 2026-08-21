// apps/desktop/electron/services/util/clean-reasoning.ts
//
// Reasoning-leakage stripping for streamed model output. Ported from Pulse's
// patrol_ai.go CleanThinkingTokens(): thinking models sometimes leak their
// internal chain-of-thought into the *visible* answer instead of (or alongside)
// a dedicated reasoning channel. This removes the leaked markers + their content
// so only the real answer is stored/displayed.
//
// IMPORTANT — operates on the FULL accumulated text, never per token. The caller
// must pass the final/■accumulated assistant string (e.g. the surplus workflow
// finalText, or the renderer's accumulated message body on the `done` chunk).
// Running this per-delta would mangle a marker split across two chunks and could
// strip a block before its closing tag arrives. It is a no-op on clean text and
// idempotent (running it twice equals running it once).
//
// Distinct from src/pages/chat/reasoning.ts: that parser SPLITS text into
// ordered text/reasoning segments for the disclosure UI (it expects well-formed
// streaming tags). This one is a defensive scrubber for the stored/displayed
// answer — it also handles DeepSeek's full-width DSML function-call markers and
// orphaned end-markers a renderer-side segment parser would not.
//
// Pure TypeScript — no imports, no side-effects (vitest-importable).

// Well-known chain-of-thought block tags, case-insensitive. We require the tag
// to terminate at `\s*>` so prose like "<thinking about it>" is NOT treated as
// a <think> marker. Keep this list tight — only known reasoning wrappers.
const BLOCK_TAGS: ReadonlyArray<{ open: RegExp; close: RegExp }> = [
  { open: /<think\s*>/i, close: /<\/think\s*>/i },
  { open: /<thought\s*>/i, close: /<\/thought\s*>/i },
  { open: /<reasoning\s*>/i, close: /<\/reasoning\s*>/i },
  // Pipe form used by some "reasoning" models: <|reasoning|> … <|/reasoning|>.
  { open: /<\|reasoning\|>/i, close: /<\|\/reasoning\|>/i },
]

// DeepSeek's internal function-call markup. When the model fails to use the
// proper tool-calling API it dumps this markup (typically at the tail of the
// answer). Both the Unicode full-width pipe (｜, U+FF5C) and ASCII (|) forms,
// opening and closing. Everything from the first occurrence to the end is junk.
const DSML_MARKERS: readonly string[] = [
  '<｜DSML｜',
  '</｜DSML｜',
  '<｜/DSML｜',
  '<|DSML|',
  '</|DSML|',
  '<|/DSML|',
]

// Line-level end-markers that may dangle with no matching opener (the close tag
// of a block whose opener never made it into the visible text). The full-width
// "end of thinking" variants use U+2581 (▁) between words, matching DeepSeek.
const END_MARKERS: readonly string[] = [
  '<｜end▁of▁thinking｜>',
  '<|end_of_thinking|>',
  '<|end▁of▁thinking|>',
  '</think>',
  '</thought>',
  '</reasoning>',
  '<|/reasoning|>',
]

/**
 * Strip leaked reasoning markers (and their content) from a complete assistant
 * answer. See the file header for the per-token caveat and idempotence guarantee.
 *
 * Phases, mirroring the Pulse original:
 *  0. Cut DeepSeek DSML function-call markup from its first occurrence to the end.
 *  1. Remove balanced block tags (open + content + close); an unclosed opener is
 *     swept from the opener to the end of the text.
 *  2. Sweep a dangling end-marker that has NO matching opener before it (the
 *     model started mid-reasoning) — drop everything from the start of the text
 *     up to and including that marker, plus its trailing newline.
 */
export function cleanReasoningLeakage(text: string): string {
  if (!text) return text
  let out = text

  // Phase 0: DeepSeek DSML function-call leakage → truncate at first marker.
  for (const marker of DSML_MARKERS) {
    const idx = out.indexOf(marker)
    if (idx >= 0) out = out.slice(0, idx).trimEnd()
  }

  // Phase 1: remove balanced (or unclosed) block tags.
  for (const { open, close } of BLOCK_TAGS) {
    // Re-scan from scratch each pass so multiple blocks of the same kind, and
    // text shifting after a removal, are all handled.
    for (;;) {
      const openMatch = open.exec(out)
      if (!openMatch) break
      const openIdx = openMatch.index
      const afterOpen = openIdx + openMatch[0].length
      const rest = out.slice(afterOpen)
      const closeMatch = close.exec(rest)
      if (!closeMatch) {
        // Unclosed opener — drop from the opening tag to the end.
        out = out.slice(0, openIdx)
      } else {
        const end = afterOpen + closeMatch.index + closeMatch[0].length
        out = out.slice(0, openIdx) + out.slice(end)
      }
    }
  }

  // Phase 2: dangling end-markers with no matching opener. After Phase 1,
  // balanced blocks are gone, so any surviving end-marker is orphaned: the
  // reasoning that preceded it leaked without its opening tag. Drop everything
  // up to and including the FIRST such marker (and a trailing newline).
  for (const marker of END_MARKERS) {
    // Loop to a fixed point: several orphaned markers of the same kind each
    // sweep the leaked reasoning that precedes them, and this guarantees
    // idempotence — a second full pass finds no marker left to act on. (A
    // one-shot indexOf would leave a 2nd same-kind marker behind, e.g.
    // "x</think>y</think>z" -> "y</think>z".)
    for (;;) {
      const idx = out.indexOf(marker)
      if (idx < 0) break
      let cut = idx + marker.length
      if (out[cut] === '\r') cut++
      if (out[cut] === '\n') cut++
      out = out.slice(cut)
    }
  }

  return out.trim()
}
