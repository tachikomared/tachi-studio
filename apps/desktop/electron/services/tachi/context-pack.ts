// apps/desktop/electron/services/tachi/context-pack.ts
//
// BATCH33 STAGE 2 — the context packer, applied to the TACHI harness's own
// session history under a TOKEN budget.
//
// Today runTachiLoop replays `opts.history` verbatim as the seed messages of a
// run, and the only backstop is compactAgentMessages, which fires MID-run
// (prepareStep) and works by dropping whole oldest turns. That is a blunt
// instrument at the START of a run: a long session hands the model thousands of
// tokens of chatter that has nothing to do with the turn being asked.
//
// This module puts @tachi/core's `packContext` (score-ranked, budget-bounded,
// anti-lost-in-the-middle) in front of that replay:
//
//   [t1 t2 … tN-4] [tN-3 tN-2 tN-1 tN]      (older …  keepRecent tail)
//         │                    │
//   scoreRecall(task, ·)       └─ replayed VERBATIM, roles intact
//         ↓
//    packContext(budget)  ->  ONE synthetic recap turn
//
// Two invariants make this safe to turn on by default:
//
//  1. NO-OP UNLESS IT PAYS. When there is no history, no older prefix, or the
//     older prefix already fits the budget, the INPUT ARRAY IS RETURNED BY
//     REFERENCE. Callers can (and do) assert identity to prove the assembly
//     path is untouched.
//  2. RECENCY IS NEVER PACKED. The last `keepRecent` turns are replayed exactly
//     as before — role, order and text. Only the older prefix is digested, and
//     a digest is a digest: reordering inside it (which is what phase 4 of the
//     packer does) is fine, whereas reordering a live transcript would not be.
//
// The recap turn is framed with the same `[automated …  — not from the user]`
// convention loop.ts already uses for the todo ledger and the continue nudge,
// so the model never mistakes a recap for a new instruction. It is NOT
// wrapUntrusted-wrapped: this is the user's own earlier turns in THIS session,
// text that is in the context verbatim today — no new trust boundary is
// crossed. Snippets recalled from OTHER conversations are a different matter
// and ARE sandbox-wrapped, at their own seam (chat-recall-service).
//
// Pure: @tachi/core only, no electron, no fs, no network.

import { packContext, scoreRecall, estimateTokens, estimateMessageTokens, type PackItem, type AgentHistoryTurn } from '@tachi/core'

/** ASCII-ish chars per token — the estimator's own WEIGHT_ASCII (0.25) inverted. */
const CHARS_PER_TOKEN = 4
/** Turns kept verbatim at the end of the history (2 exchanges). */
export const DEFAULT_KEEP_RECENT = 4
/** Per-item ceiling inside the recap (one turn never eats the whole budget). */
const RECAP_MAX_ITEM_CHARS = 400
/** Per-item floor — below this a quoted turn stops carrying meaning. */
const RECAP_MIN_ITEM_CHARS = 80
/** Bound on the shrink loop that enforces the token cap (geometric, converges fast). */
const MAX_SHRINK_PASSES = 24

export interface HistoryPackOptions {
  /** Hard cap, in ESTIMATED tokens, on the recap that replaces the older prefix. */
  budgetTokens: number
  /** Trailing turns replayed verbatim. Default 4. */
  keepRecent?: number
}

export interface HistoryPackStats {
  /** True when a recap actually replaced part of the history. */
  packed: boolean
  /** Older turns folded into the recap (0 when `packed` is false). */
  turnsDigested: number
  /** Estimated tokens of the older prefix BEFORE packing. */
  tokensBefore: number
  /** Estimated tokens of the recap turn AFTER packing (0 when not packed). */
  tokensAfter: number
}

/** The marker the recap turn opens with — asserted by tests, greppable in logs. */
export const RECAP_HEADER = '[automated recap of earlier turns — not from the user]'

/**
 * Score-rank + budget-pack the OLDER part of a session history against the
 * current task, leaving the recent tail verbatim.
 *
 * Returns the SAME ARRAY REFERENCE when nothing needed packing (see invariant 1
 * above), so `packAgentHistory(h, …) === h` is a meaningful assertion.
 */
