import { ipcMain } from 'electron'
import { safeStorage } from 'electron'
import { z } from 'zod'

export function registerSafeStorageIpc() {
  ipcMain.handle('safe-storage:is-available', () => {
    return { available: safeStorage.isEncryptionAvailable() }
  })

  ipcMain.handle('safe-storage:encrypt', (_event, payload: unknown) => {
    const { plaintext } = z.object({ plaintext: z.string() }).parse(payload)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption not available on this system')
    }
    const encrypted = safeStorage.encryptString(plaintext)
    return { encrypted: encrypted.toString('base64') }
  })

  ipcMain.handle('safe-storage:decrypt', (_event, payload: unknown) => {
    const { encrypted } = z.object({ encrypted: z.string() }).parse(payload)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption not available on this system')
    }
    const buf = Buffer.from(encrypted, 'base64')
    const plaintext = safeStorage.decryptString(buf)
    return { plaintext }
  })
}
