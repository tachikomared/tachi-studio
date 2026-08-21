// packages/core/src/chains.test.ts
import { describe, it, expect } from 'vitest'
import { CHAINS, getChain, chainTokens } from './chains'
import { getAddress } from 'ethers'

describe('chain registry', () => {
  it('includes the five darksol-operational EVM chains', () => {
    expect(CHAINS.map(c => c.key).sort()).toEqual(
      ['arbitrum', 'base', 'ethereum', 'optimism', 'polygon'],
    )
  })

  it('looks up by numeric id and by key', () => {
    expect(getChain(8453)?.key).toBe('base')
    expect(getChain('base')?.id).toBe(8453)
    expect(getChain(999999)).toBeUndefined()
  })

  it('every token address is a valid checksummed EVM address', () => {
    for (const c of CHAINS) {
      for (const t of chainTokens(c.id)) {
        // throws if not a valid address; assert it round-trips to checksum form
        expect(getAddress(t.address)).toBe(t.address)
      }
    }
  })

  it('native symbol is ETH on rollups and POL on Polygon', () => {
    expect(getChain('base')?.nativeSymbol).toBe('ETH')
    expect(getChain('polygon')?.nativeSymbol).toBe('POL')
  })
})
