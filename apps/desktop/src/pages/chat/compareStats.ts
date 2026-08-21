// apps/desktop/src/pages/chat/compareStats.ts
//
// Pure per-column stat math for Fusion COMPARE (UX #6): tokens/second and
// time-to-first-token derived from what the panel leg actually measured.
// TRUTHFUL by construction — any dimension that wasn't (or can't be) measured
// comes back null and the UI renders "—", never a fabricated number.
//
// Inputs per column (from the `panel` chunk / ChatPanelMember):
//   ms      — wall time around the leg's full stream (always measured)
//   ttftMs  — request start → first delta (absent when no delta arrived)
//   tokens  — provider-reported completion tokens (absent when no usage chunk)
//   text    — the answer (chars/4 fallback estimate when tokens are absent)
//
// tok/s is computed over the GENERATION window (ms − ttft): the time spent
// producing tokens, not waiting for the first one. When that window is too
// small to be meaningful (single buffered flush, sub-80ms) we refuse to divide
// and return null instead of an absurd rate.

export interface CompareStatInput {
  text: string
  ms: number
  tokens?: number
  ttftMs?: number
}

export interface CompareStats {
  /** Tokens per second over the generation window; null = not measurable. */
  tokPerSec: number | null
  /** Whether tokPerSec used provider-reported tokens (true) or chars/4 (false). */
  tokensEstimated: boolean
  /** Time-to-first-token in seconds; null = never measured (no delta arrived). */
  ttftSeconds: number | null
}

/** Minimum generation window for a meaningful rate (guards ÷~0 explosions). */
const MIN_GENERATION_MS = 80

export function computeCompareStats(m: CompareStatInput): CompareStats {
  const hasTtft = typeof m.ttftMs === 'number' && Number.isFinite(m.ttftMs) && m.ttftMs >= 0
  const ttftSeconds = hasTtft ? (m.ttftMs as number) / 1000 : null

  const reported = typeof m.tokens === 'number' && Number.isFinite(m.tokens) && m.tokens > 0
  const tokenCount = reported
    ? (m.tokens as number)
    : m.text.trim().length > 0 ? Math.ceil(m.text.length / 4) : 0

  // Without a TTFT there was no observed stream → no honest rate either.
  const generationMs = hasTtft ? m.ms - (m.ttftMs as number) : NaN
  const tokPerSec =
    tokenCount > 0 && Number.isFinite(generationMs) && generationMs >= MIN_GENERATION_MS
      ? tokenCount / (generationMs / 1000)
      : null

  return { tokPerSec, tokensEstimated: !reported, ttftSeconds }
}

/** "312" / "9.4" — integers above 10, one decimal below. Null-safe at call site. */
export function formatRate(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1)
}

/** "0.4" / "12.0" — TTFT seconds with one decimal. */
export function formatTtft(seconds: number): string {
  return seconds.toFixed(1)
}
