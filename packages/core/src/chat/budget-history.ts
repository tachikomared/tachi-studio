// packages/core/src/chat/budget-history.ts
//
// CONTEXT-ECONOMY P1 — bound conversation-history growth before resend.
//
// Chat resends the whole prior conversation every turn. On long chats that grows
// without limit. We trim by DROPPING WHOLE OLDEST TURNS (never rewriting message
// bodies — that would mangle content and, worse, shift the cached prefix on
// every turn) once the history crosses a char budget, and we prepend a single
// notice turn so the model knows earlier turns were elided. The most-recent
// turns — the ones that matter most — are always kept.
//
// Char count is a deliberate, tokenizer-free proxy (~4 chars/token); the budget
// is a safety backstop, not a precise token cap.

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface BudgetHistoryOptions {
  /** Max total content chars to keep across all history turns. */
  maxChars: number
  /** Notice text; `{n}` is replaced with the number of dropped turns. */
  noticeTemplate?: string
  /**
   * Two-phase compaction, phase 1 (STEAL 2026-06-12; OpenAlice microcompact):
   * before any whole-turn drop, turns OLDER than the last `keepRecentVerbatim`
   * are elided to ~`perTurnCapChars` (head + tail kept, middle replaced with
   * an elision marker). Deterministic, no LLM. Often fits the budget while
   * keeping every turn present. Omit for the legacy drop-only behavior.
   */
  microcompact?: { keepRecentVerbatim: number; perTurnCapChars: number }
}

const DEFAULT_NOTICE = '[earlier conversation: {n} older turn(s) omitted to fit context]'

function totalChars(turns: HistoryTurn[]): number {
  let n = 0
  for (const t of turns) n += t.content.length
  return n
}

/**
 * Return a history that fits within `maxChars`, dropping whole oldest turns and
 * prepending a notice. Always keeps the most-recent turn even if it alone
 * exceeds the budget. A history already within budget is returned unchanged
 * (same array reference is NOT guaranteed; contents are equal).
 */
/** Elide the middle of `content`, keeping head + tail (~capChars total). */
function elideMiddle(content: string, capChars: number): string {
  if (content.length <= capChars) return content
  const half = Math.max(1, Math.floor(capChars / 2))
  const elided = content.length - half * 2
  return `${content.slice(0, half)}[… ${elided} chars elided …]${content.slice(content.length - half)}`
}

export function budgetHistory(history: HistoryTurn[], opts: BudgetHistoryOptions): HistoryTurn[] {
  const maxChars = Math.max(0, opts.maxChars)
  if (history.length === 0 || totalChars(history) <= maxChars) return history.slice()

  // ── Phase 1: microcompact old oversized turns (no LLM, whole turns kept) ──
  if (opts.microcompact) {
    const { keepRecentVerbatim, perTurnCapChars } = opts.microcompact
    const firstVerbatim = Math.max(0, history.length - Math.max(0, keepRecentVerbatim))
    history = history.map((t, i) =>
      i < firstVerbatim && t.content.length > perTurnCapChars
        ? { ...t, content: elideMiddle(t.content, perTurnCapChars) }
        : t,
    )
    if (totalChars(history) <= maxChars) return history.slice()
    // Still over → fall through to phase 2 over the compacted copy.
  }

  // ── Phase 2: drop whole oldest turns ──
  // Keep the newest turns that fit; walk from the end accumulating chars.
  const kept: HistoryTurn[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    // Always keep the most-recent turn (kept.length === 0) regardless of size.
    if (kept.length > 0 && used + t.content.length > maxChars) break
    kept.unshift(t)
    used += t.content.length
  }

  const dropped = history.length - kept.length
  if (dropped <= 0) return kept

  const notice = (opts.noticeTemplate ?? DEFAULT_NOTICE).replace('{n}', String(dropped))
  // The notice is a user-role turn so it never confuses assistant-turn parsing.
  return [{ role: 'user', content: notice }, ...kept]
}
