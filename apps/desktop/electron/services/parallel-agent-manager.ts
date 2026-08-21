// apps/desktop/electron/services/parallel-agent-manager.ts
//
// Central registry of parallel coding tasks. Each task owns:
//   - a git worktree directory (created via worktree-service)
//   - a synthetic sessionId routed through agent.ipc.ts so reuses Tachi's
//     existing harness invocation surface
//   - an AbortController per-task so aborting one doesn't kill the others
//   - an optional steps-watcher handle for live `.claude/steps.json` updates
//
// The store is in-memory: parallel tasks survive across renderer reloads
// (because main keeps the map alive) but not across full app restarts.
// That's intentional — worktrees on disk are recoverable manually, and we
// don't want stale "running" tasks at boot.
//
// Renderer mirrors come through the IPC layer (electron/ipc/parallel-agents.ipc.ts);
// see also apps/desktop/src/store/parallel-agents.store.ts.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  createWorktree,
  removeWorktree,
  shortId,
  slugifyBranchName,
} from './worktree-service'
import {
  startStepsWatcher,
  type StepEntry,
  type StepsWatcher,
} from './steps-watcher'
import {
  spawnPty,
  defaultShell,
  type PtyHandle,
  type PtyOutputMessage,
} from './pty-service'

export type ParallelTaskStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export interface ParallelTask {
  id:           string
  name:         string
  branchName:   string
  /** Absolute path to the worktree. Used as workingDir for agent:send. */
  worktreePath: string
  /** Synthetic Tachi session id, routed through agent.ipc.ts. */
  sessionId:    string
  /** Convenience: same value as worktreePath; kept distinct for clarity in callers. */
  workingDir:   string
  status:       ParallelTaskStatus
  /** AbortController bound to the in-flight harness invocation, if any. */
  abort:        AbortController | null
  createdAt:    number
  /** Optional latest model/harness label for UI display. */
  lastLine?:    string
  /** Whether we hold a steps watcher for this task. */
  hasWatcher:   boolean
}

/** Snapshot — what we broadcast to the renderer (no AbortController). */
export interface ParallelTaskSnapshot {
  id:           string
  name:         string
  branchName:   string
  worktreePath: string
  sessionId:    string
  workingDir:   string
  status:       ParallelTaskStatus
  createdAt:    number
  lastLine?:    string
}

export interface CreateTaskOpts {
  name:          string
  projectRoot:   string
  baseBranch?:   string
  /** Default: ['node_modules', '.env']. */
  symlinkDirs?:  string[]
  /** Default: 'task'. Resulting branch is `<prefix>/<slug>-<id6>`. */
  branchPrefix?: string
}

export interface DeleteTaskOpts {
  taskId:       string
  deleteBranch: boolean
}

function toSnapshot(t: ParallelTask): ParallelTaskSnapshot {
  return {
    id:           t.id,
    name:         t.name,
    branchName:   t.branchName,
    worktreePath: t.worktreePath,
    sessionId:    t.sessionId,
    workingDir:   t.workingDir,
    status:       t.status,
    createdAt:    t.createdAt,
    lastLine:     t.lastLine,
  }
}

export interface ParallelTaskCreateResult {
  task:     ParallelTaskSnapshot
  warnings: string[]
}

/**
 * PTY-data subscription record. We keep one subscription per renderer-side
 * <PtyTerminalView /> instance so multiple panes for the same task remain
 * independently unsubscribable. Each record owns:
 *   - the taskId the subscription is bound to
 *   - the IPC channel suffix (subId) used to push frames at the renderer
 *   - a `dispatch` callback (the IPC handler in parallel-agents.ipc.ts wires
 *     this to win.webContents.send)
 */
interface PtySubscription {
  subId:    string
  taskId:   string
  dispatch: (msg: PtyOutputMessage) => void
}

export class ParallelAgentManager {
  private readonly tasks  = new Map<string, ParallelTask>()
  private readonly watchers = new Map<string, StepsWatcher>()
  /** Stored project root per task — needed for cleanup (worktree removal). */
  private readonly projectRoots = new Map<string, string>()
  private readonly emitter = new EventEmitter()

  // ── PTY state ─────────────────────────────────────────────────────────────
  // Lazy by design: a PTY only spawns when the renderer first toggles a tile
  // to PTY display. Until then this map is empty for that task. We keep the
  // PTY alive across EVENTS↔PTY toggles so the user doesn't lose scrollback
  // when flipping back and forth; kill happens on task deletion.
  private readonly ptys = new Map<string, PtyHandle>()
  /** subId → subscription record. Multiple subs per task are allowed. */
  private readonly ptySubs = new Map<string, PtySubscription>()

