// apps/desktop/electron/services/tachi/outcome.ts
//
// GAVE-UP DETECTION. The harness completion signal cannot distinguish "the task
// is finished" from "the model stopped trying": both arrive as a provider
// finish-reason `stop`, and the UI happily renders "✓ Done (stop)" for either.
// Observed live: two 8-minute TACHIAPP runs read files, produced no assistant
// text, called no completion tool, changed nothing — and were shown as success.
//
// This module is the PURE decision table for the END state of a run. It answers
// one question — "did this run actually finish, or did it just stop?" — from
// facts the model does not own: whether complete() was ACCEPTED, whether the run
// had mutating intent, how many mutators actually ran, and whether the model
// said anything at all.
//
// Deliberately NOT here: the verify gate (verify-policy.ts) and the loop
// controller's "again?" decision (loop-controller.ts). This is strictly the
// terminal classification — the gate keeps working exactly as before.

import { classifyTask, type TaskType } from '@tachi/core'

/**
 * How a run ended. 'incomplete' is the new one: the provider said `stop`, but
 * nothing about the run supports the claim that the task was finished.
 */
export type RunEndOutcome = 'done' | 'incomplete' | 'error' | 'abort'

/**
 * Why a run was classified ENDED-INCOMPLETE.
 *   empty-text     — the model streamed no assistant text at all (it went quiet).
 *   no-completion  — mutating-intent task, no completion tool call, zero mutations.
 *   silent-finish  — the pass ended ON TOOL OUTPUT: tools ran and nothing was said
 *                    afterwards, so whatever those tools found was never reported.
 */
export type RunIncompleteCode = 'empty-text' | 'no-completion' | 'silent-finish'

/**
 * Task categories that imply the user asked for a CHANGE. `research` /
 * `brainstorm` / `other` are answer-shaped: finishing them with prose and no
 * completion call is legitimate, so they never trip the no-completion rule.
 */
const MUTATING_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  'debugging', 'feature', 'refactor', 'testing', 'build', 'git',
])

/**
 * Does this run carry mutating intent? PLAN mode never does (the whole point of
 * plan mode is to produce a plan, not a change), and in BUILD mode it is the
 * zero-LLM task classifier — the same one the cost ledger already trusts — that
 * decides whether the user asked for a change or for an answer.
 */
export function hasMutatingIntent(task: string, mode?: 'plan' | 'build'): boolean {
  if (mode === 'plan') return false
  return MUTATING_TASK_TYPES.has(classifyTask(task ?? ''))
}

/** The facts a terminal classification is made from. */
export interface RunEndFacts {
  /** How the loop itself terminated (provider finish / thrown error / abort). */
  terminal: 'stop' | 'error' | 'abort'
  /** complete() was called AND its summary passed validation + the verify gate. */
  completionAccepted: boolean
  /** The task asked for a change (see hasMutatingIntent). */
  mutatingIntent: boolean
  /** How many write/edit/bash calls actually SUCCEEDED this run. */
  mutations: number
  /** Everything the model streamed as assistant text on its final pass. */
  finalText: string
  /**
   * Did ANY tool run during the final pass? Optional on purpose: absent means
   * "not measured", and an unmeasured run must never trip the silent-finish
   * row — the classifier only ever accuses on evidence it actually has.
   */
  toolsRan?: boolean
  /**
   * Did assistant text arrive AFTER the last tool of the final pass? This is
   * the difference between "the model explained what it found" and "the
   * transcript just stops on a tool result". Only meaningful when `toolsRan`.
   */
  trailingText?: boolean
  /**
   * Characters of REASONING the model streamed on its final pass. Reasoning is
   * not assistant text — the harness does not render it — so a pass can be
   * "empty" by every measure above while the model in fact talked at length.
   * Optional: absent means "not measured" and reads exactly like zero.
   *
   * Live-found 2026-08-02 (Venice `olafangensan-glm-4.7-flash-heretic`): a
   * reasoning model streams its thinking in the SEPARATE `reasoning_content`
   * field, which the AI SDK surfaces as `reasoning-delta` parts. The loop only
   * ever accumulated `text-delta`, so the run was reported as a silent give-up.
   * The chat tab renders that same field as a <think> block, which is why the
   * SAME model looked perfectly healthy in chat and dead in CODE.
   */
  reasoningChars?: number
  /**
   * The provider's own finish reason for the final round ('stop', 'length', …).
   * A `length` finish is not a give-up: it means WE truncated the model at
   * maxOutputTokens before it could answer. Optional — absent means unmeasured.
   */
  finishReason?: string
}

