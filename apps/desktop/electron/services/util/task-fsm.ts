// apps/desktop/electron/services/util/task-fsm.ts
//
// Minimal Task FSM for sidecar generation/install jobs.
//
// Legal transitions (derived from VidBee packages/task-queue/src/fsm/index.ts,
// ported to TypeScript without the class hierarchy — we only need the status
// machine for sd.cpp / piper jobs):
//
//   queued ──────────────► running ──► processing ──► completed
//                            │                  │
//                            ▼                  ▼
//                          failed             failed
//
//   Any state → cancelled  (via cancel())
//
// Illegal transitions throw — this is the whole point: callers can't silently
// skip states and end up with a job that looks done when it isn't.

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

// A set of legal (from → to) transitions.
const LEGAL: ReadonlySet<string> = new Set([
  'queued→running',
  'running→processing',
  'running→completed',
  'running→failed',
  'processing→completed',
  'processing→failed',
  // cancelled from any non-terminal state
  'queued→cancelled',
  'running→cancelled',
  'processing→cancelled',
])

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled'])

export interface TaskFsmSnapshot {
  id:         string
  status:     TaskStatus
  prevStatus: TaskStatus | null
  attempt:    number
  enteredAt:  number   // ms since epoch of last transition
  error?:     string
}

export class TaskFSM {
  readonly id: string
  private _status: TaskStatus = 'queued'
  private _prev:   TaskStatus | null = null
  private _attempt = 0
  private _enteredAt: number = Date.now()
  private _error?: string

  constructor(id: string) {
    this.id = id
  }

  get status(): TaskStatus { return this._status }
  get attempt(): number    { return this._attempt }

  /** Transition to the next status, throwing on illegal moves. */
  transition(to: TaskStatus, error?: string): void {
    const key = `${this._status}→${to}`
    if (!LEGAL.has(key)) {
      throw new Error(`[TaskFSM] Illegal transition ${key} for task "${this.id}"`)
    }
    this._prev      = this._status
    this._status    = to
    this._enteredAt = Date.now()
    this._error     = error
    if (to === 'running') this._attempt++
  }

  /**
   * Cancel the task if it is not already in a terminal state.
   * No-op (not a throw) when already terminal — safe to call unconditionally
   * in finally blocks.
   */
  cancel(): void {
    if (!TERMINAL.has(this._status)) {
      this._prev      = this._status
      this._status    = 'cancelled'
      this._enteredAt = Date.now()
    }
  }

  /** True when the task has reached a terminal state. */
  get isTerminal(): boolean { return TERMINAL.has(this._status) }

  /** Serialisable snapshot — safe to send over IPC. */
  snapshot(): TaskFsmSnapshot {
    return {
      id:         this.id,
      status:     this._status,
      prevStatus: this._prev,
      attempt:    this._attempt,
      enteredAt:  this._enteredAt,
      error:      this._error,
    }
  }
}

/**
 * Convenience: run `fn` inside a TaskFSM lifecycle
 * (queued → running → processing → completed | failed).
 * Returns the result and the settled FSM.
 *
 * The caller receives intermediate FSM transitions via `onTransition`
 * which is called synchronously after each state change.
 */
export async function runWithFSM<T>(
  id: string,
  fn: (fsm: TaskFSM) => Promise<T>,
  onTransition?: (snap: TaskFsmSnapshot) => void,
): Promise<{ result: T; fsm: TaskFSM }> {
  const fsm = new TaskFSM(id)
  const notify = (): void => { onTransition?.(fsm.snapshot()) }

  fsm.transition('running'); notify()

  try {
    const result = await fn(fsm)
    if (!fsm.isTerminal) { fsm.transition('completed'); notify() }
    return { result, fsm }
  } catch (err) {
    if (!fsm.isTerminal) {
      fsm.transition('failed', err instanceof Error ? err.message : String(err)); notify()
    }
    throw err
  }
}
