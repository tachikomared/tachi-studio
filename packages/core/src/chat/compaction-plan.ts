// packages/core/src/chat/compaction-plan.ts
//
// CONTEXT-ECONOMY P2 — LLM-summarization planner for history compaction.
//
// STEAL 2026-06-13 (OpenAlice src/core/compaction.ts): two-phase compaction.
// Phase 1 (cheap, no LLM) already exists here as budgetHistory's `microcompact`
// (elide old oversized turns; see budget-history.ts). When that STILL exceeds
// the char budget, phase 2 escalates: summarize the OLDER HALF of the
// conversation via an LLM and replace it with a single bounded notice turn —
// so the resend window stays bounded across turns instead of dropping context
// outright. This module is PURE: it decides WHAT to summarize and builds the
// prompt, but never calls an LLM. The caller (chat-service) runs the actual
// summarization with whatever provider it already has and splices the result
// back via applyCompactionSummary.
//
// Char count is the same tokenizer-free proxy budgetHistory uses (~4 chars/tok).

import type { HistoryTurn } from './budget-history.js'

export interface PlanLlmCompactionOptions {
  /** Same char budget as budgetHistory — the backstop we're trying to fit. */
  maxChars: number
  /**
   * The most-recent N turns are never summarized; they stay verbatim. Should
   * match (or exceed) the microcompact `keepRecentVerbatim` so the LLM summary
   * and the verbatim tail don't overlap.
   */
  keepRecentVerbatim: number
}

export interface CompactionPlan {
  /** True when an LLM summary is warranted (over budget AND has a summarizable span). */
  needsSummary: boolean
  /** Oldest contiguous span to summarize, in original order. Empty when !needsSummary. */
  toSummarize: HistoryTurn[]
  /** Turns to keep verbatim (the recent tail). Equals `history` when !needsSummary. */
  keep: HistoryTurn[]
}

function totalChars(turns: HistoryTurn[]): number {
  let n = 0
  for (const t of turns) n += t.content.length
  return n
}

/**
 * Decide, AFTER phase-1 microcompact still exceeds budget, which oldest span to
 * summarize vs keep verbatim. Mirrors OpenAlice's full-compact trigger but
 * targets the OLDER HALF: we always keep the recent `keepRecentVerbatim` turns,
 * then summarize at least the older half of what remains so the window shrinks
 * meaningfully (a one-turn summary would re-trigger next turn).
 *
 * Returns needsSummary=false (and the history unchanged in `keep`) when already
 * under budget, when empty, or when the verbatim window covers everything.
 */
export function planLlmCompaction(
  history: HistoryTurn[],
  opts: PlanLlmCompactionOptions,
): CompactionPlan {
  const keepRecent = Math.max(0, opts.keepRecentVerbatim)
  const maxChars = Math.max(0, opts.maxChars)

  // Under budget (or empty) → nothing to do; keep everything verbatim.
  if (history.length === 0 || totalChars(history) <= maxChars) {
    return { needsSummary: false, toSummarize: [], keep: history.slice() }
  }

  // The recent-verbatim window is always preserved. If it already covers the
  // whole history there is no older span to summarize.
  const firstVerbatim = Math.max(0, history.length - keepRecent)
  if (firstVerbatim <= 0) {
    return { needsSummary: false, toSummarize: [], keep: history.slice() }
  }

  // Summarize the older HALF of the WHOLE conversation so the window shrinks
  // meaningfully and stays bounded across turns (compact_boundary semantics) —
  // a one-turn summary would just re-trigger next turn. The recent-verbatim
  // window is a hard floor: never summarize past `firstVerbatim`.
  const halfOfWhole = Math.floor(history.length / 2)
  const summarizeCount = Math.min(firstVerbatim, Math.max(1, halfOfWhole))
  const toSummarize = history.slice(0, summarizeCount)
  const keep = history.slice(summarizeCount)

  return { needsSummary: true, toSummarize, keep }
}

const PROMPT_HEADER =
  'Create a detailed summary of the earlier conversation below, preserving all ' +
  'context needed to continue. Respond with ONLY the summary — no preamble, no tools.'

/**
 * Build the structured, Cursor-style summarization prompt for the span chosen by
 * planLlmCompaction. Sections: goal / done / current state / pending / key context
 * (ported from OpenAlice's buildSummarizationPrompt, trimmed to this app's needs).
 * Pure and deterministic — the caller sends the returned string to the provider.
 */
export function buildCompactionPrompt(toSummarize: HistoryTurn[]): string {
  const conversation = toSummarize
    .map((t) => `[${t.role.toUpperCase()}]: ${t.content}`)
    .join('\n\n')

  return `${PROMPT_HEADER}

<conversation>
${conversation}
</conversation>

Produce a summary with these sections, preserving specific values (numbers, names, IDs, paths) exactly:

1. Goal: the user's primary request and intent.
2. Done: what has been accomplished or completed so far.
3. Current state: files, settings, or data the session is operating on right now.
4. Pending: tasks that still need to be done.
5. Key context: constraints, preferences, decisions, and important data points to remember.`
}

const SUMMARY_NOTICE_PREFIX =
  '[compact_boundary] Earlier conversation summarized to fit context:'

/**
 * Splice an LLM-produced summary back into history: prepend a single user-role
 * notice turn (mirroring budget-history's notice convention) carrying the
 * summary, followed by the verbatim `keep` turns. The `compact_boundary` marker
 * lets later turns recognize the bounded window. Does not mutate `keep`.
 */
export function applyCompactionSummary(summaryText: string, keep: HistoryTurn[]): HistoryTurn[] {
  const notice: HistoryTurn = {
    role: 'user',
    content: `${SUMMARY_NOTICE_PREFIX}\n\n${summaryText}`,
  }
  return [notice, ...keep]
}
