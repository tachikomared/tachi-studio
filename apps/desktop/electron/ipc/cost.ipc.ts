// apps/desktop/electron/ipc/cost.ipc.ts
//
// Read-only observability IPC: the cost ledger (STEAL 2026-06-12 cluster A) +
// the per-task run log (STEAL 2026-06-21 #2), both for the Observability tab.

import { ipcMain } from 'electron'
import { getCostLedger } from '../services/cost-ledger'
import { getRunLog } from '../services/run-log'
import { loadSettings } from '../services/settings-store'

export function registerCostIpc(): void {
  ipcMain.handle('cost:summary', async () => {
    const summary = getCostLedger().summary(30)
    return { ...summary, budgetUsd: loadSettings().llmBudgetUsd30d ?? 0 }
  })
  ipcMain.handle('cost:recent-runs', async (_e, n: unknown) => {
    const limit = typeof n === 'number' && n > 0 ? Math.min(200, Math.floor(n)) : 20
    return getRunLog().recent(limit)
  })
}
