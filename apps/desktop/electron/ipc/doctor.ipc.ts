// apps/desktop/electron/ipc/doctor.ipc.ts
//
// App-wide sidecar health check (doctor-service): one IPC that executes every
// external binary with a probe arg and returns classified results for the
// Dashboard panel.

import { ipcMain } from 'electron'
import { runDoctor } from '../services/doctor-service'

export function registerDoctorIpc(): void {
  ipcMain.handle('doctor:run', async () => {
    try {
      return { ok: true, entries: await runDoctor() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
