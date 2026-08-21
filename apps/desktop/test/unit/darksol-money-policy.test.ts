// Tests for the darksol money-policy gate (darksol-money-policy.ts).
//
// This is the in-process enforcement the audit (2026-06-12, dimension 2/CRITICAL)
// found MISSING on the MCP path: an agent calling darksol `send`/`swap` through
// the MCP shim had NO per-trade cap, NO recipient allowlist, and could override
// dry-run by passing dryRun:false. These tests pin the fix: a pure decision
// function the shim consults BEFORE shelling out to the darksol CLI.

import { describe, it, expect } from 'vitest'
import {
  toWei,
  isValidLimitString,
  evaluateMoneyPolicy,
} from '../../electron/services/darksol-money-policy'

describe('toWei', () => {
  it('parses whole and fractional ETH to wei', () => {
    expect(toWei('1')).toBe(10n ** 18n)
    expect(toWei('0')).toBe(0n)
    expect(toWei('0.05')).toBe(50_000_000_000_000_000n)
    expect(toWei('1.5')).toBe(1_500_000_000_000_000_000n)
    expect(toWei('0.000000000000000001')).toBe(1n) // 1 wei
    expect(toWei('  0.5  ')).toBe(500_000_000_000_000_000n) // trims
  })
  it('rejects non-numeric, negative, or over-precise values as null', () => {
    expect(toWei('abc')).toBeNull()
    expect(toWei('')).toBeNull()
    expect(toWei('-1')).toBeNull()
    expect(toWei('1e3')).toBeNull()           // no scientific notation
    expect(toWei('0.1234567890123456789')).toBeNull() // >18 fractional digits
    expect(toWei('1.2.3')).toBeNull()
  })
})

describe('isValidLimitString', () => {
  it('accepts non-negative plain decimals (incl. 0)', () => {
    expect(isValidLimitString('0.05')).toBe(true)
    expect(isValidLimitString('0')).toBe(true)   // 0 = block all real trades, valid
    expect(isValidLimitString('1')).toBe(true)
    expect(isValidLimitString('  0.2 ')).toBe(true)
  })
  it('rejects empty, garbage, negative, scientific', () => {
    expect(isValidLimitString('')).toBe(false)
    expect(isValidLimitString('abc')).toBe(false)
    expect(isValidLimitString('-1')).toBe(false)
    expect(isValidLimitString('1e3')).toBe(false)
    expect(isValidLimitString('NaN')).toBe(false)
  })
})

const FORCED = { dryRunForced: true,  maxPerTradeEth: '0.05', allowlist: [] as string[] }
const REAL   = { dryRunForced: false, maxPerTradeEth: '0.05', allowlist: [] as string[] }
const ADDR_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const ADDR_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb'

describe('evaluateMoneyPolicy', () => {
  it('forces dry-run ON when the wallet has dry-run locked, ignoring caller dryRun:false', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '999', dryRun: false }, FORCED)
    expect(d.allowed).toBe(true)        // a simulation is always allowed
    expect(d.effectiveDryRun).toBe(true) // but it is forced to a sim, not a real send
  })

  it('allows a real send within the per-trade cap when dry-run is not forced', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '0.01', dryRun: false }, REAL)
    expect(d.allowed).toBe(true)
    expect(d.effectiveDryRun).toBe(false)
  })

  it('denies a real send that exceeds the per-trade cap', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '0.06', dryRun: false }, REAL)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/per-trade/i)
  })

  it('denies a real send with an unparseable amount (fail-closed)', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: 'lots', dryRun: false }, REAL)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/amount/i)
  })

  it('treats a caller-supplied dryRun:true as a simulation and skips the cap', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '999', dryRun: true }, REAL)
    expect(d.allowed).toBe(true)
    expect(d.effectiveDryRun).toBe(true)
  })

  it('defaults to a REAL send when dry-run is not forced and the caller omits dryRun', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '0.01' }, REAL)
    expect(d.effectiveDryRun).toBe(false)
    expect(d.allowed).toBe(true)
  })

  it('denies a real send to a recipient NOT in a non-empty allowlist', () => {
    const d = evaluateMoneyPolicy(
      { tool: 'send', to: ADDR_B, amount: '0.01', dryRun: false },
      { ...REAL, allowlist: [ADDR_A] },
    )
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/allowlist/i)
  })

  it('allows a real send to an allowlisted recipient (case-insensitive)', () => {
    const d = evaluateMoneyPolicy(
      { tool: 'send', to: ADDR_A.toLowerCase(), amount: '0.01', dryRun: false },
      { ...REAL, allowlist: [ADDR_A.toUpperCase()] },
    )
    expect(d.allowed).toBe(true)
  })

  it('applies the per-trade cap to swap, but NOT the recipient allowlist (swap has no external recipient)', () => {
    const overCap = evaluateMoneyPolicy({ tool: 'swap', amount: '0.06', dryRun: false }, REAL)
    expect(overCap.allowed).toBe(false)
    const withinCapWithAllowlist = evaluateMoneyPolicy(
      { tool: 'swap', amount: '0.01', dryRun: false },
      { ...REAL, allowlist: [ADDR_A] },
    )
    expect(withinCapWithAllowlist.allowed).toBe(true)
  })

  it('fails closed when the configured cap itself is invalid', () => {
    const d = evaluateMoneyPolicy(
      { tool: 'send', to: ADDR_A, amount: '0.01', dryRun: false },
      { dryRunForced: false, maxPerTradeEth: 'garbage', allowlist: [] },
    )
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/limit|cap|misconfigured/i)
  })
})

describe('evaluateMoneyPolicy — risk breaker gate (cross-trade)', () => {
  const trippedBreaker = { isTripped: () => ({ tripped: true, reason: 'breaker says no' }) }
  const okBreaker = { isTripped: () => ({ tripped: false } as const) }

  it('denies a within-cap REAL send when the breaker is tripped, surfacing its reason', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '0.01', dryRun: false }, REAL, trippedBreaker)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('breaker says no')
  })

  it('allows a within-cap REAL send when the breaker is NOT tripped', () => {
    const d = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '0.01', dryRun: false }, REAL, okBreaker)
    expect(d.allowed).toBe(true)
    expect(d.effectiveDryRun).toBe(false)
  })

  it('never blocks a SIMULATION on a tripped breaker (a dry run moves no money)', () => {
    const forced = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '999', dryRun: false }, FORCED, trippedBreaker)
    expect(forced.allowed).toBe(true)
    expect(forced.effectiveDryRun).toBe(true)
    const callerDry = evaluateMoneyPolicy({ tool: 'send', to: ADDR_A, amount: '999', dryRun: true }, REAL, trippedBreaker)
    expect(callerDry.allowed).toBe(true)
    expect(callerDry.effectiveDryRun).toBe(true)
  })
})
