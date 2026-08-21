// packages/core/src/tachi/task-classify.ts
//
// Zero-LLM task-category classifier (STEAL 2026-07-09, codeburn MIT). Gives the
// cost ledger a "by task type" dimension — what am I actually spending tokens
// ON — without an extra model call. Classifies a user message / agent task by
// keyword, using FIRST-MATCH-WINS: the category whose keyword appears EARLIEST
// in the text wins, which fixes the classic bug where "add error handling" was
// tagged `debugging` (the debug regex ran first) instead of `feature` (because
// "add" appears before "error"). codeburn issue #196.
//
// Pure + dependency-free. Tool-sequence refinement (edit→coding, bash+read→
// exploration) is deliberately NOT here: the ledger records per-usage-chunk and
// has no per-run tool sequence, so the honest, universally-available signal is
// the task text.

export type TaskType =
  | 'debugging' | 'feature' | 'refactor' | 'testing'
  | 'git' | 'build' | 'research' | 'brainstorm' | 'other'

// Order matters ONLY as the tie-break when two categories match at the same
// index (rare). Each entry: [type, /pattern/]. Patterns lifted from codeburn's
// classifier (uncopyrightable keyword facts, re-derived).
const PATTERNS: Array<[TaskType, RegExp]> = [
  ['testing',   /\b(test|pytest|vitest|jest|mocha|spec|coverage)\b/i],
  ['git',       /\b(commit|git|branch|merge|rebase|stash|cherry-?pick|pull request|\bpr\b|push|pull)\b/i],
  ['build',     /\b(build|deploy|compile|bundle|package|install|npm i\b|pnpm|docker|ci\b|release)\b/i],
  ['debugging', /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|regression|\b40[0-9]\b|\b50[0-9]\b)\b/i],
  ['feature',   /\b(add|create|implement|new|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the)|support)\b/i],
  ['refactor',  /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|migrate|split|dedupe|de-?duplicate)\b/i],
  ['brainstorm',/\b(brainstorm|idea|what\s+if|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend|plan)\b/i],
  ['research',  /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare|why)\b/i],
]

/**
 * Classify a task/message into a coarse category by its earliest-matching
 * keyword. Empty/keyword-less text → 'other'. Only the FIRST ~2000 chars are
 * scanned (the intent lives up front; a huge pasted log shouldn't dominate).
 */
export function classifyTask(text: string): TaskType {
  if (typeof text !== 'string' || !text.trim()) return 'other'
  const hay = text.slice(0, 2000)
  let best: TaskType = 'other'
  let bestIdx = Infinity
  for (const [type, re] of PATTERNS) {
    const m = re.exec(hay)
    if (m && m.index < bestIdx) { bestIdx = m.index; best = type }
  }
  return best
}
