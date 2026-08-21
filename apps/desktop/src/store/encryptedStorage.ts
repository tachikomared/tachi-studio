// Encrypted Zustand StateStorage adapter.
//
// Wraps localStorage with Electron's safeStorage (DPAPI on Windows, Keychain
// on macOS, libsecret on Linux). Each value is stored as:
//   { "v": 1, "e": "<base64 encrypted blob>" }
//
// Migration path: if the stored envelope is missing or has no "e" field (i.e.
// it's the old plain JSON blob written before this change), we return it as-is
// so Zustand can rehydrate existing data. On the next setItem the value will
// be silently rotated to the encrypted envelope format.
//
// Async: Zustand's StateStorage interface allows async (getItem / setItem /
// removeItem may return Promises). We always return Promises here because
// the IPC calls are inherently async.

import type { StateStorage } from 'zustand/middleware'

const MIGRATION_FLAG = 'tachi-encrypted-v1'

interface EncryptedEnvelope {
  v: 1
  e: string
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EncryptedEnvelope).v === 1 &&
    typeof (value as EncryptedEnvelope).e === 'string'
  )
}

// Lazily cache whether safeStorage is available so we don't pay an IPC round-
// trip on every getItem/setItem call after the first check.
let _available: boolean | null = null

async function isAvailable(): Promise<boolean> {
  if (_available !== null) return _available
  try {
    const result = await window.tachi.safeStorage.isAvailable()
    _available = result.available
  } catch {
    _available = false
  }
  return _available
}

/** DOMException 22 / code QuotaExceededError — the localStorage ~5-10MB cap. */
function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.code === 22)
}

// Warn the user ONCE per session — before this guard, hitting the quota
// silently dropped the newest state (data loss on next launch with zero signal).
let _quotaWarned = false

function trySetItem(storageKey: string, key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    if (isQuotaError(err)) {
      // Warn loudly but DON'T re-throw: zustand's persist calls setItem with no
      // .catch, so a throw here becomes an unhandledrejection on EVERY write
      // while the quota is full. The user is warned; the data is unpersistable
      // either way.
      console.error(`[encryptedStorage:${storageKey}] localStorage QUOTA EXCEEDED — newest state NOT persisted (key=${key}, ${value.length} chars)`)
      if (!_quotaWarned) {
        _quotaWarned = true
        window.dispatchEvent(new CustomEvent('tachi:toast', {
          detail: { kind: 'error', text: 'Local storage is full — recent changes may not be saved. Export or delete old conversations to free space.' },
        }))
      }
      return
    }
    throw err
  }
}

export function createEncryptedStorage(name: string): StateStorage {
  const storageKey = `tachi-${name}-v1`

  return {
    async getItem(key: string): Promise<string | null> {
      const raw = localStorage.getItem(key)
      if (raw === null) return null

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Unparseable — return as-is (shouldn't happen in practice, but be safe)
        return raw
      }

      if (isEncryptedEnvelope(parsed)) {
        // Try to decrypt. If decryption fails (e.g. migrated from another
        // machine), return null so the store resets to defaults rather than
        // crashing.
        try {
          const available = await isAvailable()
          if (!available) {
            console.warn(`[encryptedStorage:${storageKey}] safeStorage not available — returning raw`)
            return raw
          }
          const { plaintext } = await window.tachi.safeStorage.decrypt(parsed.e)
          return plaintext
        } catch (err) {
          console.warn(`[encryptedStorage:${storageKey}] decrypt failed, resetting store:`, err)
          return null
        }
      }

      // Not an encrypted envelope — old plaintext blob. Return the raw string
      // (Zustand passed it as JSON itself, so we need to give it the JSON string
      // back, not the parsed object). Actually, Zustand's persist middleware
      // expects `getItem` to return the JSON string it previously set. The raw
      // string from localStorage is that JSON string.
      return raw
    },

    async setItem(key: string, value: string): Promise<void> {
      const available = await isAvailable()
      if (!available) {
        console.warn(`[encryptedStorage:${storageKey}] safeStorage not available — storing plaintext`)
        trySetItem(storageKey, key, value)
        return
      }

      try {
        const { encrypted } = await window.tachi.safeStorage.encrypt(value)
        const envelope: EncryptedEnvelope = { v: 1, e: encrypted }
        trySetItem(storageKey, key, JSON.stringify(envelope))

        // Mark migration once on first successful encrypted write
        if (!localStorage.getItem(MIGRATION_FLAG)) {
          localStorage.setItem(MIGRATION_FLAG, '1')
        }
      } catch (err) {
        if (isQuotaError(err)) return      // already surfaced by trySetItem — don't retry plaintext
        console.warn(`[encryptedStorage:${storageKey}] encrypt failed — storing plaintext:`, err)
        trySetItem(storageKey, key, value)
      }
    },

    removeItem(key: string): void {
      localStorage.removeItem(key)
    },
  }
}
