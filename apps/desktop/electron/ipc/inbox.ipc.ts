// apps/desktop/electron/ipc/inbox.ipc.ts
//
// PRIVATE MODE (Tier 4) — main-process IPC bridge for the capability inbox.
//
// Routes:
//   inbox:set-mode    — renderer → main. Mirrors useCapabilityStore.mode into
//                       the main-process capabilityService so the agent gate
//                       (in agent.ipc.ts) knows which path to take for the
//                       next tool-permission decision.
//   inbox:get-mode    — renderer → main. Diagnostic read of the current mode.
//   inbox:list        — renderer → main. Snapshot of currently-pending
//                       requests; used by InboxView on mount to seed its view
//                       in case the user toggled mode mid-flight and missed
//                       the initial push event.
//   inbox:approve     — renderer → main. Resolve a pending request as 'allow'.
//   inbox:deny        — renderer → main. Resolve a pending request as 'deny'.
//   inbox:cancel      — renderer → main. Drop a pending request (resolves as
//                       'deny' under the hood — the agent treats it the same).
//
// Push events (main → all renderers):
//   inbox:push        — a new request entered the queue. Fired by the
//                       capabilityService 'push' listener.
//   inbox:resolve     — a previously-pending request was decided (by user or
//                       cancellation). Lets a second window stay in sync.
//
// Architecture: the renderer-side `useCapabilityStore` is the canonical
// queue for the user-facing inbox view. This file only handles the
// renderer↔main wiring; the main-process queue lives in
// `electron/services/capability-service.ts`.

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { capabilityService } from '../services/capability-service'
import type { CapabilityMode, CapabilityRequest } from '../services/capability-service'

function coerceMode(value: unknown): CapabilityMode {
  if (value === 'inbox') return 'inbox'
  if (value === 'immediate') return 'immediate'
  console.warn('[inbox] coerceMode: unexpected value, defaulting to immediate:', value)
  return 'immediate'
}

/**
 * Broadcast an inbox event to every open BrowserWindow.
 * Unlike privacy:set-mode we do NOT exclude the sender — the renderer's
 * capability.store is keyed off store calls (setMode/resolve), not off the
 * push channel, so the sender is unaffected by the echo. Multiple inbox
 * windows would each need the broadcast.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    w.webContents.send(channel, payload)
  }
}

let registered = false

export function registerInboxIpc(): void {
  if (registered) return
  registered = true

  // ── EventEmitter → IPC broadcast bridge ────────────────────────────────
  // Wire once at register-time. capabilityService is a singleton; if this is
  // ever called more than once (it shouldn't be — main.ts has one wire-up
  // site) we early-return above to avoid duplicate listeners stacking.
  capabilityService.on('push', (req: CapabilityRequest) => {
    broadcast('inbox:push', req)
  })
  capabilityService.on('resolve', (id: string, decision: 'allow' | 'deny') => {
    broadcast('inbox:resolve', { id, decision })
  })

  // ── Mode mirror ────────────────────────────────────────────────────────
  ipcMain.handle('inbox:set-mode', (_event, payload: unknown) => {
    const next = coerceMode((payload as { mode?: unknown } | null | undefined)?.mode)
    capabilityService.setMode(next)
    return { ok: true as const, mode: next }
  })

  ipcMain.handle('inbox:get-mode', () => {
    return { mode: capabilityService.getMode() }
  })

  // ── Queue snapshot ─────────────────────────────────────────────────────
  // Returns the requests currently pending in the main-process queue.
  // The renderer store is the source of truth for the user-facing list, but
  // on a cold reload (or a window re-attaching to the running main process)
  // this lets the view show in-flight requests without waiting for a fresh
  // push event.
  ipcMain.handle('inbox:list', () => {
    return { requests: capabilityService.listPending() }
  })

  // ── Decisions ──────────────────────────────────────────────────────────
  ipcMain.handle('inbox:approve', (_event, payload: unknown) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(payload)
    capabilityService.deliverDecision(id, 'allow')
    return { ok: true as const }
  })

  ipcMain.handle('inbox:deny', (_event, payload: unknown) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(payload)
    capabilityService.deliverDecision(id, 'deny')
    return { ok: true as const }
  })

  // Used by the inbox UI's "dismiss without decision" affordance and by the
  // agent shutdown path. cancelPending resolves as 'deny' on the agent side
  // (so the harness unblocks) — semantically the same as deny.
  ipcMain.handle('inbox:cancel', (_event, payload: unknown) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(payload)
    capabilityService.cancelPending(id)
    return { ok: true as const }
  })
}
