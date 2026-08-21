// apps/desktop/src/store/parallel-agents.store.ts
//
// Renderer-side mirror of the main-process ParallelAgentManager. Listens for
// `parallel:event` pushes and re-derives the tile-grid state. The store
// itself is *not* persisted across restarts — worktrees on disk are the
// durable record; on app boot we hydrate from `window.tachi.parallel.list()`.
//
// Why not persist? Two reasons:
//   1. Worktrees are recoverable manually (`git worktree list`). The user's
//      uncommitted edits inside one survive even if our metadata is gone.
//   2. Persisting "running" status across restarts is misleading — when the
//      app quit, the spawned processes died with it. Idle/done is the only
//      truthful state at boot.

import { create } from 'zustand'
import type {
  ParallelTaskSnapshot,
  ParallelTaskStatus,
  ParallelEvent,
  ParallelStepEntry,
  ParallelCreateTaskInput,
  ParallelCreateTaskResult,
  ParallelDeleteTaskResult,
} from '../types/electron'

/**
 * Per-tile display selection. `events` keeps the legacy behaviour (last
 * lines + steps.json). `pty` mounts a PTY pane attached to the task's
 * worktree. The default is 'events' (no behavioural change unless the
 * user toggles).
 */
export type ParallelTileDisplayMode = 'events' | 'pty'

interface ParallelAgentsStore {
  // ── Tasks ──────────────────────────────────────────────────────────────────
  tasks:      Map<string, ParallelTaskSnapshot>
  /** Ordered by createdAt asc; rebuilt on every change. */
  taskOrder:  string[]
  /** Per-task last-N step entries from the .claude/steps.json watcher. */
  steps:      Map<string, ParallelStepEntry[]>
  /** Currently focused tile (selection for InputBar routing). */
  focusedTaskId: string | null
  /** Last creation warnings (transient — cleared on the next createTask call). */
  lastWarnings:  string[]
  /** Whether the store has done its initial bootstrap. */
  bootstrapped: boolean
  /**
   * Per-task display mode for the tile body. Missing entries default to
   * 'events' — we don't pre-populate on bootstrap so the map stays small
   * for users who never touch the PTY toggle.
   */
  displayMode: Map<string, ParallelTileDisplayMode>

  // ── Actions ────────────────────────────────────────────────────────────────
  applyEvent(event: ParallelEvent): void
  bootstrap(): Promise<void>
  createTask(input: ParallelCreateTaskInput): Promise<ParallelCreateTaskResult>
  deleteTask(taskId: string, deleteBranch?: boolean): Promise<ParallelDeleteTaskResult>
  focusTask(taskId: string | null): void
  setStatus(taskId: string, status: ParallelTaskStatus): Promise<void>
  setDisplayMode(taskId: string, mode: ParallelTileDisplayMode): void
}

const MAX_STEPS_PER_TASK = 200

