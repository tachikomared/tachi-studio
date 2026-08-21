// packages/core/src/tachi/estimate-tokens.ts
//
// Unicode-aware, char-weighted token ESTIMATOR for the TACHI harness. This is a
// fast heuristic, NOT a real tokenizer — it never loads a BPE merge table; it
// just walks code points and assigns each a fractional token weight, then rounds
// up. It is used to keep prompt assembly inside a model's context window and to
// size tool-output truncation budgets.
//
// Why not the naive `text.length / 4`? JavaScript `String.length` counts UTF-16
// code UNITS, not Unicode code points. CJK characters are 1 UTF-16 unit but cost
// ~1.5 tokens; emoji are surrogate pairs (2 UTF-16 units) but cost ~2 tokens.
// The naive formula underestimates CJK and emoji badly, which makes compaction /
// truncation trigger far too late for non-English prompts.
//
// `estimateMessageTokens` serializes each message with JSON.stringify before
// weighing it, so structured / tool-call content (tool names, ids, argument
// objects, mirrored identifiers) is counted too. A text-only estimate undercounts
// tool-heavy transcripts by 2-3x (per lossless-claw's finding), which lets a
// "budgeted" prompt overflow the model at the boundary.

import type { EstimableMessage } from './contract.js'

// Per-code-point token weights.
const WEIGHT_ASCII = 0.25      // ~4 chars/token for Latin/ASCII text
const WEIGHT_CJK = 1.5         // CJK ideographs, kana, hangul — denser per char
const WEIGHT_SURROGATE = 2     // emoji / supplementary-plane code points
const WEIGHT_OTHER = 0.5       // other BMP non-ASCII (accented Latin, Cyrillic, …)

// A small fixed cost added per message for the role/wrapper framing the model
// boundary always pays (role label, message delimiters, etc.).
const PER_MESSAGE_OVERHEAD = 4

/** Detect CJK code points across the relevant Unicode ranges (ideographs, kana, hangul, fullwidth). */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0x2a700 && cp <= 0x2b73f) || // CJK Extension C
    (cp >= 0x2b740 && cp <= 0x2b81f) || // CJK Extension D
    (cp >= 0x2b820 && cp <= 0x2ceaf) || // CJK Extension E
    (cp >= 0x2ceb0 && cp <= 0x2ebef) || // CJK Extension F
    (cp >= 0x3000 && cp <= 0x303f) ||   // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x30ff) ||   // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) ||   // Hangul Syllables
    (cp >= 0xff00 && cp <= 0xffef)      // Fullwidth Forms
  )
}

/** Weight for a single Unicode code point. ASCII < other-BMP < CJK < surrogate-pair. */
function estimateCodePointTokens(cp: number): number {
  // Supplementary plane (emoji and the like) — surrogate pairs in UTF-16.
  if (cp > 0xffff) return WEIGHT_SURROGATE
  if (isCjkCodePoint(cp)) return WEIGHT_CJK
  // ASCII / basic Latin (control chars included — they are cheap, single-byte).
  if (cp < 0x80) return WEIGHT_ASCII
  return WEIGHT_OTHER
}

/**
 * Estimate the token cost of `text` using Unicode-aware per-code-point weights,
 * rounded up. Iterates by code point (via the string iterator) so surrogate
 * pairs count once at the heavier emoji weight rather than twice at ASCII. Empty
 * string -> 0. Pure and deterministic.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  // The string iterator yields whole code points, so a surrogate pair is one
  // step (and `char.codePointAt(0)` returns the combined point).
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    tokens += estimateCodePointTokens(cp)
  }
  return Math.ceil(tokens)
}

/**
 * Estimate the total token cost of a chat message list. Each message is
 * JSON.stringify'd first so structured / tool-call content (names, ids, argument
 * objects) is weighed, then `estimateTokens` is summed over the serialized
 * strings plus a small per-message overhead. This tracks the model boundary far
 * better than a text-only estimate, which undercounts tool-heavy turns 2-3x.
 * Pure and deterministic.
 */
export function estimateMessageTokens(messages: EstimableMessage[]): number {
  let total = 0
  for (const message of messages) {
    const serialized = serializeMessage(message)
    total += estimateTokens(serialized) + PER_MESSAGE_OVERHEAD
  }
  return total
}

/**
 * Serialize a message to the string the estimator weighs. Normally just
 * JSON.stringify(message); if that throws (e.g. a cyclic reference, which agent
 * transcript data does not contain in practice but defensive code should survive),
 * fall back to a shallow render of the content so the estimate is never silently
 * near-zero.
 */
function serializeMessage(message: EstimableMessage): string {
  try {
    return JSON.stringify(message) ?? ''
  } catch {
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      let acc = ''
      for (const part of content) {
        try {
          acc += JSON.stringify(part) ?? ''
        } catch {
          // skip an unserializable part
        }
      }
      return acc
    }
    return ''
  }
}
