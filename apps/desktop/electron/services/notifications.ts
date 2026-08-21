// apps/desktop/electron/services/notifications.ts
//
// Thin wrapper around Electron's native Notification class.
// Only sends notifications when notificationsEnabled is true (default).

import { Notification } from 'electron'
import { loadSettings } from './settings-store'

export interface NotifyOpts {
  silent?: boolean
}

/**
 * Show a native desktop notification.
 * Respects the notificationsEnabled setting (default true).
 * No-op if the platform does not support notifications.
 */
export function notifyTaskDone(title: string, body: string, opts?: NotifyOpts): void {
  if (!Notification.isSupported()) return
  const settings = loadSettings()
  if (settings.notificationsEnabled === false) return
  const n = new Notification({
    title,
    body,
    silent: opts?.silent ?? false,
  })
  n.show()
}
