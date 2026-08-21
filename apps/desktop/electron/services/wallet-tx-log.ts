// apps/desktop/electron/services/wallet-tx-log.ts
//
// Persistent append-only journal of real (broadcast) wallet transactions.
//
// WHY (audit 2026-06-12, dimension 3 / HIGH): sendTransaction/sendToken/
// fundAgentWallet broadcast funds and returned only { hash }, which the caller
// discarded — leaving NO record of what was sent, to whom, when. This module is
// the audit trail: every real send appends one JSONL line to
// ${userData}/wallet-tx.jsonl, readable via listWalletTx() / the wallet:listTx IPC.
//
// The serialize/parse helpers are PURE (no electron, no fs) and unit-tested; the
// record/list functions lazy-require electron+fs so the pure helpers import
// cleanly under vitest.

export interface WalletTxEntry {
  ts:         number            // epoch ms
  kind:       'native' | 'token'
  walletKind: 'app' | 'agent'
  walletName?: string           // for agent wallets
  chainId:    number
  symbol:     string            // 'ETH' / 'USDC' / token symbol
  to:         string            // recipient address
  amount:     string            // human-readable
  hash:       string            // tx hash
}

// ── Tamper-evident hash chain (STEAL 2026-06-12 cluster D; CloddsBot ledger) ──
// An unsigned JSONL journal can be silently rewritten by anything with FS
// access. Each entry is now sealed: entryHash = sha256(canonical(HASH_FIELDS)
// + prev), where prev is the previous entry's entryHash (GENESIS_PREV for the
// first). Editing any field, reordering, or deleting a middle entry breaks the
// chain, which verifyTxLog() detects and pinpoints. Legacy unsigned lines
// (written before this landed) are tolerated and counted, not failed.

export interface SealedWalletTxEntry extends WalletTxEntry {
  prev: string        // previous entry's entryHash, or GENESIS_PREV
  entryHash: string   // sha256 over HASH_FIELDS + prev
}

export const GENESIS_PREV = 'genesis'

/** Field whitelist included in the hash — deterministic order. */
const HASH_FIELDS = ['ts', 'kind', 'walletKind', 'walletName', 'chainId', 'symbol', 'to', 'amount', 'hash'] as const

function canonicalPayload(entry: WalletTxEntry, prev: string): string {
  const obj: Record<string, unknown> = {}
  for (const f of HASH_FIELDS) {
    const v = (entry as unknown as Record<string, unknown>)[f]
    if (v !== undefined) obj[f] = v
  }
  obj.prev = prev
  // HASH_FIELDS order is fixed, so JSON.stringify is deterministic here
  // regardless of the caller's key order.
  return JSON.stringify(obj)
}

function sha256Hex(s: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Seal an entry into the chain (pure given its inputs). */
export function sealTxEntry(entry: WalletTxEntry, prev: string): SealedWalletTxEntry {
  return { ...entry, prev, entryHash: sha256Hex(canonicalPayload(entry, prev)) }
}

export interface TxLogVerification {
  ok: boolean
  /** Count of chain-sealed entries checked. */
  sealed: number
  /** Count of legacy unsigned entries (tolerated). */
  unsigned: number
  /** 1-based line number of the first bad entry, when !ok. */
  firstBadLine?: number
  reason?: string
}

/** Walk a JSONL journal and verify every sealed entry + the chain linkage. */
export function verifyTxLog(text: string): TxLogVerification {
  let sealed = 0
  let unsigned = 0
  let expectedPrev: string | null = null // null until the first sealed entry
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] as string).trim()
    if (!t) continue
    let e: Partial<SealedWalletTxEntry>
    try { e = JSON.parse(t) as Partial<SealedWalletTxEntry> } catch {
      return { ok: false, sealed, unsigned, firstBadLine: i + 1, reason: 'malformed JSON line' }
    }
    if (typeof e.entryHash !== 'string' || typeof e.prev !== 'string') {
      unsigned++
      continue
    }
    const recomputed = sha256Hex(canonicalPayload(e as WalletTxEntry, e.prev))
    if (recomputed !== e.entryHash) {
      return { ok: false, sealed, unsigned, firstBadLine: i + 1, reason: 'entry hash mismatch (field tampered)' }
    }
    const expected = expectedPrev ?? GENESIS_PREV
    if (e.prev !== expected) {
      return { ok: false, sealed, unsigned, firstBadLine: i + 1, reason: 'broken chain link (entry removed or reordered)' }
    }
    expectedPrev = e.entryHash
    sealed++
  }
  return { ok: true, sealed, unsigned }
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** One JSONL line (no trailing newline). */
export function serializeTxEntry(entry: WalletTxEntry): string {
  return JSON.stringify(entry)
}

/**
 * Parse a JSONL log into entries, NEWEST FIRST, tolerating malformed/blank lines.
 * `limit` caps the number of most-recent entries returned.
 */
export function parseTxLog(text: string, limit = 200): WalletTxEntry[] {
  const out: WalletTxEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t) as WalletTxEntry
      if (e && typeof e === 'object' && typeof e.hash === 'string') out.push(e)
    } catch { /* skip malformed line */ }
  }
  out.reverse() // newest first
  return out.slice(0, Math.max(0, limit))
}

// ── Persistence (lazy electron + fs) ────────────────────────────────────────

function logPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  const { join } = require('node:path') as typeof import('node:path')
  return join(app.getPath('userData'), 'wallet-tx.jsonl')
}

/** In-memory chain tip (last sealed entryHash). null = not yet initialized. */
let chainTip: string | null = null

/** Find the last sealed entry's hash in an existing journal (or genesis). */
function initChainTip(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const p = logPath()
    if (!existsSync(p)) return GENESIS_PREV
    let tip = GENESIS_PREV
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as Partial<SealedWalletTxEntry>
        if (typeof e.entryHash === 'string') tip = e.entryHash
      } catch { /* legacy/garbage line — chain continues past it */ }
    }
    return tip
  } catch {
    return GENESIS_PREV
  }
}

/** Append one real transaction to the journal, SEALED into the hash chain.
 *  Best-effort: never throws into the send path (a logging failure must not
 *  mask a successful broadcast). */
export function recordWalletTx(entry: WalletTxEntry): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    if (chainTip === null) chainTip = initChainTip()
    const sealed = sealTxEntry(entry, chainTip)
    appendFileSync(logPath(), serializeTxEntry(sealed) + '\n', 'utf8')
    chainTip = sealed.entryHash
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[wallet-tx-log] failed to record tx:', e instanceof Error ? e.message : e)
  }
}

/** Verify the on-disk journal's hash chain (wallet:verify-tx-log IPC). */
export function verifyWalletTxLog(): TxLogVerification {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const p = logPath()
    if (!existsSync(p)) return { ok: true, sealed: 0, unsigned: 0 }
    return verifyTxLog(readFileSync(p, 'utf8'))
  } catch {
    return { ok: false, sealed: 0, unsigned: 0, reason: 'journal unreadable' }
  }
}

/** Read the journal, newest first, capped at `limit`. */
export function listWalletTx(limit = 200): WalletTxEntry[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const p = logPath()
    if (!existsSync(p)) return []
    return parseTxLog(readFileSync(p, 'utf8'), limit)
  } catch {
    return []
  }
}
