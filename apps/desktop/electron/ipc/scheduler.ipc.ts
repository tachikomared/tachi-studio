// apps/desktop/electron/ipc/scheduler.ipc.ts
//
// IPC bridge for the local scheduler (USER-PAINS #9). Thin by design: every
// decision (validation, recurrence math, unattended gating, spend cap) lives in
// scheduler-core / scheduler-service — this file only marshals payloads and
// guarantees no handler ever throws across the bridge.
//
// Channels
//   scheduler:list        → { jobs }
//   scheduler:save        → { ok, job } | { ok:false, error }   (create or edit)
//   scheduler:delete      → { ok }
//   scheduler:set-enabled → { ok, job? }                        (pause / resume)
//   scheduler:run-now     → { ok, status?, detail?, error? }    (off-schedule)
// Push
//   scheduler:changed     ← { jobs }   after any mutation or finished run

import { ipcMain } from 'electron'
import {
  listJobs,
  saveJob,
  deleteJob,
  setJobEnabled,
  runJobNow,
  schedulerBusy,
} from '../services/scheduler-service'
import type { ScheduledJobInput } from '../services/scheduler-core'

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerSchedulerIpc(): void {
  ipcMain.handle('scheduler:list', () => {
    try {
      return { ok: true as const, jobs: listJobs(), busy: schedulerBusy() }
    } catch (err) {
      return { ...fail(err), jobs: [], busy: false }
    }
  })

  ipcMain.handle('scheduler:save', (_e, payload: unknown) => {
    try {
      if (payload === null || typeof payload !== 'object') return { ok: false as const, error: 'Invalid job.' }
      return saveJob(payload as ScheduledJobInput)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('scheduler:delete', (_e, payload: unknown) => {
    try {
      const id = (payload as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || !id) return { ok: false as const, error: 'Missing job id.' }
      return deleteJob(id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('scheduler:set-enabled', (_e, payload: unknown) => {
    try {
      const p = (payload ?? {}) as { id?: unknown; enabled?: unknown }
      if (typeof p.id !== 'string' || !p.id) return { ok: false as const, error: 'Missing job id.' }
      return setJobEnabled(p.id, p.enabled !== false)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('scheduler:run-now', async (_e, payload: unknown) => {
    try {
      const id = (payload as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || !id) return { ok: false as const, error: 'Missing job id.' }
      return await runJobNow(id)
    } catch (err) {
      return fail(err)
    }
  })
}
