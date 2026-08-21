// apps/desktop/electron/ipc/parallel-agents.ipc.ts
//
// IPC surface for the parallel-task manager. Renderer talks to this via
// `window.tachi.parallel.*` (see preload.ts). Channels:
//
//   parallel:list             → ParallelTaskSnapshot[]
//   parallel:create-task      → ParallelTaskCreateResult
//   parallel:delete-task      → { ok, warnings }
//   parallel:set-status       → ack
//   parallel:set-last-line    → ack
//   parallel:event            (push channel — broadcast on every change)
//   parallel:step             (push channel — broadcast per appended steps.json entry)
//
//   parallel:pty-spawn        → ack { ok, hadExisting? }
//   parallel:pty-write        → ack { ok }
//   parallel:pty-resize       → ack { ok }
//   parallel:pty-kill         → ack { ok }
//   parallel:pty-subscribe    → ack { ok, subId }  (renderer keeps subId for unsubscribe)
//   parallel:pty-unsubscribe  → ack { ok }
//   parallel:pty-data:<subId> (push channel — base64-encoded data frames + final Exit)
//
// Design notes:
//   - The renderer's parallel-agents store mirrors `parallel:event` for
//     synchronous reads. It bootstraps from `parallel:list` once on mount.
//   - We piggy-back on the existing agent.ipc.ts `agent:send` handler for
//     the actual harness invocation. That handler reads workingDir from
//     this manager when the sessionId starts with `parallel-`.
//   - No router-style typed bridge yet — channels stay on `ipcMain.handle`
//     for parity with the rest of agent.ipc.ts (which is the same style).
//   - PTY is LAZY: only spawned when the renderer calls pty-spawn (i.e. a
//     tile toggles to PTY display). The PTY survives EVENTS↔PTY toggles so
//     scrollback isn't lost; it's killed only on task deletion or explicit
//     pty-kill.

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parallelAgents } from '../services/parallel-agent-manager'

const CreateTaskInput = z.object({
  name:         z.string().min(1).max(120),
  projectRoot:  z.string().min(1),
  baseBranch:   z.string().min(1).optional(),
  symlinkDirs:  z.array(z.string().min(1)).max(20).optional(),
  branchPrefix: z.string().min(1).max(32).optional(),
})

const DeleteTaskInput = z.object({
  taskId:       z.string().min(1),
  deleteBranch: z.boolean().optional().default(true),
})

const SetStatusInput = z.object({
  taskId: z.string().min(1),
  status: z.enum(['idle', 'running', 'done', 'error', 'aborted']),
})

const SetLastLineInput = z.object({
  taskId: z.string().min(1),
  line:   z.string().max(512),
})

// ── PTY input schemas ────────────────────────────────────────────────────────

const PtySpawnInput = z.object({
  taskId: z.string().min(1),
  cols:   z.number().int().min(1).max(1000).optional(),
  rows:   z.number().int().min(1).max(1000).optional(),
})

const PtyWriteInput = z.object({
  taskId: z.string().min(1),
  // Allow empty string (e.g. plain newline keypresses still arrive as
  // one-char strings; the empty case is harmless).
  data:   z.string().max(64 * 1024),
})

const PtyResizeInput = z.object({
  taskId: z.string().min(1),
  cols:   z.number().int().min(1).max(1000),
  rows:   z.number().int().min(1).max(1000),
})

const PtyKillInput = z.object({
  taskId: z.string().min(1),
})

const PtySubscribeInput = z.object({
  taskId: z.string().min(1),
})

const PtyUnsubscribeInput = z.object({
  subId: z.string().min(1),
})

