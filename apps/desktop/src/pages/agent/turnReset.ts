// apps/desktop/src/pages/agent/turnReset.ts
//
// PER-TURN FILE CHECKPOINTS — the pure half (A2, TOP-OSS #6).
//
// `electron/services/workspace-checkpoint.ts` is the hard half and it already
// works: a temp-index dangling commit (never touches the user's index/HEAD), an
// out-of-tree fs fallback for non-git roots with honest caps, a readback verify,
// and an automatic "before restore" snapshot returned as `safetyId`. What was
// missing was everything above it — nothing bound a snapshot to the USER TURN
// that caused it, and the only affordance was one global ↺ REVERT.
//
// This module owns the vocabulary (Cline's, deliberately: operators already
// know RESET CHAT / RESET CODE / RESET BOTH) and every decision that can be
// decided without React, IPC or the store:
//
//   • `stampTurnCheckpoint` — bind a snapshot to the last user turn.
//   • `resetAvailability`   — which of the three rows are live, and the HONEST
//                             reason when one is not (never a button that
//                             silently no-ops).
//   • `shouldSliceChat`     — the ordering rule that makes RESET BOTH safe: the
//                             code restore runs FIRST and a failure must NOT
//                             truncate the transcript, or the operator is left
//                             with mutated files and no record of what produced
//                             them.
//
// Everything here is a pure function over plain data so it is unit-testable
// without rendering AgentPage (this codebase has no DOM test harness).

/** The three-way choice on a past user turn. */
export type ResetChoice = 'chat' | 'code' | 'both'

/**
 * A workspace snapshot bound to ONE user turn.
 *
 * `cpId === null` is a first-class, honest state: main took no snapshot for
 * that turn (non-git root over the fs-backup caps, or the backup failed), and
 * `unavailable` carries the reason code so the UI can say WHY instead of
 * offering a dead button.
 */
export interface TurnCheckpoint {
  /** `AgentMessage.id` of the `user-text` turn this snapshot precedes. */
  messageId: string
  /** Workspace-checkpoint id, or null when no snapshot exists for this turn. */
  cpId:      string | null
  /** Workspace root the snapshot belongs to (restores are per-root). */
  root:      string
  label?:    string
  /** Reason code when `cpId` is null — rendered via i18n, never raw. */
  unavailable?: string
  createdAt: number
}

/**
 * Harnesses that take a per-turn workspace checkpoint today. ONLY tachi:
 * codex / openclaude / darksol write through their own processes and the
 * snapshot timing needs its own design call (see PLAN-AGENTS-NODES A2 — half
 * doing it would be worse than not offering the row).
 */
export const CHECKPOINTING_HARNESSES: readonly string[] = ['tachi']

/** Why RESET CODE is not offered. Each maps to one i18n string. */
export type CodeBlocker =
  | 'running'    // a run is in flight — restoring under it would race the writer
  | 'archive'    // browsing history, not the live session
  | 'harness'    // this harness takes no checkpoints
  | 'not-taken'  // no snapshot exists for this turn (see `codeDetail`)
  | 'aged-out'   // the snapshot fell out of the 50-entry per-root index

export type ChatBlocker = 'running' | 'archive'

export interface ResetAvailability {
  canResetChat: boolean
  canResetCode: boolean
  /** Null when the row is live. */
  chatBlocker:  ChatBlocker | null
  codeBlocker:  CodeBlocker | null
  /** Main's reason string when the snapshot could not be taken. */
  codeDetail?:  string
  /** The checkpoint to restore — null whenever `canResetCode` is false. */
  cpId:         string | null
  root:         string | null
}

export interface ResetContext {
  status:            string
  viewingArchiveId:  string | null
  harness:           string
  /** The user turn the menu was opened on. */
  messageId:         string
  turnCheckpoints:   readonly TurnCheckpoint[]
  /**
   * Ids from `listWorkspaceCheckpoints(root)`. `null` = not loaded yet, and we
   * deliberately do NOT claim 'aged-out' in that case — an unproven claim in
   * either direction is worse than waiting for the list.
   */
  liveCheckpointIds: readonly string[] | null
}

/** True while a run is mutating the tree (or about to). */
function isBusy(status: string): boolean {
  return status === 'running' || status === 'starting'
}

/**
 * Decide which rows of the RESET menu are live, and why the others are not.
 *
 * Precedence for code: a snapshot that EXISTS wins over the harness check —
 * `harness` is the currently selected harness, which may differ from the one
 * that ran this turn, and a real checkpoint id is ground truth.
 */
export function resetAvailability(ctx: ResetContext): ResetAvailability {
  const archive = !!ctx.viewingArchiveId
  const busy    = isBusy(ctx.status)

  const chatBlocker: ChatBlocker | null = archive ? 'archive' : busy ? 'running' : null

  const entry = ctx.turnCheckpoints.find(c => c.messageId === ctx.messageId) ?? null

  let codeBlocker: CodeBlocker | null
  if (archive)          codeBlocker = 'archive'
  else if (busy)        codeBlocker = 'running'
  else if (entry?.cpId) codeBlocker = ctx.liveCheckpointIds && !ctx.liveCheckpointIds.includes(entry.cpId) ? 'aged-out' : null
  else if (!CHECKPOINTING_HARNESSES.includes(ctx.harness)) codeBlocker = 'harness'
  else                  codeBlocker = 'not-taken'

  const canResetCode = codeBlocker === null
  return {
    canResetChat: chatBlocker === null,
    canResetCode,
    chatBlocker,
    codeBlocker,
    ...(entry?.unavailable ? { codeDetail: entry.unavailable } : {}),
    cpId: canResetCode ? entry?.cpId ?? null : null,
    root: entry?.root ?? null,
  }
}