export function packAgentHistory(
  history: readonly AgentHistoryTurn[] | undefined,
  task: string,
  opts: HistoryPackOptions,
): readonly AgentHistoryTurn[] | undefined {
  return packAgentHistoryWithStats(history, task, opts).history
}

/** `packAgentHistory` + what it did (for tests and for a one-line debug log). */
export function packAgentHistoryWithStats(
  history: readonly AgentHistoryTurn[] | undefined,
  task: string,
  opts: HistoryPackOptions,
): { history: readonly AgentHistoryTurn[] | undefined; stats: HistoryPackStats } {
  const nothing: HistoryPackStats = { packed: false, turnsDigested: 0, tokensBefore: 0, tokensAfter: 0 }
  if (!history || history.length === 0) return { history, stats: nothing }

  const budget = Math.floor(opts.budgetTokens)
  if (!Number.isFinite(budget) || budget <= 0) return { history, stats: nothing }

  const keepRecent = Math.max(0, Math.floor(opts.keepRecent ?? DEFAULT_KEEP_RECENT))
  if (history.length <= keepRecent) return { history, stats: nothing }

  const older = history.slice(0, history.length - keepRecent)
  const tail = history.slice(history.length - keepRecent)
  const tokensBefore = estimateMessageTokens(older as AgentHistoryTurn[])
  // Already cheaper than the budget → packing could only LOSE information.
  if (tokensBefore <= budget) return { history, stats: { ...nothing, tokensBefore } }

  const items: PackItem[] = older.map(t => ({
    text: `${t.role}: ${t.content}`,
    score: scoreRecall(task, t.content),
  }))

  const body = renderWithinTokenBudget(items, budget)
  if (!body) return { history, stats: { ...nothing, tokensBefore } }

  const recap: AgentHistoryTurn = {
    role: 'user',
    content: `${RECAP_HEADER}\nEarlier in this session (${older.length} turn(s), ranked by relevance to the current request and trimmed to fit):\n${body}`,
  }
  return {
    history: [recap, ...tail],
    stats: {
      packed: true,
      turnsDigested: older.length,
      tokensBefore,
      tokensAfter: estimateMessageTokens([recap]),
    },
  }
}

/**
 * Pack `items` into a bullet block whose ESTIMATED token count is <= `budget`.
 *
 * packContext budgets in CHARACTERS, and chars→tokens is script-dependent (an
 * ASCII char is ~0.25 tokens, a CJK one ~1.5 — a 6x spread). So: pack at the
 * ASCII-optimistic char budget, and if the estimator disagrees, re-pack at a
 * proportionally smaller one and then shrink geometrically until the cap holds.
 * The loop is bounded and monotone, so it always terminates.
 */
function renderWithinTokenBudget(items: PackItem[], budget: number): string {
  const render = (chars: number): string => {
    const packed = packContext(items, {
      targetItems: Math.max(3, Math.min(12, items.length)),
      maxTotalChars: Math.max(RECAP_MIN_ITEM_CHARS, Math.floor(chars)),
      minItemChars: RECAP_MIN_ITEM_CHARS,
      maxItemChars: RECAP_MAX_ITEM_CHARS,
    })
    return packed.items.map(s => `- ${s}`).join('\n')
  }

  let charBudget = budget * CHARS_PER_TOKEN
  let body = render(charBudget)
  let tokens = estimateTokens(body)
  if (tokens > budget) {
    // One proportional correction — lands on-budget for any single script.
    charBudget = Math.floor(charBudget * (budget / tokens))
    body = render(charBudget)
    tokens = estimateTokens(body)
  }
  // Mixed-script content can still overshoot; shrink until it cannot.
  for (let pass = 0; pass < MAX_SHRINK_PASSES && tokens > budget && body.length > 0; pass++) {
    charBudget = Math.floor(charBudget * 0.8)
    if (charBudget < RECAP_MIN_ITEM_CHARS) {
      // Below the packer's own floor it stops shrinking — clip the rendered
      // text directly so the cap is honoured no matter what.
      body = body.slice(0, Math.max(0, Math.floor(body.length * 0.8)))
    } else {
      body = render(charBudget)
    }
    tokens = estimateTokens(body)
  }
  return tokens > budget ? '' : body
}
