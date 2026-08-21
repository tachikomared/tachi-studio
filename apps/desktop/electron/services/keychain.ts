import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { emitKeyChange } from './key-events'

// LAZY on purpose. Read at import time this captured userData before
// portable-mode could redirect it, so a portable install would have written its
// keys back into the user profile it exists to avoid — and it would have done so
// silently. A function cannot be captured too early.
const keysFile = (): string => join(app.getPath('userData'), 'tachi-keys.enc.json')

type KeyStore = Record<string, string>

function loadKeyStore(): KeyStore {
  if (!existsSync(keysFile())) return {}
  try { return JSON.parse(readFileSync(keysFile(), 'utf8')) } catch { return {} }
}

function saveKeyStore(store: KeyStore): void {
  writeFileSync(keysFile() + '.tmp', JSON.stringify(store), 'utf8')
  renameSync(keysFile() + '.tmp', keysFile())
}

export function storeKey(providerId: string, plaintext: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this system')
  }
  const encrypted = safeStorage.encryptString(plaintext)
  const store = loadKeyStore()
  store[providerId] = encrypted.toString('hex')
  saveKeyStore(store)
  emitKeyChange(providerId) // propagate rotation to live sidecars (audit 2026-06-12)
}

export function retrieveKey(providerId: string): string | null {
  const store = loadKeyStore()
  const hex = store[providerId]
  if (!hex) return null
  return safeStorage.decryptString(Buffer.from(hex, 'hex'))
}

export function deleteKey(providerId: string): void {
  const store = loadKeyStore()
  delete store[providerId]
  saveKeyStore(store)
  emitKeyChange(providerId) // revoke: drop the stale copy from live sidecars
}

export function hasKey(providerId: string): boolean {
  const store = loadKeyStore()
  return !!store[providerId]
}

export function listAllKeyIds(): string[] {
  const store = loadKeyStore()
  return Object.keys(store)
}

export function deleteAllKeys(): void {
  saveKeyStore({})
  emitKeyChange('*') // bulk revoke → tear down every key-holding sidecar
}

export function getStorageBackend(): string {
  if (process.platform === 'linux') {
    return (safeStorage as unknown as { getSelectedStorageBackend?(): string })
      .getSelectedStorageBackend?.() ?? 'unknown'
  }
  return 'os-native'
}
