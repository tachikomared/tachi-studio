// apps/desktop/electron/services/util/token-store.ts
//
// Bearer-token persistence shared by the loopback servers the app EXPOSES
// (in-process MCP server, local OpenAI-compatible API server). Extracted from
// mcp-server.ts so the second server doesn't duplicate the safeStorage +
// plaintext-fallback dance.
//
// Preferred path: ${userData}/<baseName>.enc, encrypted via Electron
// safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux when a
// keyring is available). When safeStorage is unavailable — most commonly
// headless Linux without gnome-keyring / kwallet — fall back to a plaintext
// file at ${userData}/<baseName>.txt chmod 600. This keeps external clients
// from being forced to re-paste the token on every app restart on those
// systems. On macOS/Windows safeStorage is always available so the plaintext
// branch is effectively Linux-only.

import { app, safeStorage } from 'electron'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_RE = /^[0-9a-f-]{32,}$/i

function encFilePath(baseName: string): string {
  return join(app.getPath('userData'), `${baseName}.enc`)
}

function plaintextFilePath(baseName: string): string {
  return join(app.getPath('userData'), `${baseName}.txt`)
}

function persistToken(baseName: string, token: string): void {
  const fp = encFilePath(baseName)
  const plainFp = plaintextFilePath(baseName)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const enc = safeStorage.encryptString(token).toString('hex')
      writeFileSync(fp + '.tmp', enc, 'utf8')
      renameSync(fp + '.tmp', fp)
      return
    } catch { /* fall through to plaintext */ }
  }
  // Plaintext fallback (Linux without keyring). Write with restrictive perms.
  try {
    writeFileSync(plainFp + '.tmp', token, 'utf8')
    renameSync(plainFp + '.tmp', plainFp)
    try { chmodSync(plainFp, 0o600) } catch { /* Windows — no-op */ }
    console.warn(
      `[token-store] safeStorage unavailable — token persisted in plaintext at ${plainFp}. ` +
      'Install gnome-keyring / libsecret for encryption.',
    )
  } catch { /* persistence is best-effort; in-memory token still works */ }
}

/**
 * Load the persisted bearer token for `baseName`, or mint + persist a fresh
 * one. Encrypted file wins; plaintext fallback file is honoured (and silently
 * upgraded to encrypted on the next persist once a keyring appears).
 */
export function loadOrCreateToken(baseName: string): string {
  const fp = encFilePath(baseName)
  const plainFp = plaintextFilePath(baseName)

  // 1. Encrypted file first (preferred). Only meaningful if safeStorage works.
  if (existsSync(fp) && safeStorage.isEncryptionAvailable()) {
    try {
      const hex = readFileSync(fp, 'utf8')
      const plain = safeStorage.decryptString(Buffer.from(hex, 'hex'))
      if (TOKEN_RE.test(plain)) return plain
    } catch { /* fall through */ }
  }

  // 2. Plaintext fallback file. Used on Linux-without-keyring restarts.
  if (existsSync(plainFp)) {
    try {
      const plain = readFileSync(plainFp, 'utf8').trim()
      if (TOKEN_RE.test(plain)) return plain
    } catch { /* fall through and regenerate */ }
  }

  // 3. No usable persisted token — mint a fresh one and persist.
  const token = randomUUID()
  persistToken(baseName, token)
  return token
}

/** Blank both persisted forms and mint a fresh token. */
export function rotateToken(baseName: string): string {
  try { writeFileSync(encFilePath(baseName), '', 'utf8') } catch { /* ignore */ }
  try { writeFileSync(plaintextFilePath(baseName), '', 'utf8') } catch { /* ignore */ }
  return loadOrCreateToken(baseName)
}

// ── Secret RECORDS (many secrets under one baseName) ──────────────────────────
//
// The functions above hold ONE token per baseName, which is the right shape for
// a server-wide bearer. BATCH35's webhook triggers need a MAP (hookId → 32-byte
// secret) that survives a restart so an alert URL a user pasted into a third-
// party service keeps working. Same storage dance, JSON payload; a missing or
// unreadable file reads as "no secrets yet" rather than throwing, because losing
// them costs a re-copy, never data.

/** Read the persisted secret map for `baseName` ({} when absent/corrupt). */
export function loadSecretRecord(baseName: string): Record<string, string> {
  const parse = (raw: string): Record<string, string> => {
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }

  const fp = encFilePath(baseName)
  if (existsSync(fp) && safeStorage.isEncryptionAvailable()) {
    try {
      const hex = readFileSync(fp, 'utf8')
      if (hex.trim()) return parse(safeStorage.decryptString(Buffer.from(hex, 'hex')))
    } catch { /* fall through to the plaintext twin */ }
  }
  const plainFp = plaintextFilePath(baseName)
  if (existsSync(plainFp)) {
    try {
      const raw = readFileSync(plainFp, 'utf8').trim()
      if (raw) return parse(raw)
    } catch { /* unreadable — treat as empty */ }
  }
  return {}
}

/** Persist the secret map for `baseName` (encrypted when safeStorage works). */
export function saveSecretRecord(baseName: string, record: Record<string, string>): void {
  persistToken(baseName, JSON.stringify(record ?? {}))
}

/**
 * Constant-time bearer-token equality. Uses node's timingSafeEqual under the
 * hood with a length pre-check. JS `!==` short-circuits at first byte mismatch,
 * which leaks token length over time even on a localhost loopback (low real
 * risk but trivial to do correctly).
 */
export function safeCompareToken(supplied: string, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length === 0 || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}
