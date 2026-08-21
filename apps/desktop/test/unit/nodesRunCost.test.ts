// NODES-RESEARCH #4: per-node run-cost estimate — honest attribution only.
//
// 2026-08-01: the estimate now carries a BASIS, because "$0 (local)" was printed
// for anything that priced at zero. In a local-first app "local" is read as "my
// data never left this machine", so that string is a privacy claim; it must be
// true, not merely cheap.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { estimateNodeRunCost, estimateNodeRunCostUsd, formatCostChip, asRunCostBasis } from '../../src/pages/nodes/run-cost'
import { PROVIDER_LIST, providerLocality } from '@tachi/core/src/providers/registry'
import type { TachiNode, TachiEdge } from '../../src/pages/nodes/types'

const agent = { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A', harnessId: 'openclaude', systemPrompt: 'x'.repeat(400) } } as unknown as TachiNode
const bankr = { id: 'p1', type: 'provider', position: { x: 0, y: 0 }, data: { providerId: 'bankr', model: 'claude-opus-4.8' } } as unknown as TachiNode
const local = { id: 'p2', type: 'provider', position: { x: 0, y: 0 }, data: { providerId: 'llamacpp', model: 'whatever.gguf' } } as unknown as TachiNode
const e1 = { id: 'e1', source: 'p1', target: 'a1' } as unknown as TachiEdge
const e2 = { id: 'e2', source: 'p2', target: 'a1' } as unknown as TachiEdge

const withProvider = (data: Record<string, unknown>) => ({ ...bankr, data }) as TachiNode

describe('estimateNodeRunCostUsd', () => {
  it('prices a cloud provider chain from its model rates', () => {
    const usd = estimateNodeRunCostUsd([agent, bankr], [e1], 'a1', 'y'.repeat(4000))
    expect(usd).not.toBeNull()
    expect(usd!).toBeGreaterThan(0)
    expect(usd!).toBeLessThan(1) // sanity: a small run is fractions of a dollar
  })

  it('local providers cost exactly 0', () => {
    expect(estimateNodeRunCostUsd([agent, local], [e2], 'a1', 'out')).toBe(0)
  })

  it('returns null (no number) with no provider, auto model, or unknown model', () => {
    expect(estimateNodeRunCostUsd([agent], [], 'a1', 'out')).toBeNull()
    expect(estimateNodeRunCostUsd([agent, withProvider({ providerId: 'bankr', model: 'auto' })], [e1], 'a1', 'out')).toBeNull()
    expect(estimateNodeRunCostUsd([agent, withProvider({ providerId: 'bankr', model: 'no-such-model-xyz-99' })], [e1], 'a1', 'out')).toBeNull()
  })

  it('non-agent nodes are not priced', () => {
    expect(estimateNodeRunCostUsd([agent, bankr], [e1], 'p1', 'out')).toBeNull()
  })
})

describe('estimateNodeRunCost basis — the three $0 cases are distinguishable', () => {
  it('llama.cpp / ollama run on this machine → local', () => {
    expect(estimateNodeRunCost([agent, local], [e2], 'a1', 'out')).toEqual({ usd: 0, basis: 'local' })
    const ollama = withProvider({ providerId: 'ollama', model: 'llama3.3' })
    expect(estimateNodeRunCost([agent, ollama], [e1], 'a1', 'out')).toEqual({ usd: 0, basis: 'local' })
  })

  it('a genuinely FREE CLOUD model is free, NOT local', () => {
    // The exact model from the ledger fix: $0 and reachable only over the wire.
    const nemotron = withProvider({ providerId: 'opengateway', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' })
    expect(estimateNodeRunCost([agent, nemotron], [e1], 'a1', 'out')).toEqual({ usd: 0, basis: 'free' })
  })

  it('the freellmapi router is free but NOT local — it proxies to the cloud', () => {
    // registry egress = 'cloud' despite the loopback address and the -local id.
    // It is also the default provider in every starter template, so this was
    // the most-shown wrong "(local)" label in the app.
    for (const pid of ['freellmapi', 'freellmapi-local']) {
      expect(estimateNodeRunCost([agent, withProvider({ providerId: pid, model: 'auto' })], [e1], 'a1', 'out'))
        .toEqual({ usd: 0, basis: 'free' })
    }
  })

  it('an unpriceable model is UNKNOWN — no number, and never a $0', () => {
    for (const model of ['auto', 'no-such-model-xyz-99', '']) {
      expect(estimateNodeRunCost([agent, withProvider({ providerId: 'bankr', model })], [e1], 'a1', 'out'))
        .toEqual({ usd: null, basis: 'unknown' })
    }
  })

  it('a priced cloud model is "priced", and nothing to attribute has no basis at all', () => {
    expect(estimateNodeRunCost([agent, bankr], [e1], 'a1', 'out').basis).toBe('priced')
    expect(estimateNodeRunCost([agent], [], 'a1', 'out')).toEqual({ usd: null, basis: null })
    expect(estimateNodeRunCost([agent, bankr], [e1], 'p1', 'out')).toEqual({ usd: null, basis: null })
  })
})

// ── The basis is DERIVED, not listed ─────────────────────────────────────────
//
// This module used to hold FREE_REMOTE_IDS = {'freellmapi-local',
// 'free-claude-code'}: a hand-maintained set re-encoding two registry facts
// (egress + "costs nothing"). The failure mode is silent and delayed — add a
// twelfth provider and the chip lies about it until someone remembers this
// file. The basis now comes from `providerLocality()` (the same derivation the
// picker badge uses) and `billing`, so these expectations are generated from
// the registry rather than restated here.

describe('every registry provider gets the right basis, without being listed anywhere', () => {
  it('local ⇒ local, free-but-not-local ⇒ free, and no provider is left unclassified', () => {
    for (const p of PROVIDER_LIST) {
      const node = withProvider({ providerId: p.id, model: 'auto' })
      const { basis } = estimateNodeRunCost([agent, node], [e1], 'a1', 'out')
      const expected =
        providerLocality(p.id) === 'local' ? 'local'
        : p.billing === 'free'             ? 'free'
        : 'unknown'   // 'auto' is unpriceable; a real model id would price
      expect(basis, `${p.id} (egress ${p.egress} / billing ${p.billing})`).toBe(expected)
    }
  })

  it('a relay is FREE, never LOCAL — the two sidecars, from the registry', () => {
    const relays = PROVIDER_LIST.filter(p => providerLocality(p.id) === 'relay')
    expect(relays.length).toBeGreaterThan(0)
    for (const p of relays) {
      const { usd, basis } = estimateNodeRunCost(
        [agent, withProvider({ providerId: p.id, model: 'auto' })], [e1], 'a1', 'out')
      expect(basis, p.id).toBe('free')
      expect(usd, p.id).toBe(0)
    }
  })

  it('the module carries no id list of its own for the free/remote question', () => {
    // Comments stripped first — the prose is allowed to NAME the providers it
    // explains ("'ollama' → 'ollama-local'"); the CODE may not branch on them.
    const src = readFileSync(resolve(__dirname, '../../src/pages/nodes/run-cost.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map(l => (l.trimStart().startsWith('//') ? '' : l)).join('\n')
    // EXTRA_LOCAL_IDS survives on purpose: bare 'local' / 'llama-cpp-local' are
    // ids the REGISTRY does not know, from hand-written flows. Anything the
    // registry does know must be asked, not listed.
    for (const id of PROVIDER_LIST.map(p => p.id)) {
      expect(src.includes(`'${id}'`), `run-cost.ts hardcodes the provider id ${id}`).toBe(false)
    }
    expect(src).toContain('providerLocality(canonical)')
    expect(src).toContain("providerBilling(canonical) === 'free'")
  })
})

describe('formatCostChip', () => {
  it('formats the money tiers', () => {
    expect(formatCostChip(null)).toBeNull()
    expect(formatCostChip(0.00005)).toBe('≈$0.0001')
    expect(formatCostChip(0.0031)).toBe('≈$0.0031')
    expect(formatCostChip(0.12)).toBe('≈$0.12')
  })

  it('says what is TRUE about a $0 — local, free, or neither', () => {
    expect(formatCostChip(0, 'local')).toBe('$0 (local)')
    expect(formatCostChip(0, 'free')).toBe('$0 (free cloud)')
    // Flows saved before the basis existed: a bare $0 claims nothing. It must
    // NOT fall back to "(local)" — that was the bug.
    expect(formatCostChip(0)).toBe('$0')
    expect(formatCostChip(0, null)).toBe('$0')
  })

  it('an unknown price reads as unknown, not as free', () => {
    expect(formatCostChip(null, 'unknown')).toBe('$? (price unknown)')
    expect(formatCostChip(null, 'unknown')).not.toContain('$0')
  })

  it('runs the qualifier through the injected translator, money through neither', () => {
    const t = (key: string) => `«${key}»`
    expect(formatCostChip(0, 'local', t)).toBe('$0 («costChip.local»)')
    expect(formatCostChip(0, 'free', t)).toBe('$0 («costChip.free»)')
    expect(formatCostChip(null, 'unknown', t)).toBe('$? («costChip.unknown»)')
    expect(formatCostChip(0.12, 'priced', t)).toBe('≈$0.12')
  })
})

describe('asRunCostBasis', () => {
  it('accepts the four bases and rejects everything else', () => {
    for (const b of ['priced', 'local', 'free', 'unknown']) expect(asRunCostBasis(b)).toBe(b)
    for (const junk of [undefined, null, '', 'LOCAL', 0, {}, true]) expect(asRunCostBasis(junk)).toBeNull()
  })
})
