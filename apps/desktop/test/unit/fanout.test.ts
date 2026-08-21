// apps/desktop/test/unit/fanout.test.ts
//
// FAN-OUT xN (flowith batch quantity) — unit tests for the pure geometry/keying
// core (fanout.ts) AND the store's variant-keyed upsertOutputNode contract:
//   • fanoutPositions lays N sibling cards out in a horizontal ROW beside source
//   • nextFanoutCount cycles x1 → x2 → x4 → x1
//   • fanoutVariantKey is a stable per-(source, index) identity
//   • fanoutSeed bumps a FIXED seed per variant, leaves a RANDOM seed alone
//   • upsertOutputNode: x1 keeps today's plain-append behavior; N>1 spawns
//     variant cards keyed v0..vN-1, a repeat fan-out REFRESHES the same cards,
//     and a later x1 never touches the variants.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  FANOUT_STEPS,
  nextFanoutCount,
  fanoutVariantKey,
  fanoutPositions,
  fanoutSeed,
  FANOUT_BASE_GAP,
  FANOUT_CARD_STRIDE,
} from '../../src/pages/nodes/canvas/fanout'

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('FANOUT_STEPS / nextFanoutCount', () => {
  it('exposes the x1/x2/x4 steps', () => {
    expect(FANOUT_STEPS).toEqual([1, 2, 4])
  })

  it('cycles 1 → 2 → 4 → 1', () => {
    expect(nextFanoutCount(1)).toBe(2)
    expect(nextFanoutCount(2)).toBe(4)
    expect(nextFanoutCount(4)).toBe(1)
  })

  it('resolves an off-cycle value to the first step', () => {
    // An unknown value (indexOf === -1) wraps to FANOUT_STEPS[0] === 1.
    expect(nextFanoutCount(3)).toBe(1)
    expect(nextFanoutCount(0)).toBe(1)
  })
})

describe('fanoutVariantKey', () => {
  it('is stable + distinct per (source, index)', () => {
    expect(fanoutVariantKey('node-7', 0)).toBe('node-7::v0')
    expect(fanoutVariantKey('node-7', 3)).toBe('node-7::v3')
    expect(fanoutVariantKey('node-7', 0)).toBe(fanoutVariantKey('node-7', 0))
    expect(fanoutVariantKey('node-7', 0)).not.toBe(fanoutVariantKey('node-7', 1))
    expect(fanoutVariantKey('a', 0)).not.toBe(fanoutVariantKey('b', 0))
  })
})

describe('fanoutPositions', () => {
  it('lays cards out left-to-right at the source y (one row)', () => {
    const p = fanoutPositions({ x: 100, y: 50 }, 3)
    expect(p).toHaveLength(3)
    // Same y across the row.
    expect(new Set(p.map(q => q.y))).toEqual(new Set([50]))
    // x0 = source.x + defaultSrcWidth(180) + baseGap(90) = 370, then +stride each.
    expect(p[0]).toEqual({ x: 100 + 180 + FANOUT_BASE_GAP, y: 50 })
    expect(p[1]!.x - p[0]!.x).toBe(FANOUT_CARD_STRIDE)
    expect(p[2]!.x - p[1]!.x).toBe(FANOUT_CARD_STRIDE)
  })

  it('honors an explicit source width / gap / stride', () => {
    const p = fanoutPositions({ x: 0, y: 0 }, 2, { srcWidth: 260, baseGap: 10, cardStride: 300 })
    expect(p[0]).toEqual({ x: 270, y: 0 })
    expect(p[1]).toEqual({ x: 570, y: 0 })
  })

  it('rounds fractional source coordinates', () => {
    const p = fanoutPositions({ x: 10.4, y: 20.6 }, 1)
    expect(p[0]).toEqual({ x: Math.round(10.4 + 180 + FANOUT_BASE_GAP), y: 21 })
  })

  it('handles negative coordinates', () => {
    const p = fanoutPositions({ x: -500, y: -200 }, 2, { srcWidth: 0, baseGap: 0, cardStride: 100 })
    expect(p[0]).toEqual({ x: -500, y: -200 })
    expect(p[1]).toEqual({ x: -400, y: -200 })
  })

  it('returns [] for n <= 0', () => {
    expect(fanoutPositions({ x: 0, y: 0 }, 0)).toEqual([])
    expect(fanoutPositions({ x: 0, y: 0 }, -1)).toEqual([])
  })
})

describe('fanoutSeed', () => {
  it('bumps a FIXED seed by the variant index (variant 0 keeps the base)', () => {
    expect(fanoutSeed(42, 0)).toBe(42)
    expect(fanoutSeed(42, 1)).toBe(43)
    expect(fanoutSeed(42, 3)).toBe(45)
    expect(fanoutSeed(0, 2)).toBe(2) // seed 0 is a fixed seed, not "random"
  })

  it('floors fractional seeds and indices', () => {
    expect(fanoutSeed(42.9, 1)).toBe(43)
    expect(fanoutSeed(5, 2.7)).toBe(7)
  })

  it('leaves a RANDOM / absent / invalid seed alone (null → untouched)', () => {
    expect(fanoutSeed(-1, 2)).toBeNull()
    expect(fanoutSeed(-100, 0)).toBeNull()
    expect(fanoutSeed(undefined, 0)).toBeNull()
    expect(fanoutSeed(null, 0)).toBeNull()
    expect(fanoutSeed('7', 0)).toBeNull()
    expect(fanoutSeed(NaN, 0)).toBeNull()
    expect(fanoutSeed(Infinity, 0)).toBeNull()
  })
})

