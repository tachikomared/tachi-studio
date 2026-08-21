// apps/desktop/electron/ipc/gnap.ipc.ts
//
// IPC routes for gnap (multi-agent coordination via git).
// Maps every public method of GnapClient to an ipcMain.handle channel and
// exposes a watch-start / watch-stop pair backed by an in-memory Map of
// unsubscribe fns. Each emitted watch event is forwarded to the renderer on
// a per-subscription channel (`gnap:event:<subscriptionId>`).
//
// Error envelope: read routes return their raw result (caller may catch
// rejections), write/mutating routes return an `{ ok, error?, ... }`
// envelope so a renderer call never tears down the IPC bridge on a
// transient git failure.
//
// A single GnapClient instance is created at module load and reused across
// every route — the client itself is stateless besides the in-memory
// watcher handles it manages internally.

import { ipcMain, BrowserWindow } from 'electron'
import {
  createGnapClient,
  type GnapAgent,
  type GnapMessage,
  type GnapRun,
  type GnapTask,
  type GnapTaskState,
} from '../services/gnap-client'

// ─── Shared client + watcher registry ────────────────────────────────────────

const client = createGnapClient()

/** subscriptionId → unsubscribe fn returned by client.watch(). */
const watchers = new Map<string, () => void>()

// ─── Error envelope helpers ──────────────────────────────────────────────────

