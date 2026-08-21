// Tests for the pure wallet transaction-log helpers (wallet-tx-log.ts).
//
// Audit 2026-06-12 (dimension 3 / HIGH): sendTransaction/sendToken/fundAgentWallet
// broadcast real funds and DISCARDED the tx hash — no record of hash/recipient/
// amount/token/chain/timestamp. These helpers back a persistent append-only
// journal so a transfer is reviewable after the fact.

import { describe, it, expect } from 'vitest'
import { serializeTxEntry, parseTxLog, type WalletTxEntry } from '../../electron/services/wallet-tx-log'

const entry = (over: Partial<WalletTxEntry> = {}): WalletTxEntry => ({
  ts: 1_700_000_000_000,
  kind: 'native',
  walletKind: 'app',
  chainId: 8453,
  symbol: 'ETH',
  to: '0xabc',
  amount: '0.01',
  hash: '0xdeadbeef',
  ...over,
})

describe('serializeTxEntry', () => {
  it('produces a single JSON line with no trailing newline that round-trips', () => {
    const line = serializeTxEntry(entry())
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual(entry())
  })
})

describe('parseTxLog', () => {
  it('parses newline-delimited entries, newest first', () => {
    const text = [
      serializeTxEntry(entry({ ts: 1, hash: '0x1' })),
      serializeTxEntry(entry({ ts: 2, hash: '0x2' })),
      serializeTxEntry(entry({ ts: 3, hash: '0x3' })),
    ].join('\n')
    const out = parseTxLog(text)
    expect(out.map(e => e.hash)).toEqual(['0x3', '0x2', '0x1'])
  })

  it('skips malformed lines without throwing', () => {
    const text = [
      serializeTxEntry(entry({ hash: '0x1' })),
      'this is not json',
      serializeTxEntry(entry({ hash: '0x2' })),
      '',
    ].join('\n')
    expect(parseTxLog(text).map(e => e.hash)).toEqual(['0x2', '0x1'])
  })

  it('applies a limit to the most-recent entries', () => {
    const text = Array.from({ length: 5 }, (_, i) => serializeTxEntry(entry({ ts: i, hash: `0x${i}` }))).join('\n')
    expect(parseTxLog(text, 2).map(e => e.hash)).toEqual(['0x4', '0x3'])
  })

  it('returns [] for empty input', () => {
    expect(parseTxLog('')).toEqual([])
    expect(parseTxLog('   \n  \n')).toEqual([])
  })
})
