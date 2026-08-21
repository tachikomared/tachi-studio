// apps/desktop/src/pages/nodes/canvas/errorBranch.ts
//
// NODES-RESEARCH #6 — PER-NODE ERROR BRANCH (n8n-style "Continue using error
// output"). This module is the PURE, side-effect-free core of the feature so it
// is unit-testable in isolation (test/unit/nodesErrorBranch.test.ts). No store
// access, no React, no IPC — just edges + upstream run outcomes → a decision.
//
// ────────────────────────────────────────────────────────────────────────────
// v1 SEMANTICS (exact — do not "improve" without updating the tests):
//
// Every runnable node (prompt / agent / media) exposes ONE extra ERROR source
// handle (id 'err'). An edge whose sourceHandle === 'err' is an ERROR-EDGE.
//
// A node's INCOMING edges are classified per (edge kind × upstream outcome):
//
//                       upstream SUCCESS   upstream ERROR    upstream SKIPPED   upstream STATIC*
//   normal edge         satisfied (output) —                —                  satisfied (its value)
//   error  edge (err)   —                  satisfied (error) —                  —
//
//   * STATIC = a source with NO tracked run outcome (Text / Provider / Folder /
//     Reference-Image / Output card / a not-yet-run node). These always feed a
//     NORMAL input, exactly as before this feature existed.
//   "satisfied" = the edge contributes a real input this run.
//
// DECISION:
//   • No incoming edges                → RUN (root/entry node).
//   • ≥1 satisfied incoming edge        → RUN. The node receives every satisfied
//     input; satisfied ERROR-edges additionally hand it the upstream ERROR TEXT
//     (returned as `errorInputs`, keyed by the failed upstream's node id).
//   • Incoming edges but NONE satisfied → SKIP, with a reason:
//       1. a NORMAL edge whose upstream FAILED  → 'upstream-failed'
//          ("skipped — upstream failed": the normal chain above it errored)
//       2. else an ERROR edge whose upstream SUCCEEDED → 'no-error'
//          ("skipped — no error to handle": it is an error handler, but the
//           node it guards did not fail)
//       3. else (skipped-upstream cascade / other) → 'upstream-failed'
//
// Consequences that fall out of the table (the three cases in the brief):
//   • On node SUCCESS: its error-edges carry NOTHING, so a target wired ONLY via
//     err-edges is skipped ('no-error').
//   • On node FAILURE: its NORMAL edges carry nothing, so those targets are
//     skipped ('upstream-failed'); its ERROR-edge targets RECEIVE the error text
//     and run normally.
//   • MIXED: a node with a satisfied normal input AND an err-edge runs; the
//     err-edge only injects text when its upstream actually failed.
//
// The Run-all loop (NodesPage.handleRunAll) tracks each runnable node's outcome
// and injects `errorInputs` by overriding the failed upstream node's transient
// `lastOutput` with the error text ONLY for that error-handler's run — the same
// lastOutput channel every downstream input already flows through.
// ────────────────────────────────────────────────────────────────────────────

/** The fixed id of the ERROR source handle rendered on every runnable node. */
export const ERR_HANDLE_ID = 'err'

/** Minimal structural edge shape the decision needs (kept xyflow-agnostic). */
export interface ErrBranchEdge {
  source: string
  target: string
  sourceHandle?: string | null
}

/** True iff `edge` originates from a node's ERROR output handle. */
export function isErrorEdge(edge: ErrBranchEdge): boolean {
  return edge.sourceHandle === ERR_HANDLE_ID
}

/**
 * The run outcome of an UPSTREAM node, as seen by a downstream node's decision.
 * A source with no outcome (undefined) is treated as a STATIC normal input.
 */
export type UpstreamOutcome =
  | { status: 'success' }
  | { status: 'error'; error?: string }
  | { status: 'skipped' }

/** Why a node was skipped — maps 1:1 to a user-facing i18n message. */
export type SkipReason = 'no-error' | 'upstream-failed'

export interface NodeRunDecision {
  /** Whether Run-all should execute this node at all. */
  run: boolean
  /** Present only when run === false. */
  skipReason?: SkipReason
  /**
   * Present only when run === true. Maps a FAILED upstream node id (reached via
   * a satisfied ERROR-edge) → the error text to feed this node as input. Empty
   * when the node runs on ordinary (non-error) inputs.
   */
  errorInputs: Record<string, string>
}

/**
 * Decide whether Run-all should execute `nodeId`, and — if so — what upstream
 * ERROR text (if any) to inject as its input. See the module header for the
 * exact truth table. Pure: depends only on the edge list and the caller-supplied
 * upstream-outcome lookup.
 *
 * @param nodeId      the node about to be considered by Run-all
 * @param edges       all edges on the canvas (only incoming ones are inspected)
 * @param outcomeOf   upstream node id → its recorded run outcome, or undefined
 *                    for a STATIC source (Text / Provider / not-yet-run / …)
 */
export function decideNodeRun(
  nodeId: string,
  edges: readonly ErrBranchEdge[],
  outcomeOf: (upstreamId: string) => UpstreamOutcome | undefined,
): NodeRunDecision {
  const incoming = edges.filter(e => e.target === nodeId)

  // A node with no dependencies is an entry point — always runs.
  if (incoming.length === 0) return { run: true, errorInputs: {} }

  let anySatisfied = false
  const errorInputs: Record<string, string> = {}
  // Signals for the skip-reason precedence when nothing is satisfied.
  let hasNormalFromFailed = false
  let hasErrFromSuccess = false

  for (const e of incoming) {
    const err = isErrorEdge(e)
    const outcome = outcomeOf(e.source)

    // STATIC source (Text / Provider / not-yet-run …): always a normal input,
    // never an error input.
    if (!outcome) {
      if (!err) anySatisfied = true
      continue
    }

    if (err) {
      if (outcome.status === 'error') {
        anySatisfied = true
        errorInputs[e.source] = outcome.error ?? ''
      } else if (outcome.status === 'success') {
        // The guarded node succeeded → this error handler has nothing to do.
        hasErrFromSuccess = true
      }
      // err-edge from a skipped upstream → contributes nothing, no signal.
    } else {
      if (outcome.status === 'success') anySatisfied = true
      else if (outcome.status === 'error') hasNormalFromFailed = true
      // normal edge from a skipped upstream → contributes nothing, no signal.
    }
  }

  if (anySatisfied) return { run: true, errorInputs }

  // Nothing satisfied → skip. Reason precedence (see module header).
  const skipReason: SkipReason = hasNormalFromFailed
    ? 'upstream-failed'
    : hasErrFromSuccess
      ? 'no-error'
      : 'upstream-failed'
  return { run: false, skipReason, errorInputs: {} }
}