  /**
   * Create a fresh task. Provisions a git worktree under
   * `<projectRoot>/.worktrees/<branchName>` and starts a steps watcher.
   *
   * Returns the new task snapshot plus any non-fatal warnings from worktree
   * creation (e.g. failed symlinks).
   */
  async createTask(opts: CreateTaskOpts): Promise<ParallelTaskCreateResult> {
    const id = randomUUID()
    const prefix     = (opts.branchPrefix ?? 'task').replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'task'
    const slug       = slugifyBranchName(opts.name)
    const branchName = `${prefix}/${slug}-${shortId()}`
    const symlinkDirs = opts.symlinkDirs ?? ['node_modules', '.env']

    const { worktreePath, warnings } = await createWorktree({
      projectRoot: opts.projectRoot,
      branchName,
      baseBranch:  opts.baseBranch,
      symlinkDirs,
    })

    // Synthesise a Tachi sessionId; the `parallel-` prefix lets agent.ipc.ts
    // resolve workingDir via this manager rather than the legacy single-task
    // path.
    const sessionId = `parallel-${id.slice(0, 8)}`

    const task: ParallelTask = {
      id,
      name:         opts.name,
      branchName,
      worktreePath,
      sessionId,
      workingDir:   worktreePath,
      status:       'idle',
      abort:        null,
      createdAt:    Date.now(),
      hasWatcher:   false,
    }

    this.tasks.set(id, task)
    this.projectRoots.set(id, opts.projectRoot)

    // Steps watcher: best-effort, errors are non-fatal (logged via emitter).
    try {
      const watcher = startStepsWatcher(worktreePath)
      watcher.on('step', (entry: StepEntry) => {
        this.emitter.emit('step', { taskId: id, entry })
      })
      watcher.on('steps', (entries: StepEntry[]) => {
        this.emitter.emit('steps', { taskId: id, entries })
      })
      watcher.on('error', (err: Error) => {
        this.emitter.emit('steps-error', { taskId: id, error: err.message })
      })
      this.watchers.set(id, watcher)
      task.hasWatcher = true
    } catch (err) {
      // Watching is a nice-to-have, not a blocker.
      this.emitter.emit('steps-error', {
        taskId: id,
        error: (err as Error).message ?? String(err),
      })
    }

    this.broadcast()
    return { task: toSnapshot(task), warnings }
  }

  /**
   * Tear down a task. Aborts any in-flight harness invocation, stops the
   * watcher, and removes the worktree. Optionally deletes the branch.
   */
  async deleteTask(opts: DeleteTaskOpts): Promise<{ ok: true; warnings: string[] }> {
    const t = this.tasks.get(opts.taskId)
    if (!t) return { ok: true, warnings: [`unknown taskId: ${opts.taskId}`] }

    if (t.abort) {
      try { t.abort.abort() } catch { /* ignore */ }
    }
    const watcher = this.watchers.get(opts.taskId)
    if (watcher) {
      try { watcher.stop() } catch { /* ignore */ }
      this.watchers.delete(opts.taskId)
    }
    // PTY: kill the per-task pseudo-terminal if one was spawned, and drop any
    // dangling subscription records for it. The renderer-side unsubscribe is
    // best-effort (renderers may have already unmounted); leftover entries
    // here would otherwise pile up across many create/delete cycles.
    const pty = this.ptys.get(opts.taskId)
    if (pty) {
      try { pty.kill() } catch { /* ignore */ }
      this.ptys.delete(opts.taskId)
    }
    for (const [subId, sub] of this.ptySubs) {
      if (sub.taskId === opts.taskId) this.ptySubs.delete(subId)
    }
    const projectRoot = this.projectRoots.get(opts.taskId)
    const warnings: string[] = []
    if (projectRoot) {
      const result = await removeWorktree({
        projectRoot,
        worktreePath: t.worktreePath,
        branchName:   opts.deleteBranch ? t.branchName : undefined,
      })
      warnings.push(...result.warnings)
    } else {
      warnings.push(`no projectRoot recorded for taskId ${opts.taskId} — worktree may be orphaned`)
    }

    this.tasks.delete(opts.taskId)
    this.projectRoots.delete(opts.taskId)
    this.broadcast()
    return { ok: true, warnings }
  }

  listTasks(): ParallelTask[] {
    return Array.from(this.tasks.values())
  }

  listSnapshots(): ParallelTaskSnapshot[] {
    return this.listTasks().map(toSnapshot)
  }

  getTask(taskId: string): ParallelTask | undefined {
    return this.tasks.get(taskId)
  }

  /** Look up by Tachi sessionId — used by agent.ipc.ts to resolve workingDir. */
  getTaskBySessionId(sessionId: string): ParallelTask | undefined {
    for (const t of this.tasks.values()) {
      if (t.sessionId === sessionId) return t
    }
    return undefined
  }

