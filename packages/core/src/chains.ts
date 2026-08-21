// packages/core/src/chains.ts
//
// EVM chain registry — the networks the darksol agent can operate on
// (Base, Ethereum, Polygon, Arbitrum, Optimism). Pure data + lookups; no I/O.
// Token addresses are the canonical mainnet contracts — verify against a block
// explorer before shipping (see chains.test.ts checksum guard).

export interface ChainTokenDef {
  symbol:   string
  address:  string   // checksummed ERC-20 contract on this chain
  decimals: number
}

export interface ChainDef {
  id:           number
  key:          string   // stable slug used in UI + storage
  name:         string
  rpc:          string   // public default RPC; user can override via addNetwork
  nativeSymbol: string
  explorer:     string
  color:        string   // hex for the UI network dot
  tokens:       ChainTokenDef[]
}

export const CHAINS: ChainDef[] = [
  {
    id: 8453, key: 'base', name: 'Base', rpc: 'https://mainnet.base.org',
    nativeSymbol: 'ETH', explorer: 'https://basescan.org', color: '#0052ff',
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
  },
  {
    id: 1, key: 'ethereum', name: 'Ethereum', rpc: 'https://eth.llamarpc.com',
    nativeSymbol: 'ETH', explorer: 'https://etherscan.io', color: '#627eea',
    tokens: [
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
  },
  {
    id: 137, key: 'polygon', name: 'Polygon', rpc: 'https://polygon-rpc.com',
    nativeSymbol: 'POL', explorer: 'https://polygonscan.com', color: '#8247e5',
    tokens: [
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    ],
  },
  {
    id: 42161, key: 'arbitrum', name: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc',
    nativeSymbol: 'ETH', explorer: 'https://arbiscan.io', color: '#28a0f0',
    tokens: [
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
  },
  {
    id: 10, key: 'optimism', name: 'Optimism', rpc: 'https://mainnet.optimism.io',
    nativeSymbol: 'ETH', explorer: 'https://optimistic.etherscan.io', color: '#ff0420',
    tokens: [
      { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    ],
  },
]

export function getChain(idOrKey: number | string): ChainDef | undefined {
  return typeof idOrKey === 'number'
    ? CHAINS.find(c => c.id === idOrKey)
    : CHAINS.find(c => c.key === idOrKey)
}

export function chainTokens(id: number): ChainTokenDef[] {
  return getChain(id)?.tokens ?? []
}
