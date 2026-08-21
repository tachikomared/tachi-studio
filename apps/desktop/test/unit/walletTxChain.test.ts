// apps/desktop/test/unit/walletTxChain.test.ts
//
// SHA-256 tamper-evident hash chain for the wallet tx journal
// (STEAL 2026-06-12 cluster D; CloddsBot src/ledger hash pattern).
// Before this, wallet-tx.jsonl was unsigned JSONL — any process with FS
// access could silently rewrite history. Each sealed entry now carries
// entryHash = sha256(canonical(HASH_FIELDS) + prev), chaining to the
// previous entry; verifyTxLog walks the chain and pinpoints tampering.

import { describe, it, expect } from 'vitest'
import {
  sealTxEntry, verifyTxLog, serializeTxEntry, parseTxLog,
  GENESIS_PREV, type WalletTxEntry,
} from '../../electron/services/wallet-tx-log'

function entry(over: Partial<WalletTxEntry> = {}): WalletTxEntry {
  return {
    ts: 1718200000000, kind: 'native', walletKind: 'app',
    chainId: 8453, symbol: 'ETH', to: '0xabc', amount: '0.05', hash: '0xdeadbeef',
    ...over,
  }
}

describe('sealTxEntry', () => {
  it('produces a stable 64-hex entryHash and echoes prev', () => {
    const s1 = sealTxEntry(entry(), GENESIS_PREV)
    const s2 = sealTxEntry(entry(), GENESIS_PREV)
    expect(s1.entryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(s1.entryHash).toBe(s2.entryHash) // deterministic
    expect(s1.prev).toBe(GENESIS_PREV)
  })

  it('changes the hash when any sealed field changes', () => {
    const base = sealTxEntry(entry(), GENESIS_PREV)
    expect(sealTxEntry(entry({ amount: '0.06' }), GENESIS_PREV).entryHash).not.toBe(base.entryHash)
    expect(sealTxEntry(entry({ to: '0xevil' }), GENESIS_PREV).entryHash).not.toBe(base.entryHash)
    expect(sealTxEntry(entry(), 'f'.repeat(64)).entryHash).not.toBe(base.entryHash)
  })

  it('is insensitive to key order of the input object', () => {
    const shuffled = JSON.parse('{"hash":"0xdeadbeef","amount":"0.05","to":"0xabc","symbol":"ETH","chainId":8453,"walletKind":"app","kind":"native","ts":1718200000000}') as WalletTxEntry
    expect(sealTxEntry(shuffled, GENESIS_PREV).entryHash).toBe(sealTxEntry(entry(), GENESIS_PREV).entryHash)
  })
})

describe('verifyTxLog', () => {
  function chainLines(): string[] {
    const a = sealTxEntry(entry({ hash: '0xaaa' }), GENESIS_PREV)
    const b = sealTxEntry(entry({ hash: '0xbbb', amount: '1.0' }), a.entryHash)
    const c = sealTxEntry(entry({ hash: '0xccc', kind: 'token', symbol: 'USDC' }), b.entryHash)
    return [a, b, c].map(e => serializeTxEntry(e))
  }

  it('accepts an intact chain', () => {
    const v = verifyTxLog(chainLines().join('\n') + '\n')
    expect(v.ok).toBe(true)
    expect(v.sealed).toBe(3)
    expect(v.unsigned).toBe(0)
  })

  it('detects a tampered field (hash mismatch) and names the line', () => {
    const lines = chainLines()
    lines[1] = lines[1]!.replace('"amount":"1.0"', '"amount":"999"')
    const v = verifyTxLog(lines.join('\n'))
    expect(v.ok).toBe(false)
    expect(v.firstBadLine).toBe(2) // 1-based
    expect(v.reason).toMatch(/hash mismatch/i)
  })

  it('detects a broken chain link (deleted middle entry)', () => {
    const lines = chainLines()
    lines.splice(1, 1) // remove B -> C.prev no longer matches A.entryHash
    const v = verifyTxLog(lines.join('\n'))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/chain/i)
  })

  it('tolerates legacy unsigned lines before the chain started', () => {
    const legacy = JSON.stringify(entry({ hash: '0xold' }))
    const v = verifyTxLog([legacy, ...chainLines()].join('\n'))
    expect(v.ok).toBe(true)
    expect(v.unsigned).toBe(1)
    expect(v.sealed).toBe(3)
  })

  it('handles an empty / blank log', () => {
    expect(verifyTxLog('').ok).toBe(true)
    expect(verifyTxLog('\n\n').sealed).toBe(0)
  })
})

describe('back-compat', () => {
  it('parseTxLog still reads sealed entries (newest first)', () => {
    const a = sealTxEntry(entry({ hash: '0xaaa' }), GENESIS_PREV)
    const b = sealTxEntry(entry({ hash: '0xbbb' }), a.entryHash)
    const parsed = parseTxLog([a, b].map(e => serializeTxEntry(e)).join('\n'))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.hash).toBe('0xbbb')
  })
})
