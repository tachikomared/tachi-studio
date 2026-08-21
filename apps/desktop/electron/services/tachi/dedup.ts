// apps/desktop/electron/services/tachi/dedup.ts
//
// Per-run dedup of READ-ONLY tool calls for the TACHI loop. Ported from the
// agentic-rag "retrieval_keys" set (graph_state.py set_union reducer +
// nodes.py fingerprint guard): a research agent that re-issues an identical
// retrieval re-burns the same context tokens for no new information. We catch
// the same waste here — when the model repeats an EXACT read/grep/glob it has
// already run this turn (with no intervening mutation), the loop returns a tiny
// pointer instead of re-emitting the full output. The win is context tokens,
// not compute.
//
// This complements the existing stall guard (consecutive identical calls): the
// stall guard refuses 3-in-a-row repeats to break a stuck model; dedup catches
// the cheaper, non-consecutive case (read A, read B, read A again) where the
// model is not stuck but the second A is redundant.
//
// Identity uses the SAME fingerprint as the stall guard (@tachi/core: canonical
// JSON with recursively sorted object keys) so the two notions of "same call"
// can never drift apart.
//
// Invalidation is deliberately conservative and therefore sound: ANY successful
// mutator (write/edit/bash) clears ALL recorded read fingerprints, because a
// mutation may have changed what any subsequent re-read would return. We do not
// try to scope invalidation to the touched path — over-invalidating only costs
// a re-read (correct), whereas under-invalidating could serve stale context.

import { fingerprint } from '@tachi/core'

// Exactly the side-effect-free tools whose output is a pure function of the
// (unchanged) workspace. Mutators (write/edit/bash) are intentionally absent:
// bash may print non-deterministic output and any of the three changes state.
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob'])

/** Stable, key-order-independent fingerprint of a tool call (re-exported core). */
export function dedupFingerprint(tool: string, args: Record<string, unknown>): string {
  return fingerprint(tool, args)
}

/**
 * Tracks fingerprints of read-only tool calls executed within a single run.
 * Construct one per run (per-run isolation: two DedupSets never share state).
 */
export class DedupSet {
  // Fingerprints of read-only calls whose output is still valid (no mutation
  // since they ran). A Set mirrors the agentic-rag retrieval_keys set; we clear
  // it wholesale on any mutation rather than union-accumulate forever.
  private readonly fps = new Set<string>()

  /** True iff `tool` is one of the side-effect-free, dedup-eligible tools. */
  static isReadOnly(tool: string): boolean {
    return READ_ONLY_TOOLS.has(tool)
  }

  /**
   * Has this exact read-only call already been executed (and not invalidated)
   * this run? Always false for non-read-only tools — mutators are never deduped.
   */
  seenBefore(tool: string, args: Record<string, unknown>): boolean {
    if (!DedupSet.isReadOnly(tool)) return false
    return this.fps.has(dedupFingerprint(tool, args))
  }

  /**
   * Record that a read-only call ran (so a later identical call short-circuits).
   * A no-op for non-read-only tools — only read results are reusable. Call this
   * AFTER a successful execution.
   */
  record(tool: string, args: Record<string, unknown>): void {
    if (!DedupSet.isReadOnly(tool)) return
    this.fps.add(dedupFingerprint(tool, args))
  }

  /**
   * Invalidate every recorded read fingerprint. Call after a SUCCESSFUL mutator
   * (write/edit/bash) — the conservative, sound rule (see file header).
   */
  invalidateAfterMutation(): void {
    this.fps.clear()
  }

  /**
   * Update the set after a tool finished executing (the gate has already
   * passed and the tool ran). This is the single bookkeeping call the loop
   * makes; `ok` is whether the tool returned a non-error result.
   *
   *   - read-only tool: recorded ONLY when ok (a failed read has no reusable
   *     output to point back to);
   *   - mutator (write/edit/bash): invalidates ALL recorded reads regardless
   *     of `ok`. A mutator that reached execution may have changed the
   *     workspace even if it then errored (a script that writes a file then
   *     exits non-zero, a partial write that throws), so a later identical
   *     read must re-run rather than reuse stale output. Under-invalidation
   *     would serve stale context; over-invalidation only costs a re-read.
   */
  afterExecute(tool: string, args: Record<string, unknown>, ok: boolean): void {
    if (DedupSet.isReadOnly(tool)) {
      if (ok) this.record(tool, args)
    } else {
      this.invalidateAfterMutation()
    }
  }
}
