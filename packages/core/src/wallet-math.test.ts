// packages/core/src/wallet-math.test.ts
import { describe, it, expect } from 'vitest'
import { trimAmount, aggregateBalances, type PerChainBalance } from './wallet-math'

describe('trimAmount', () => {
  it('caps fractional digits to 6 and strips trailing zeros', () => {
    expect(trimAmount('1.2300000000')).toBe('1.23')
    expect(trimAmount('0.000000123')).toBe('0')   // below 6dp → rounds away
    expect(trimAmount('5')).toBe('5')
  })
})

describe('aggregateBalances', () => {
  const rows: PerChainBalance[] = [
    { chainId: 8453,  symbol: 'ETH',  amount: '0.10' },
    { chainId: 42161, symbol: 'ETH',  amount: '0.42' },
    { chainId: 8453,  symbol: 'USDC', amount: '120' },
    { chainId: 137,   symbol: 'USDC', amount: '120' },
  ]
  it('sums each symbol across chains and records the per-chain breakdown', () => {
    const out = aggregateBalances(rows)
    const eth = out.find(t => t.symbol === 'ETH')!
    expect(eth.total).toBe('0.52')
    expect(eth.byChain).toEqual([
      { chainId: 8453, amount: '0.10' },
      { chainId: 42161, amount: '0.42' },
    ])
    const usdc = out.find(t => t.symbol === 'USDC')!
    expect(usdc.total).toBe('240')
  })
  it('orders native (ETH) first, then alphabetical', () => {
    expect(aggregateBalances(rows).map(t => t.symbol)).toEqual(['ETH', 'USDC'])
  })
})