function recomputeOrder(tasks: Map<string, ParallelTaskSnapshot>): string[] {
  return Array.from(tasks.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(t => t.id)
}

export const useParallelAgentsStore = create<ParallelAgentsStore>((set, get) => ({
  tasks:         new Map(),
  taskOrder:     [],
  steps:         new Map(),
  focusedTaskId: null,
  lastWarnings:  [],
  bootstrapped:  false,
  displayMode:   new Map(),

  applyEvent(event: ParallelEvent): void {
    const state = get()
    if (event.kind === 'list') {
      const tasks = new Map<string, ParallelTaskSnapshot>()
      for (const t of event.tasks) tasks.set(t.id, t)
      const taskOrder = recomputeOrder(tasks)
      // Drop steps for removed tasks; preserve for kept ones.
      const steps = new Map<string, ParallelStepEntry[]>()
      for (const id of tasks.keys()) {
        const prev = state.steps.get(id)
        if (prev) steps.set(id, prev)
      }
      // Same for displayMode — only keep entries for still-extant tasks.
      const displayMode = new Map<string, ParallelTileDisplayMode>()
      for (const id of tasks.keys()) {
        const prev = state.displayMode.get(id)
        if (prev) displayMode.set(id, prev)
      }
      // Reset focusedTaskId if it points to a now-removed task.
      const focusedTaskId = state.focusedTaskId && tasks.has(state.focusedTaskId)
        ? state.focusedTaskId
        : (taskOrder[0] ?? null)
      set({ tasks, taskOrder, steps, focusedTaskId, displayMode, bootstrapped: true })
      return
    }
    if (event.kind === 'step') {
      const steps = new Map(state.steps)
      const prev = steps.get(event.taskId) ?? []
      const next = [...prev, event.entry]
      if (next.length > MAX_STEPS_PER_TASK) next.splice(0, next.length - MAX_STEPS_PER_TASK)
      steps.set(event.taskId, next)
      set({ steps })
      return
    }
    if (event.kind === 'steps') {
      const steps = new Map(state.steps)
      // The bulk refresh contains the full current array — trust it.
      const truncated = event.entries.length > MAX_STEPS_PER_TASK
        ? event.entries.slice(-MAX_STEPS_PER_TASK)
        : event.entries
      steps.set(event.taskId, truncated)
      set({ steps })
      return
    }
    if (event.kind === 'steps-error') {
      // Surface via console — UI shows the step list as-is. A future tile
      // could expose a "watcher error" badge but for now we don't escalate.
      console.warn(`[parallel] steps watcher error for task ${event.taskId}:`, event.error)
      return
    }
  },

  async bootstrap(): Promise<void> {
    try {
      const { tasks } = await window.tachi.parallel.list()
      const taskMap = new Map<string, ParallelTaskSnapshot>()
      for (const t of tasks) taskMap.set(t.id, t)
      const taskOrder = recomputeOrder(taskMap)
      set({
        tasks: taskMap,
        taskOrder,
        focusedTaskId: taskOrder[0] ?? null,
        bootstrapped: true,
      })
    } catch (err) {
      console.warn('[parallel] bootstrap failed:', err)
      set({ bootstrapped: true })  // mark bootstrapped anyway so UI doesn't hang on a spinner
    }
  },

  async createTask(input: ParallelCreateTaskInput): Promise<ParallelCreateTaskResult> {
    const result = await window.tachi.parallel.createTask(input)
    if (result.ok) {
      // Optimistic add — the push event will arrive shortly and rewrite this,
      // but inserting now avoids a flicker between dialog dismiss and event.
      const state = get()
      const tasks = new Map(state.tasks)
      tasks.set(result.task.id, result.task)
      set({
        tasks,
        taskOrder:     recomputeOrder(tasks),
        focusedTaskId: result.task.id,
        lastWarnings:  result.warnings,
      })
    } else {
      set({ lastWarnings: [] })
    }
    return result
  },

  async deleteTask(taskId: string, deleteBranch: boolean = true): Promise<ParallelDeleteTaskResult> {
    const result = await window.tachi.parallel.deleteTask(taskId, deleteBranch)
    // Optimistic removal regardless of outcome — main will rebroadcast the
    // canonical state shortly after.
    const state = get()
    const tasks = new Map(state.tasks)
    tasks.delete(taskId)
    const taskOrder = recomputeOrder(tasks)
    const steps = new Map(state.steps)
    steps.delete(taskId)
    const displayMode = new Map(state.displayMode)
    displayMode.delete(taskId)
    set({
      tasks,
      taskOrder,
      steps,
      displayMode,
      focusedTaskId: state.focusedTaskId === taskId ? (taskOrder[0] ?? null) : state.focusedTaskId,
    })
    return result
  },

  focusTask(taskId: string | null): void {
    set({ focusedTaskId: taskId })
  },

  async setStatus(taskId: string, status: ParallelTaskStatus): Promise<void> {
    await window.tachi.parallel.setStatus(taskId, status)
    // Push event will update the store on the round-trip.
  },

  setDisplayMode(taskId: string, mode: ParallelTileDisplayMode): void {
    const state = get()
    // No-op when already matching — avoids spurious re-renders of every
    // tile when the same mode is set twice in a row.
    if ((state.displayMode.get(taskId) ?? 'events') === mode) return
    const displayMode = new Map(state.displayMode)
    if (mode === 'events') {
      // Default mode — drop the entry to keep the map sparse.
      displayMode.delete(taskId)
    } else {
      displayMode.set(taskId, mode)
    }
    set({ displayMode })
  },
}))