type OkEnvelope<T extends object = Record<string, never>> = { ok: true } & T
type ErrEnvelope = { ok: false; error: string }

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function envelope<T extends object>(
  fn: () => Promise<T>,
): Promise<OkEnvelope<T> | ErrEnvelope> {
  try {
    const result = await fn()
    return { ok: true as const, ...result }
  } catch (err) {
    return { ok: false as const, error: errMsg(err) }
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerGnapIpc(win: BrowserWindow): void {
  // ── Swarm bootstrap ────────────────────────────────────────────────────────

  ipcMain.handle(
    'gnap:init-swarm',
    async (
      _event,
      payload: { repoPath: string; opts?: { protocolVersion?: string } },
    ) => {
      return envelope(async () => {
        await client.initSwarm(payload.repoPath, payload.opts)
        return {}
      })
    },
  )

  // ── Agents ─────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'gnap:list-agents',
    async (_event, payload: { repoPath: string }) => {
      try {
        const agents = await client.listAgents(payload.repoPath)
        return { ok: true as const, agents }
      } catch (err) {
        return { ok: false as const, error: errMsg(err), agents: [] as GnapAgent[] }
      }
    },
  )

  ipcMain.handle(
    'gnap:register-agent',
    async (_event, payload: { repoPath: string; agent: GnapAgent }) => {
      return envelope(async () => {
        await client.registerAgent(payload.repoPath, payload.agent)
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:update-agent-status',
    async (
      _event,
      payload: {
        repoPath: string
        agentId: string
        status: GnapAgent['status']
      },
    ) => {
      return envelope(async () => {
        await client.updateAgentStatus(
          payload.repoPath,
          payload.agentId,
          payload.status,
        )
        return {}
      })
    },
  )

  // ── Tasks ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'gnap:list-tasks',
    async (
      _event,
      payload: {
        repoPath: string
        filter?: { state?: GnapTaskState; assignedTo?: string }
      },
    ) => {
      try {
        const tasks = await client.listTasks(payload.repoPath, payload.filter)
        return { ok: true as const, tasks }
      } catch (err) {
        return { ok: false as const, error: errMsg(err), tasks: [] as GnapTask[] }
      }
    },
  )

  ipcMain.handle(
    'gnap:create-task',
    async (_event, payload: { repoPath: string; task: GnapTask }) => {
      return envelope(async () => {
        await client.createTask(payload.repoPath, payload.task)
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:update-task-state',
    async (
      _event,
      payload: {
        repoPath: string
        taskId: string
        state: GnapTaskState
        by: string
      },
    ) => {
      return envelope(async () => {
        await client.updateTaskState(
          payload.repoPath,
          payload.taskId,
          payload.state,
          payload.by,
        )
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:claim-task',
    async (
      _event,
      payload: {
        repoPath: string
        taskId: string
        agentId: string
        ttlSec?: number
      },
    ) => {
      try {
        // claimTask already returns { ok, reason? }; surface it directly so
        // callers can distinguish "claim taken by peer" from "IPC failure".
        const result = await client.claimTask(
          payload.repoPath,
          payload.taskId,
          payload.agentId,
          payload.ttlSec,
        )
        return result
      } catch (err) {
        return { ok: false as const, reason: errMsg(err) }
      }
    },
  )

  // Audit H1(a): claim a task AND run it end-to-end (worktree + harness + run
  // state). The board reflects progress via the run files (watch picks them up).
  ipcMain.handle(
    'gnap:claim-and-run',
    async (_event, payload: { repoPath: string; taskId: string; agentId: string; harness?: 'tachi' }) => {
      try {
        const { runSwarmTask } = await import('../services/swarm-executor')
        return await runSwarmTask({ repoPath: payload.repoPath, taskId: payload.taskId, agentId: payload.agentId, harness: payload.harness, win })
      } catch (err) {
        return { ok: false as const, reason: errMsg(err) }
      }
    },
  )

  // ── Runs ───────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'gnap:start-run',
    async (
      _event,
      payload: {
        repoPath: string
        run: Omit<GnapRun, 'commits' | 'artifacts'> & {
          commits?: string[]
          artifacts?: string[]
        }
      },
    ) => {
      return envelope(async () => {
        await client.startRun(payload.repoPath, payload.run)
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:complete-run',
    async (
      _event,
      payload: { repoPath: string; runId: string; patch: Partial<GnapRun> },
    ) => {
      return envelope(async () => {
        await client.completeRun(payload.repoPath, payload.runId, payload.patch)
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:list-runs',
    async (_event, payload: { repoPath: string; taskId?: string }) => {
      try {
        const runs = await client.listRuns(payload.repoPath, payload.taskId)
        return { ok: true as const, runs }
      } catch (err) {
        return { ok: false as const, error: errMsg(err), runs: [] as GnapRun[] }
      }
    },
  )

  // ── Messages ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    'gnap:post-message',
    async (_event, payload: { repoPath: string; msg: GnapMessage }) => {
      return envelope(async () => {
        await client.postMessage(payload.repoPath, payload.msg)
        return {}
      })
    },
  )

  ipcMain.handle(
    'gnap:list-messages',
    async (
      _event,
      payload: {
        repoPath: string
        filter?: { to?: string; unreadBy?: string }
      },
    ) => {
      try {
        const messages = await client.listMessages(payload.repoPath, payload.filter)
        return { ok: true as const, messages }
      } catch (err) {
        return {
          ok: false as const,
          error: errMsg(err),
          messages: [] as GnapMessage[],
        }
      }
    },
  )

  ipcMain.handle(
    'gnap:mark-read',
    async (
      _event,
      payload: { repoPath: string; msgId: string; agentId: string },
    ) => {
      return envelope(async () => {
        await client.markRead(payload.repoPath, payload.msgId, payload.agentId)
        return {}
      })
    },
  )

  // ── Watcher subscription ───────────────────────────────────────────────────
  //
  // The renderer calls `gnap:watch-start` with a stable subscriptionId it
  // generated; we store the unsubscribe fn keyed by that id and forward each
  // event on `gnap:event:<subscriptionId>`. The renderer is expected to call
  // `gnap:watch-stop` on cleanup. If the same id is registered twice we drop
  // the prior watcher first so callers don't accidentally double-subscribe.

  ipcMain.handle(
    'gnap:watch-start',
    async (
      _event,
      payload: { repoPath: string; subscriptionId: string },
    ) => {
      try {
        // Idempotent: replacing an existing subscription unsubscribes the
        // previous handle so we don't leak watchers when the renderer
        // reconnects with the same id (e.g. after a soft reload).
        const existing = watchers.get(payload.subscriptionId)
        if (existing) {
          try {
            existing()
          } catch {
            /* already torn down */
          }
          watchers.delete(payload.subscriptionId)
        }

        const channel = `gnap:event:${payload.subscriptionId}`
        const unsubscribe = client.watch(payload.repoPath, (info) => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(channel, info)
          }
        })
        watchers.set(payload.subscriptionId, unsubscribe)
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: errMsg(err) }
      }
    },
  )

  ipcMain.handle(
    'gnap:watch-stop',
    async (_event, payload: { subscriptionId: string }) => {
      const unsubscribe = watchers.get(payload.subscriptionId)
      if (!unsubscribe) return { ok: true as const, found: false }
      try {
        unsubscribe()
      } catch (err) {
        // Tearing down a watcher should never throw, but if it does we still
        // want the entry gone from the map.
        watchers.delete(payload.subscriptionId)
        return { ok: false as const, error: errMsg(err) }
      }
      watchers.delete(payload.subscriptionId)
      return { ok: true as const, found: true }
    },
  )
}
