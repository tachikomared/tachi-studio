// apps/desktop/src/pages/agent/promptQueue.ts
//
// Pure reducer for the FOLLOW-UP PROMPT QUEUE (plan A1a).
//
// WHY: until now `sendTask` hard-returned while a run was in flight
// (`if (!hasContent || isRunning) return`) — typing during a run was a silent
// no-op, so the operator had to sit and watch, remember their next instruction,
// and retype it when the run ended. Every comparable tool (Cline, Claude Code,
// Cursor) lets you keep typing.
//
// Scope of THIS module: the queue only. Draining is the page's job (it owns
// attachments / provider / harness / history), and mid-run STEER — injecting a
// message into a round that is already running — is deliberately NOT here: v1
// drains at the natural seam, a run's terminal `done`.
//
// Sibling of `permissionQueue.ts` and written to the same discipline: pure
// functions, no store import, no React — so the ordering/cap/isolation rules are
// unit-testable without rendering AgentPage.

/** How many follow-ups may wait. Small on purpose: a queue you cannot hold in
 *  your head is a queue that surprises you when it fires. */
export const PROMPT_QUEUE_CAP = 5

/**
 * Which surface a queued prompt belongs to. The two AgentPage routes share ONE
 * live session slot but are two different conversations — a follow-up typed on
 * TACHIAPP must never drain into a CODE run (that is the same class of bleed
 * `surfaceBindDecision` exists to prevent).
 */
export type PromptSurface = 'code' | 'tachiapp'

/** A queued follow-up. `at` is only for the chip tooltip / ordering sanity. */
export interface QueuedPrompt {
  id:   string
  text: string
  at:   number
}

/** Store key for a surface tag (`sessionTag`-shaped: null = the Code tab). */
export function promptSurfaceKey(tag: 'tachiapp' | null | undefined): PromptSurface {
  return tag === 'tachiapp' ? 'tachiapp' : 'code'
}

/** Composer text → queueable text. Empty (or whitespace) is not queueable. */
export function normalizePromptText(text: string | null | undefined): string {
  return typeof text === 'string' ? text.trim() : ''
}

export function promptQueueFull(
  queue: readonly QueuedPrompt[],
  cap: number = PROMPT_QUEUE_CAP,
): boolean {
  return queue.length >= cap
}

/**
 * Append a prompt. Rejected — SAME array instance back, so React skips the
 * re-render and the caller can detect the rejection by identity — when the text
 * is empty or the cap is reached. A cap that silently drops the OLDEST entry
 * would lose an instruction the operator believes is queued; refusing is honest.
 */
export function enqueuePrompt(
  queue: readonly QueuedPrompt[],
  prompt: QueuedPrompt,
  cap: number = PROMPT_QUEUE_CAP,
): QueuedPrompt[] {
  if (!prompt || typeof prompt.id !== 'string' || prompt.id === '') return queue as QueuedPrompt[]
  if (normalizePromptText(prompt.text) === '') return queue as QueuedPrompt[]
  if (promptQueueFull(queue, cap)) return queue as QueuedPrompt[]
  if (queue.some(q => q.id === prompt.id)) return queue as QueuedPrompt[]
  return [...queue, { ...prompt, text: normalizePromptText(prompt.text) }]
}

/**
 * Take the OLDEST prompt (FIFO — the operator typed them in the order they
 * want them run). Returns the taken prompt plus the remaining queue; `next` is
 * null for an empty queue and `rest` is then the same array instance.
 */
export function dequeuePrompt(
  queue: readonly QueuedPrompt[],
): { next: QueuedPrompt | null; rest: QueuedPrompt[] } {
  if (queue.length === 0) return { next: null, rest: queue as QueuedPrompt[] }
  return { next: queue[0], rest: queue.slice(1) }
}

/** Drop one prompt the operator removed from the chip row. */
export function removePrompt(
  queue: readonly QueuedPrompt[],
  id: string,
): QueuedPrompt[] {
  if (!queue.some(q => q.id === id)) return queue as QueuedPrompt[]
  return queue.filter(q => q.id !== id)
}

// ── When may the queue auto-fire? ────────────────────────────────────────────
//
// The pause policy is the part that is easy to get wrong, so it is a pure
// function with the reasoning attached:
//
//   • `done` (including an ENDED-INCOMPLETE `done`) → DRAIN. A give-up is not a
//     reason to lose the operator's next instruction; it is the strongest reason
//     to have one queued.
//   • user pressed STOP → PAUSE. Stop means "I want to intervene"; auto-firing
//     the queue is the exact opposite of intervening. (STOP leaves the status at
//     'idle', and the page also latches `queuePaused`.)
//   • `error` → PAUSE. A dead session would swallow n prompts into n more
//     errors.
//   • viewing an archive → never (the composer is read-only there).
//   • the other surface owns the live session (`surfaceBlocked`) → never: the
//     send would land in THEIR session with THEIR history.
//   • workflow mode → never: the composer runs a saved graph, not a harness turn.
export interface PromptDrainInput {
  /** agent.store status of the LIVE session. */
  status:         'idle' | 'starting' | 'running' | 'done' | 'error'
  queueLength:    number
  /** Latched by STOP / an error — cleared by the operator's RESUME. */
  paused:         boolean
  viewingArchive: boolean
  surfaceBlocked: boolean
  workflowMode:   boolean
  /** True while a previous drain's send is still being dispatched. */
  draining:       boolean
  /** False when the composer could not send anyway (no workspace at all). */
  canSend:        boolean
}

/** Should the page auto-send the oldest queued prompt right now? */
export function shouldDrainPrompt(input: PromptDrainInput): boolean {
  if (input.queueLength <= 0) return false
  if (input.draining) return false
  if (input.paused) return false
  if (input.viewingArchive) return false
  if (input.surfaceBlocked) return false
  if (input.workflowMode) return false
  if (!input.canSend) return false
  // ONLY a terminal `done`. 'idle' covers both "never ran" and "user pressed
  // STOP", and telling those apart from status alone is impossible — so 'idle'
  // never drains and STOP can never be mistaken for a finished run.
  return input.status === 'done'
}
