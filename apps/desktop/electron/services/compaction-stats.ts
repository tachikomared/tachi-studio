// apps/desktop/electron/services/compaction-stats.ts
//
// Process-lifetime, in-memory aggregate of how many characters the deterministic
// tool-output compactor (tool-output-compactor.ts) saved — raw minus reduced —
// across every tool-done event, plus a chars/4 token estimate. It powers the
// Observability tab's "TOKENS SAVED" row.
//
// No persistence, no egress: a plain counter recorded from the compaction call
// sites in agent.ipc.ts and read back over the existing router:stats observability
// channel (the same read-only IPC the tab already polls for run stats).

let charsSaved  = 0
let reductions  = 0

/**
 * Record one compaction result. Only net savings count (raw > reduced); a
 * passthrough (ratio 1, e.g. tiny output) adds nothing and does not increment
 * the reduction count.
 */
export function recordCompactionSaving(rawChars: number, reducedChars: number): void {
  const saved = rawChars - reducedChars
  if (saved > 0) {
    charsSaved += saved
    reductions += 1
  }
}

export interface CompactionSavings {
  /** Total characters removed by the compactor this process. */
  charsSaved:  number
  /** chars/4 token estimate — the industry rule-of-thumb, labelled "est" in the UI. */
  tokensSaved: number
  /** How many tool outputs were actually reduced. */
  reductions:  number
}

export function getCompactionSavings(): CompactionSavings {
  return { charsSaved, tokensSaved: Math.round(charsSaved / 4), reductions }
}

/** Test/dev helper — reset the counters. */
export function resetCompactionSavings(): void {
  charsSaved = 0
  reductions = 0
}
