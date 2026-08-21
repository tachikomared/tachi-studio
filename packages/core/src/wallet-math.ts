// packages/core/src/wallet-math.ts
// Pure money-formatting + cross-chain aggregation. No ethers, no I/O — the
// caller passes already-formatted decimal strings (from ethers formatUnits).

export interface PerChainBalance { chainId: number; symbol: string; amount: string }
export interface AggregatedToken {
  symbol:  string
  total:   string
  byChain: { chainId: number; amount: string }[]
}

/** Cap to 6 fractional digits, strip trailing zeros. Mirrors the old wallet-service trim(). */
export function trimAmount(s: string): string {
  if (!s.includes('.')) return s
  const [w, f] = s.split('.')
  const frac = f.slice(0, 6).replace(/0+$/, '')
  return frac ? `${w}.${frac}` : w
}

/** Sum a flat list of per-chain balances into one row per symbol. ETH first, then A→Z. */
export function aggregateBalances(rows: PerChainBalance[]): AggregatedToken[] {
  const bySymbol = new Map<string, { sum: number; byChain: { chainId: number; amount: string }[] }>()
  for (const r of rows) {
    const e = bySymbol.get(r.symbol) ?? { sum: 0, byChain: [] }
    e.sum += Number(r.amount) || 0
    e.byChain.push({ chainId: r.chainId, amount: r.amount })
    bySymbol.set(r.symbol, e)
  }
  const out: AggregatedToken[] = [...bySymbol.entries()].map(([symbol, e]) => ({
    symbol,
    total: trimAmount(String(e.sum)),
    byChain: e.byChain,
  }))
  out.sort((a, b) => {
    if (a.symbol === 'ETH') return -1
    if (b.symbol === 'ETH') return 1
    return a.symbol.localeCompare(b.symbol)
  })
  return out
}
