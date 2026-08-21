// apps/desktop/electron/ipc/wallet-confirm.ipc.ts
//
// Wires wallet-service's real-broadcast confirmation gate (audit S6) to a
// renderer round-trip: on a real send/transfer the service awaits this handler,
// which asks the window to show a confirm modal and resolves with the answer.
// Fail-safe: if the window is gone or the user doesn't answer within the
// timeout, the transaction is REJECTED (never auto-approved).

import { ipcMain, type BrowserWindow } from 'electron'
import { setSendConfirmHandler, type SendConfirmSummary } from '../services/wallet-service'

const CONFIRM_TIMEOUT_MS = 120_000

export function registerWalletConfirm(win: BrowserWindow): void {
  const pending = new Map<number, (approved: boolean) => void>()
  let seq = 0

  ipcMain.on('wallet:confirm-response', (_e, payload: unknown) => {
    const { id, approved } = (payload as { id?: number; approved?: boolean } | null) ?? {}
    if (typeof id !== 'number') return
    const resolve = pending.get(id)
    if (resolve) { pending.delete(id); resolve(approved === true) }
  })

  setSendConfirmHandler((summary: SendConfirmSummary) => new Promise<boolean>((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) { resolve(false); return }
    const id = ++seq
    let settled = false
    const done = (v: boolean) => { if (!settled) { settled = true; pending.delete(id); resolve(v) } }
    pending.set(id, done)
    win.webContents.send('wallet:confirm-request', { id, summary })
    setTimeout(() => done(false), CONFIRM_TIMEOUT_MS)
  }))
}
