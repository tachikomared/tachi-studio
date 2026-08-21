// packages/core/src/tachi/tools/truncate.ts
//
// Tool-output truncation for the TACHI harness. Big tool outputs (a 40k-line
// build log, a `cat` of a generated bundle) would blow the model's context and
// cost a fortune, yet the model rarely needs every byte — it needs the start
// (the command, the first errors) and the end (the summary, the final error).
//
// truncateOutput keeps a HEAD and a TAIL and replaces the middle with a single
// marker line that embeds a sha256 receipt of the *full* output:
//   [... N lines / M chars omitted — sha256:<12hex> — full output retained out of band; do not re-run to retrieve ...]
// The hash makes an identical rerun recognisable (same input -> same receipt),
// and the "do not re-run to retrieve" wording tells the model the bytes still
// exist out of band so it shouldn't waste a turn re-running the command.
//
// Three independent caps are enforced (the smallest wins):
//   - maxLines  : structural — a head+tail line split (default 2000).
//   - maxBytes  : a hard size cap so a handful of very long lines can't slip
//                 through the line cap (default 50_000).
//   - maxTokens : an approximate model-facing budget at ~4 chars/token, i.e. a
//                 char budget of maxTokens*4; overrides the byte cap when smaller
//                 (default 10_000 tokens => ~40_000 chars).
//
// Pure: the only import is node:crypto for the content hash. No fs, no network.

import { createHash } from 'node:crypto'
import type { TruncateOptions, TruncateResult } from '../contract.js'

const DEFAULTS = { maxLines: 2000, maxBytes: 50_000, maxTokens: 10_000 }

/** ~4 chars per token — a self-contained budget heuristic (not the real tokenizer). */
const CHARS_PER_TOKEN = 4

/** sha256 of the full text, first 12 hex chars — the rerun-recognisable receipt. */
function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/** Slice a string to at most `n` characters (head). */
function head(s: string, n: number): string {
  return n <= 0 ? '' : s.slice(0, n)
}

/** Slice a string to at most `n` characters from the end (tail). */
function tail(s: string, n: number): string {
  return n <= 0 ? '' : s.slice(s.length - n)
}

/**
 * Keep the head and tail of `text`, eliding the middle with a hashed marker when
 * the text exceeds any of the line / byte / token caps. When it fits every cap,
 * the text is returned verbatim with `truncated:false` and no hash.
 */
export function truncateOutput(text: string, opts: TruncateOptions = {}): TruncateResult {
  const maxLines = opts.maxLines ?? DEFAULTS.maxLines
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens

  const originalChars = text.length

  // The effective character budget: the token budget (maxTokens*4) and the byte
  // cap, whichever is smaller. Bytes >= chars, so capping characters at maxBytes
  // is a conservative way to honour the byte cap for typical (ASCII) tool output;
  // a final byte-level trim below guarantees it for multibyte content too.
  const charBudget = Math.min(maxTokens * CHARS_PER_TOKEN, maxBytes)

  const lines = text.split('\n')
  const withinLines = lines.length <= maxLines
  const withinBytes = Buffer.byteLength(text, 'utf8') <= maxBytes
  const withinTokens = originalChars <= maxTokens * CHARS_PER_TOKEN

  if (withinLines && withinBytes && withinTokens) {
    return { text, truncated: false, originalChars, keptChars: originalChars }
  }

  const hash = contentHashOf(text)

  // ── Phase 1: line-based head+tail split (~50/50 of the line budget). ──────────
  // Reserve one line for the marker; never keep more lines than we started with.
  const lineCap = Math.min(maxLines, lines.length)
  const keepLines = Math.max(2, lineCap - 1)
  const headLineCount = Math.ceil(keepLines / 2)
  const tailLineCount = Math.floor(keepLines / 2)

  let headStr = lines.slice(0, headLineCount).join('\n')
  let tailStr = lines.slice(lines.length - tailLineCount).join('\n')

  // ── Phase 2: enforce the char/token budget on the kept content. ───────────────
  // Split the budget ~50/50 between head and tail, slicing INTO long lines so a
  // few huge lines can't exceed the cap.
  const headBudget = Math.ceil(charBudget / 2)
  const tailBudget = Math.floor(charBudget / 2)
  if (headStr.length > headBudget) headStr = head(headStr, headBudget)
  if (tailStr.length > tailBudget) tailStr = tail(tailStr, tailBudget)

  // How much of the ORIGINAL was dropped (everything that isn't kept head/tail).
  const keptContentChars = headStr.length + tailStr.length
  const omittedChars = Math.max(0, originalChars - keptContentChars)
  const omittedLines = Math.max(0, lines.length - headLineCount - tailLineCount)

  const marker =
    `[... ${omittedLines} lines / ${omittedChars} chars omitted — ` +
    `sha256:${hash} — full output retained out of band; do not re-run to retrieve ...]`

  let out = `${headStr}\n${marker}\n${tailStr}`

  // ── Phase 3: hard byte-cap backstop (multibyte safety). ───────────────────────
  // The marker is small + ASCII; if multibyte head/tail content still pushes the
  // produced text over maxBytes, trim the tail by characters until it fits.
  while (Buffer.byteLength(out, 'utf8') > maxBytes && tailStr.length > 0) {
    tailStr = tailStr.slice(0, -Math.max(1, Math.ceil(tailStr.length * 0.05)))
    out = `${headStr}\n${marker}\n${tailStr}`
  }

  return {
    text: out,
    truncated: true,
    contentHash: hash,
    originalChars,
    keptChars: out.length,
  }
}