export interface RunEndVerdict {
  outcome: RunEndOutcome
  /** Present only for `incomplete`. */
  code?: RunIncompleteCode
  /** One line, safe to show the user and to write to the run log. */
  detail?: string
}

/**
 * The decision table.
 *
 *   abort / error                                    → unchanged (abort / error)
 *   stop + complete() accepted                       → done
 *   stop + no assistant text at all                  → incomplete (empty-text)
 *   stop + mutating intent + zero mutations          → incomplete (no-completion)
 *   stop + tools ran + no text after the last tool   → incomplete (silent-finish)
 *   otherwise                                        → done
 *
 * An accepted completion always wins: the model went through the summary
 * validator and the verify gate, which is the strongest "finished" evidence the
 * harness has. Silence is checked next because it is mode-independent — a run
 * that says nothing has told the user nothing, whatever it was asked to do.
 *
 * SILENT-FINISH is the last row, and it is the narrowest: it fires only when the
 * pass ran tools and then stopped ON their output. Live-found (dogfood-4): a run
 * opened with prose, then executed a 21-tool group, then stopped — no complete(),
 * no closing word. `finalText` was non-empty (that opening prose) and mutations
 * were > 0, so every earlier row passed it as done and the operator got no
 * summary. Text BEFORE the tools cannot describe what the tools found, so the
 * measurement that matters is text AFTER the last one. A pass that ends with
 * prose is untouched — which is every answer-shaped run, and every mutating run
 * that says what it changed.
 */
/**
 * The EMPTY-TEXT sentence. The outcome is the same either way — the operator
 * still got nothing — but "nothing" has three very different causes and the
 * blameless one used to read exactly like the model giving up:
 *
 *   * reasoning-only    — the model DID talk, in `reasoning_content`, and the
 *                         harness renders no reasoning. Naming the volume is
 *                         what turns "it did nothing" into "it thought and we
 *                         dropped it", which is the actionable version.
 *   * truncated         — finishReason 'length': WE cut it off at
 *                         maxOutputTokens. Blaming the model for our own cap is
 *                         the single most misleading thing this line can say.
 *   * genuinely silent  — the original sentence, now reserved for the case it
 *                         was actually written for.
 *
 * Reasoning + truncation together is the common shape (a reasoning model eats
 * the whole output budget thinking), so it gets its own combined sentence
 * rather than picking one of the two halves.
 */
function emptyTextDetail(f: RunEndFacts): string {
  const reasoned = (f.reasoningChars ?? 0) > 0
  const truncated = f.finishReason === 'length'
  const chars = f.reasoningChars ?? 0
  if (reasoned && truncated) {
    return `the model spent its entire output budget on reasoning (${chars} chars of thinking, no answer and no tool call) — this model reasons too much for the harness's output limit; pick a lower reasoning effort or a different model`
  }
  if (reasoned) {
    return `the model produced ${chars} chars of REASONING but no answer and no tool call — its thinking is not shown in CODE, so the run looks empty; this model may not be driving the tools at all`
  }
  if (truncated) {
    return 'the model hit the output-token limit before it said anything — it was cut off, not finished'
  }
  return 'the run ended without any assistant text and without calling the completion tool'
}

export function classifyRunEnd(f: RunEndFacts): RunEndVerdict {
  if (f.terminal === 'abort') return { outcome: 'abort' }
  if (f.terminal === 'error') return { outcome: 'error' }
  if (f.completionAccepted) return { outcome: 'done' }
  if (!(f.finalText ?? '').trim()) {
    return {
      outcome: 'incomplete',
      code: 'empty-text',
      detail: emptyTextDetail(f),
    }
  }
  if (f.mutatingIntent && f.mutations === 0) {
    return {
      outcome: 'incomplete',
      code: 'no-completion',
      detail: 'the task asked for a change, but the run made none and never called the completion tool',
    }
  }
  if (f.toolsRan && !f.trailingText) {
    return {
      outcome: 'incomplete',
      code: 'silent-finish',
      detail: 'the run ended on tool output with no closing message — nothing was reported back',
    }
  }
  return { outcome: 'done' }
}

/**
 * AUTO-CONTINUE. The single nudge an ENDED-INCOMPLETE run gets before the
 * verdict is surfaced. Short on purpose: it names the failure, offers the two
 * legitimate exits (continue, or complete with a summary), and demands a reason
 * for the third — so "I gave up" becomes a statement instead of a silence.
 */
export const CONTINUE_NUDGE =
  'You stopped without completing or summarizing. Continue the task; if it is already complete, call the completion tool with a summary; if you cannot proceed, say exactly why.'