  setStatus(taskId: string, status: ParallelTaskStatus): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    if (t.status === status) return
    t.status = status
    this.broadcast()
  }

  setAbort(taskId: string, abort: AbortController | null): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.abort = abort
    // No broadcast — AbortController isn't part of the wire snapshot, but
    // we still want subscribers to see status changes if status flipped
    // separately via setStatus.
  }

  setLastLine(taskId: string, line: string): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.lastLine = line
    this.broadcast()
  }

  /**
   * Subscribe to task-list changes. Listener receives the full snapshot
   * array on every mutation. Returns an unsubscribe function.
   */
  onChange(listener: (tasks: ParallelTaskSnapshot[]) => void): () => void {
    const wrapped = () => listener(this.listSnapshots())
    this.emitter.on('change', wrapped)
    return () => this.emitter.off('change', wrapped)
  }

  /** Subscribe to per-step events. Returns an unsubscribe function. */
  onStep(listener: (payload: { taskId: string; entry: StepEntry }) => void): () => void {
    this.emitter.on('step', listener)
    return () => this.emitter.off('step', listener)
  }

  /** Subscribe to bulk-steps refresh events (rare; use onStep for live updates). */
  onSteps(listener: (payload: { taskId: string; entries: StepEntry[] }) => void): () => void {
    this.emitter.on('steps', listener)
    return () => this.emitter.off('steps', listener)
  }

  onStepsError(listener: (payload: { taskId: string; error: string }) => void): () => void {
    this.emitter.on('steps-error', listener)
    return () => this.emitter.off('steps-error', listener)
  }

  // ── PTY API ───────────────────────────────────────────────────────────────
  //
  // The renderer drives spawn/write/resize/kill via parallel-agents.ipc.ts.
  // Spawn is idempotent: calling it twice for the same task returns the
  // existing PTY (so a toggle from EVENTS→PTY→EVENTS→PTY doesn't restart
  // the shell). The shell binary is the system default
  // (pwsh.exe on Windows, $SHELL elsewhere) with cwd = worktreePath.

  /**
   * Ensure a PTY is running for this task. Returns false if the task is
   * unknown. The PTY's cwd is the task's worktreePath, which is the same
   * directory the agent operates in — so the user sees a shell rooted in
   * the worktree, ready to inspect/build/test in parallel with the agent.
   */
  spawnPtyForTask(taskId: string, cols?: number, rows?: number): boolean {
    const t = this.tasks.get(taskId)
    if (!t) return false
    const existing = this.ptys.get(taskId)
    if (existing && existing.isAlive()) {
      // Apply the requested viewport even if the PTY already exists — the
      // newly-mounted renderer pane likely has a different size than the
      // previous one.
      if (cols && rows) {
        try { existing.resize(cols, rows) } catch { /* ignore */ }
      }
      return true
    }
    const { command, args } = defaultShell()
    const handle = spawnPty({
      command,
      args,
      cwd:  t.worktreePath,
      cols: cols ?? 120,
      rows: rows ?? 30,
      onMessage: (msg) => {
        // Fan-out to every subscription bound to this taskId. We snapshot
        // the subs array before iterating because dispatchers can in theory
        // mutate ptySubs (e.g. on a destroyed-window guard that
        // unsubscribes).
        const targets: PtySubscription[] = []
        for (const sub of this.ptySubs.values()) {
          if (sub.taskId === taskId) targets.push(sub)
        }
        for (const sub of targets) {
          try { sub.dispatch(msg) } catch { /* ignore */ }
        }
        // On Exit, drop the handle so a future toggle re-spawns rather than
        // writing to a dead PTY.
        if (msg.type === 'Exit') {
          this.ptys.delete(taskId)
        }
      },
    })
    this.ptys.set(taskId, handle)
    return true
  }

  writePtyForTask(taskId: string, data: string): boolean {
    const pty = this.ptys.get(taskId)
    if (!pty || !pty.isAlive()) return false
    try {
      pty.write(data)
      return true
    } catch {
      return false
    }
  }

  resizePtyForTask(taskId: string, cols: number, rows: number): boolean {
    const pty = this.ptys.get(taskId)
    if (!pty || !pty.isAlive()) return false
    try {
      pty.resize(cols, rows)
      return true
    } catch {
      return false
    }
  }

  killPtyForTask(taskId: string): boolean {
    const pty = this.ptys.get(taskId)
    if (!pty) return false
    try { pty.kill() } catch { /* ignore */ }
    this.ptys.delete(taskId)
    return true
  }

  hasPtyForTask(taskId: string): boolean {
    const pty = this.ptys.get(taskId)
    return Boolean(pty && pty.isAlive())
  }

  /**
   * Register a renderer subscription for PTY frames. The dispatcher is
   * called for every base64-encoded data frame and the final Exit message.
   * Returns an unsubscribe function that drops the record from the map.
   *
   * Subscriptions don't own the PTY's lifecycle: the PTY stays alive even
   * when the last subscription drops (toggle-back-to-EVENTS shouldn't kill
   * the shell). Deletion happens explicitly via killPtyForTask or task
   * deletion.
   */
  subscribePty(
    subId:    string,
    taskId:   string,
    dispatch: (msg: PtyOutputMessage) => void,
  ): () => void {
    this.ptySubs.set(subId, { subId, taskId, dispatch })
    return () => {
      this.ptySubs.delete(subId)
    }
  }

  unsubscribePty(subId: string): void {
    this.ptySubs.delete(subId)
  }

  private broadcast(): void {
    this.emitter.emit('change')
  }
}

// Singleton — agent.ipc.ts and parallel-agents.ipc.ts both reach for the
// same registry so per-task state is shared.
export const parallelAgents = new ParallelAgentManager()