export function registerParallelAgentsIpc(win: BrowserWindow): void {
  /**
   * Push the current snapshot list to the renderer. Guards against destroyed
   * windows so we don't crash mid-shutdown.
   */
  function pushList(): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('parallel:event', {
      kind:  'list',
      tasks: parallelAgents.listSnapshots(),
    })
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  //
  // We attach these once at registration time. They live for the lifetime
  // of the BrowserWindow; on app teardown the contextWindow guards will
  // simply no-op the pushes. (No need to manually unsubscribe — the
  // singleton manager outlives the window only at quit time.)
  parallelAgents.onChange(() => pushList())

  parallelAgents.onStep(({ taskId, entry }) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('parallel:event', { kind: 'step', taskId, entry })
  })

  parallelAgents.onSteps(({ taskId, entries }) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('parallel:event', { kind: 'steps', taskId, entries })
  })

  parallelAgents.onStepsError(({ taskId, error }) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('parallel:event', { kind: 'steps-error', taskId, error })
  })

  // ── Handlers ──────────────────────────────────────────────────────────────

  ipcMain.handle('parallel:list', () => {
    return { tasks: parallelAgents.listSnapshots() }
  })

  ipcMain.handle('parallel:create-task', async (_event, payload: unknown) => {
    const input = CreateTaskInput.parse(payload)
    try {
      const result = await parallelAgents.createTask(input)
      return { ok: true as const, task: result.task, warnings: result.warnings }
    } catch (err) {
      return {
        ok:    false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle('parallel:delete-task', async (_event, payload: unknown) => {
    const input = DeleteTaskInput.parse(payload)
    try {
      const result = await parallelAgents.deleteTask({
        taskId:       input.taskId,
        deleteBranch: input.deleteBranch,
      })
      return { ok: true as const, warnings: result.warnings }
    } catch (err) {
      return {
        ok:    false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle('parallel:set-status', (_event, payload: unknown) => {
    const input = SetStatusInput.parse(payload)
    parallelAgents.setStatus(input.taskId, input.status)
    return { ok: true as const }
  })

  ipcMain.handle('parallel:set-last-line', (_event, payload: unknown) => {
    const input = SetLastLineInput.parse(payload)
    parallelAgents.setLastLine(input.taskId, input.line)
    return { ok: true as const }
  })

  // ── PTY handlers ─────────────────────────────────────────────────────────
  //
  // The renderer holds subscription ids; we keep an in-process map of
  // unsubscribe fns keyed by the same id so pty-unsubscribe can tear down
  // both the manager-side record and the in-flight dispatcher closure.
  const subUnsubscribers = new Map<string, () => void>()

  ipcMain.handle('parallel:pty-spawn', (_event, payload: unknown) => {
    const input = PtySpawnInput.parse(payload)
    const hadExisting = parallelAgents.hasPtyForTask(input.taskId)
    const ok = parallelAgents.spawnPtyForTask(input.taskId, input.cols, input.rows)
    if (!ok) {
      return { ok: false as const, error: `unknown taskId: ${input.taskId}` }
    }
    return { ok: true as const, hadExisting }
  })

  ipcMain.handle('parallel:pty-write', (_event, payload: unknown) => {
    const input = PtyWriteInput.parse(payload)
    const ok = parallelAgents.writePtyForTask(input.taskId, input.data)
    return { ok }
  })

  ipcMain.handle('parallel:pty-resize', (_event, payload: unknown) => {
    const input = PtyResizeInput.parse(payload)
    const ok = parallelAgents.resizePtyForTask(input.taskId, input.cols, input.rows)
    return { ok }
  })

  ipcMain.handle('parallel:pty-kill', (_event, payload: unknown) => {
    const input = PtyKillInput.parse(payload)
    const ok = parallelAgents.killPtyForTask(input.taskId)
    return { ok }
  })

  ipcMain.handle('parallel:pty-subscribe', (_event, payload: unknown) => {
    const input = PtySubscribeInput.parse(payload)
    const subId = `pty-${randomUUID().slice(0, 12)}`
    const channel = `parallel:pty-data:${subId}`
    // Subscribe to the manager — the manager invokes our dispatcher with
    // every frame. We guard against destroyed-window mid-flight to avoid
    // throwing during app teardown / window reload.
    const unsubscribe = parallelAgents.subscribePty(subId, input.taskId, (msg) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(channel, msg)
    })
    subUnsubscribers.set(subId, unsubscribe)
    return { ok: true as const, subId }
  })

  ipcMain.handle('parallel:pty-unsubscribe', (_event, payload: unknown) => {
    const input = PtyUnsubscribeInput.parse(payload)
    const unsub = subUnsubscribers.get(input.subId)
    if (unsub) {
      try { unsub() } catch { /* ignore */ }
      subUnsubscribers.delete(input.subId)
    } else {
      // Defensive: ensure the manager side is clean even if our local map
      // somehow lost the entry (shouldn't happen, but cheap insurance).
      parallelAgents.unsubscribePty(input.subId)
    }
    return { ok: true as const }
  })
}
