// apps/desktop/src/pages/nodes/run-eligibility.ts
//
// Pure predicate for which node types EXECUTE during Run-all / per-node run.
// Extracted so the skip logic is a single, unit-testable source of truth.
//
// Everything NOT listed here — provider / folder / internet / mcp / skill /
// text / imageref / output / note / unknown — is config, a static source, an
// annotation (a sticky NOTE, NODES-RESEARCH #7), or a preserved-but-inert tile:
// resolved by reference, never "run", never priced, never part of a chain.

/**
 * Node types that actually run when the flow (or a single node) executes.
 *
 * `rife` is the odd one out and belongs here anyway: it calls no model and costs
 * no money, but it EXECUTES — it spawns ffmpeg and the GPU sidecar, takes
 * minutes, and produces an artifact the nodes after it consume. Leaving it out
 * would make Run-all walk straight past it and hand the next stage the
 * un-interpolated clip, silently.
 */
export const RUNNABLE_NODE_TYPES: ReadonlySet<string> = new Set(['prompt', 'agent', 'media', 'rife'])

/** True when a node of this `type` executes (i.e. is not skipped by Run-all). */
export function isRunnableType(type: string | undefined): boolean {
  return typeof type === 'string' && RUNNABLE_NODE_TYPES.has(type)
}