// ── Store variant-key contract (upsertOutputNode) ───────────────────────────

// The store uses plain localStorage (no encryption) — shim it (mirrors
// nodesHistory.test.ts) before importing the store.
const _ls = new Map<string, string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}

// eslint-disable-next-line import/first
import { useNodesStore } from '../../src/pages/nodes/store/nodes.store'

const S = () => useNodesStore.getState()
function reset() {
  useNodesStore.setState({ nodes: [], edges: [], flowName: 'Untitled flow', undoStack: [], redoStack: [] })
}
function addSource(type = 'prompt'): string {
  S().addNode({ type, data: { label: 'Src' } } as never)
  return S().nodes[S().nodes.length - 1]!.id
}
const outs = () => S().nodes.filter(n => n.type === 'output')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vkey = (n: { data: any }) => n.data.variantKey as string | undefined

describe('upsertOutputNode — x1 (no variant) keeps today\'s behavior', () => {
  beforeEach(reset)

  it('appends a plain card (no variantKey) wired from the source', () => {
    const src = addSource()
    S().upsertOutputNode(src, { kind: 'text', text: 'hi', sourceLabel: 'Src' })
    expect(outs()).toHaveLength(1)
    expect(vkey(outs()[0]!)).toBeUndefined()
    expect(S().edges.some(e => e.source === src && e.target === outs()[0]!.id)).toBe(true)
  })

  it('a 2nd/3rd x1 run keeps the old cards (history of variations)', () => {
    const src = addSource()
    S().upsertOutputNode(src, { kind: 'text', text: 'a' })
    S().upsertOutputNode(src, { kind: 'text', text: 'b' })
    expect(outs()).toHaveLength(2)
  })
})

describe('upsertOutputNode — fan-out N>1 variant cards', () => {
  beforeEach(reset)

  it('spawns N sibling cards keyed v0..vN-1, all wired from the source, in a row', () => {
    const src = addSource()
    for (let i = 0; i < 4; i++) {
      S().upsertOutputNode(src, { kind: 'text', text: `v${i}` }, undefined, { index: i, count: 4 })
    }
    expect(outs()).toHaveLength(4)
    expect(outs().map(vkey).sort()).toEqual(
      [0, 1, 2, 3].map(i => fanoutVariantKey(src, i)).sort(),
    )
    for (const o of outs()) {
      expect(S().edges.some(e => e.source === src && e.target === o.id)).toBe(true)
    }
    // Fanned out in a ROW: one shared y, four distinct x.
    expect(new Set(outs().map(o => o.position.y)).size).toBe(1)
    expect(new Set(outs().map(o => o.position.x)).size).toBe(4)
  })

  it('stamps the 1-based variant number + frozen per-card estUsd', () => {
    const src = addSource()
    S().upsertOutputNode(src, { kind: 'text', text: 'x', estUsd: 0.0042 }, undefined, { index: 0, count: 2 })
    const card = outs()[0]!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((card.data as any).variant).toBe(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((card.data as any).estUsd).toBe(0.0042)
  })

  it('a REPEAT fan-out refreshes the SAME cards (no duplicates)', () => {
    const src = addSource()
    for (let i = 0; i < 2; i++) S().upsertOutputNode(src, { kind: 'text', text: `a${i}` }, undefined, { index: i, count: 2 })
    const ids1 = outs().map(n => n.id).sort()
    for (let i = 0; i < 2; i++) S().upsertOutputNode(src, { kind: 'text', text: `b${i}` }, undefined, { index: i, count: 2 })
    expect(outs()).toHaveLength(2)
    expect(outs().map(n => n.id).sort()).toEqual(ids1)
    const v0 = outs().find(o => vkey(o) === fanoutVariantKey(src, 0))!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((v0.data as any).text).toBe('b0')
  })

  it('a later x1 run never touches the variant cards', () => {
    const src = addSource()
    for (let i = 0; i < 2; i++) S().upsertOutputNode(src, { kind: 'text', text: `v${i}` }, undefined, { index: i, count: 2 })
    const variantIds = outs().filter(vkey).map(n => n.id).sort()
    S().upsertOutputNode(src, { kind: 'text', text: 'plain' }) // x1
    expect(outs()).toHaveLength(3) // 2 variants + 1 plain
    expect(outs().filter(vkey).map(n => n.id).sort()).toEqual(variantIds)
    const plain = outs().find(o => !vkey(o))!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((plain.data as any).text).toBe('plain')
  })
})
