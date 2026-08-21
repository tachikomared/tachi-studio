// apps/desktop/test/unit/mergeSelection.test.ts
//
// NODES-RESEARCH STEAL (flowith MERGE gesture) — pure planner unit tests.
// mergeSelectionPlan keeps only RUNNABLE-or-output sources, lands the child at
// their centroid pushed straight down by MERGE_DROP_OFFSET_Y, preserves input
// order, and returns null below 2 eligible.
import { describe, it, expect } from 'vitest'
import {
  mergeSelectionPlan,
  isMergeSource,
  MERGE_SOURCE_TYPES,
  MERGE_DROP_OFFSET_Y,
  type MergeCandidate,
} from '../../src/pages/nodes/canvas/mergeSelection'

const at = (id: string, type: string, x: number, y: number): MergeCandidate =>
  ({ id, type, position: { x, y } })

describe('isMergeSource / MERGE_SOURCE_TYPES', () => {
  it('accepts RUNNABLE-or-output kinds', () => {
    for (const t of ['agent', 'prompt', 'media', 'output']) {
      expect(isMergeSource(t), t).toBe(true)
      expect(MERGE_SOURCE_TYPES.has(t), t).toBe(true)
    }
  })

  it('rejects config / static / annotation / inert kinds and undefined', () => {
    for (const t of ['provider', 'skill', 'folder', 'internet', 'mcp', 'text', 'imageref', 'note', 'subflow', 'unknown']) {
      expect(isMergeSource(t), t).toBe(false)
    }
    expect(isMergeSource(undefined)).toBe(false)
  })
})

describe('mergeSelectionPlan — centroid + drop', () => {
  it('lands the child at the sources centroid pushed down by MERGE_DROP_OFFSET_Y', () => {
    const plan = mergeSelectionPlan([at('a', 'agent', 0, 0), at('b', 'output', 100, 40)])
    expect(plan).not.toBeNull()
    // centroid = (50, 20); the y-offset is applied below it.
    expect(plan!.position).toEqual({ x: 50, y: 20 + MERGE_DROP_OFFSET_Y })
    expect(plan!.sourceIds).toEqual(['a', 'b'])
  })

  it('rounds fractional centroids', () => {
    const plan = mergeSelectionPlan([
      at('a', 'agent', 0, 0),
      at('b', 'agent', 1, 1),
      at('c', 'agent', 0, 0),
    ])
    // centroid.x = 1/3 → rounds to 0; centroid.y = 1/3 pushed down + rounded.
    expect(plan!.position.x).toBe(0)
    expect(plan!.position.y).toBe(Math.round(1 / 3 + MERGE_DROP_OFFSET_Y))
  })

  it('handles negative coordinates', () => {
    const plan = mergeSelectionPlan([at('a', 'agent', -100, -50), at('b', 'media', -300, -150)])
    expect(plan!.position).toEqual({ x: -200, y: -100 + MERGE_DROP_OFFSET_Y })
  })
})

describe('mergeSelectionPlan — exclusion rules', () => {
  it('drops non-source nodes from BOTH the wiring and the centroid math', () => {
    const plan = mergeSelectionPlan([
      at('note', 'note', -1000, -1000),
      at('sub', 'subflow', 9999, 9999),
      at('prov', 'provider', 5000, 5000),
      at('txt', 'text', 8000, 8000),
      at('a', 'agent', 0, 0),
      at('b', 'media', 200, 0),
    ])
    // Only a + b count → centroid.x = 100 (the excluded outliers do not shift it).
    expect(plan!.sourceIds).toEqual(['a', 'b'])
    expect(plan!.position.x).toBe(100)
  })

  it('preserves the input order of the eligible sources', () => {
    const plan = mergeSelectionPlan([at('b', 'output', 0, 0), at('a', 'agent', 0, 0)])
    expect(plan!.sourceIds).toEqual(['b', 'a'])
  })
})

describe('mergeSelectionPlan — fewer than 2 eligible → null', () => {
  it('returns null when nothing is eligible', () => {
    expect(mergeSelectionPlan([at('n', 'note', 0, 0), at('p', 'provider', 0, 0)])).toBeNull()
  })

  it('returns null when exactly one node is eligible', () => {
    expect(mergeSelectionPlan([at('a', 'agent', 0, 0), at('t', 'text', 0, 0)])).toBeNull()
  })

  it('returns null for an empty selection', () => {
    expect(mergeSelectionPlan([])).toBeNull()
  })
})