/** Does this choice touch the workspace at all? */
export function shouldRestoreCode(choice: ResetChoice): boolean {
  return choice === 'code' || choice === 'both'
}

/**
 * THE ORDERING RULE. RESET BOTH restores code first; the transcript is only
 * truncated once that restore has actually succeeded.
 *
 * @param codeRestoreOk result of the restore — `null` when none was attempted.
 */
export function shouldSliceChat(choice: ResetChoice, codeRestoreOk: boolean | null): boolean {
  if (choice === 'chat') return true
  if (choice === 'code') return false
  return codeRestoreOk === true
}

/**
 * Bind a snapshot to the LAST user turn in the transcript.
 *
 * Main emits the `checkpoint` event immediately before it starts the run, i.e.
 * after the renderer has already appended the user turn — so "the last
 * `user-text` message" is exactly the turn this snapshot precedes.
 *
 * Returns the new list, or `null` when there is no user turn to bind to (the
 * caller then leaves state untouched rather than inventing an orphan entry).
 */
export function stampTurnCheckpoint(
  messages: readonly { id: string; event: { type?: string } }[],
  existing: readonly TurnCheckpoint[],
  cp: { id: string | null; root: string; label?: string; unavailable?: string; at?: number },
  cap = 50,
): TurnCheckpoint[] | null {
  let messageId = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].event?.type === 'user-text') { messageId = messages[i].id; break }
  }
  if (!messageId) return null

  const entry: TurnCheckpoint = {
    messageId,
    cpId: cp.id,
    root: cp.root,
    ...(cp.label ? { label: cp.label } : {}),
    ...(cp.unavailable ? { unavailable: cp.unavailable } : {}),
    createdAt: cp.at ?? Date.now(),
  }
  // Re-running the same turn replaces its binding — the OLD snapshot no longer
  // describes the state that turn started from.
  return [entry, ...existing.filter(c => c.messageId !== messageId)].slice(0, cap)
}

/**
 * Drop bindings whose turn is no longer in the transcript (after a chat slice).
 * A binding pointing at a message nobody can see is a restore nobody can reach.
 */
export function pruneTurnCheckpoints(
  list: readonly TurnCheckpoint[],
  liveMessageIds: ReadonlySet<string>,
): TurnCheckpoint[] {
  return list.filter(c => liveMessageIds.has(c.messageId))
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface TurnResetDeps {
  /** `window.tachi.checkpoints.restoreWorkspace` — injected so this is testable. */
  restore:   (root: string, cpId: string) => Promise<{ ok: boolean; error?: string; safetyId?: string }>
  /** Truncate the transcript at this turn (the store's `rewindTo`). */
  sliceChat: () => void
  /** The restore worked. `safetyId` powers the UNDO THIS RESET affordance. */
  onSuccess: (info: { choice: ResetChoice; safetyId?: string }) => void
  /** The restore failed — the caller MUST surface `error` to the operator. */
  onFailure: (error: string) => void
}

export interface TurnResetResult {
  /** null when this choice never touched the workspace. */
  codeRestored: boolean | null
  chatSliced:   boolean
  error?:       string
  safetyId?:    string
}

/** Sentinel error when the menu was somehow acted on without a snapshot. */
export const NO_CHECKPOINT = 'no-checkpoint'

/**
 * Run one three-way RESET. The whole point of this function existing separately
 * from AgentPage is that its two failure behaviours can be PROVEN:
 *
 *   1. A rejected or `{ ok:false }` restore is surfaced (`onFailure`) — never
 *      swallowed, never reported as success.
 *   2. On RESET BOTH a failed restore leaves the transcript ALONE, so the
 *      operator is never left with mutated files and no record of them.
 *
 * The caller owns confirmation (this function assumes the user already said
 * yes) and owns the toasts.
 */
export async function runTurnReset(
  choice: ResetChoice,
  target: { cpId: string | null; root: string | null },
  deps: TurnResetDeps,
): Promise<TurnResetResult> {
  if (!shouldRestoreCode(choice)) {
    const chatSliced = shouldSliceChat(choice, null)
    if (chatSliced) deps.sliceChat()
    return { codeRestored: null, chatSliced }
  }

  if (!target.cpId || !target.root) {
    // Unreachable through a correctly-disabled menu — but never pretend it
    // worked, and never truncate the transcript on the way out.
    deps.onFailure(NO_CHECKPOINT)
    return { codeRestored: false, chatSliced: false, error: NO_CHECKPOINT }
  }

  let ok = false
  let error = ''
  let safetyId: string | undefined
  try {
    const r = await deps.restore(target.root, target.cpId)
    ok       = !!r?.ok
    error    = r?.error ?? ''
    safetyId = r?.safetyId
  } catch (e) {
    ok    = false
    error = e instanceof Error ? e.message : String(e)
  }

  if (ok) deps.onSuccess({ choice, ...(safetyId ? { safetyId } : {}) })
  else    deps.onFailure(error || 'restore failed')

  const chatSliced = shouldSliceChat(choice, ok)
  if (chatSliced) deps.sliceChat()

  return {
    codeRestored: ok,
    chatSliced,
    ...(ok ? {} : { error: error || 'restore failed' }),
    ...(safetyId ? { safetyId } : {}),
  }
}
