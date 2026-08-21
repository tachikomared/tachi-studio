// apps/desktop/src/pages/agent/sendGate.ts
//
// ONE rule for "can this composer send right now, and does it need a session
// first" — used by BOTH the send-button's disabled state and the send handler.
//
// THE BUG THIS EXISTS FOR (pre-existing, reproduced live 2026-07-25): the two
// gates were written separately and both required a live `sessionId`. The
// history rail's "+ NEW" archives the transcript and clears `sessionId` while
// KEEPING `workingDir` — so after one click the composer went permanently
// inert: the button was disabled, the handler returned early, and the only way
// back was re-picking the very same folder in the native dialog.
//
// A workspace the operator already chose is enough to run in. The harness
// session is spawned ON DEMAND ('start-then-send'), exactly like the folder
// picker does it — same harness, same gateway, same model.
//
// Deliberately NOT part of this decision: the composer text (the button also
// requires non-empty input) and the running state (the button becomes STOP
// while a run is in flight). Those are about the message, not about the route.

export type SendGate =
  /** A live session is ready — send straight into it. */
  | 'send'
  /** No session, but a workspace: spawn one, then send. */
  | 'start-then-send'
  /** Nothing sendable — the composer stays disabled. */
  | 'blocked'

export function sendGate(input: {
  /** The OTHER surface's run owns the live session (batch14). */
  surfaceBlocked:   boolean
  /** Browsing history read-only. */
  viewingArchive:   boolean
  /** A saved Nodes graph is bound to this tab — it runs without a session. */
  workflowMode:     boolean
  /** Parallel tiles own their own session lifecycle; never lazily started here. */
  parallelGridMode: boolean
  /** Live session for the current routing target (tile in grid mode). */
  sessionId:        string | null
  /** Workspace for the current routing target. */
  workingDir:       string | null
}): SendGate {
  // A foreign run holds the live session: sending would land in THEIR session,
  // THEIR workspace, with THEIR transcript replayed as history.
  if (input.surfaceBlocked) return 'blocked'
  // Archives are read-only by definition.
  if (input.viewingArchive) return 'blocked'
  // Workflow mode compiles + runs the bound graph — no harness session at all.
  if (input.workflowMode) return 'send'
  if (input.sessionId) return 'send'
  // "+ NEW" left a workspace behind: that is a session waiting to be spawned,
  // not a dead end.
  if (!input.parallelGridMode && input.workingDir) return 'start-then-send'
  return 'blocked'
}
