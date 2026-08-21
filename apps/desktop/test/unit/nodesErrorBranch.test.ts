// apps/desktop/test/unit/nodesErrorBranch.test.ts
//
// Unit tests for the PURE per-node error-branch decision logic
// (src/pages/nodes/canvas/errorBranch.ts) — the core of NODES-RESEARCH #6.
//
// These pin the exact v1 truth table documented in that module: success paths
// skip err-only targets; failure paths feed the error text through err-edges and
// skip normal targets; mixed inputs run when at least one input is satisfied.
//
// Pure module (no xyflow / no React / no store), so this runs in the plain node
// environment with structural edge literals.

import { describe, it, expect } from 'vitest'
import {
  ERR_HANDLE_ID,
  isErrorEdge,
  decideNodeRun,
  type ErrBranchEdge,
  type UpstreamOutcome,
} from '../../src/pages/nodes/canvas/errorBranch'

// ── helpers ───────────────────────────────────────────────────────────────────

/** normal edge (a geometric 8-handle id, like the real router emits). */
const n = (source: string, target: string): ErrBranchEdge =>
  ({ source, target, sourceHandle: 'E-src' })

/** ERROR edge (dragged from the 'err' handle). */
const err = (source: string, target: string): ErrBranchEdge =>
  ({ source, target, sourceHandle: ERR_HANDLE_ID })

/** outcome lookup from a plain record; missing id → undefined (STATIC source). */
const lookup = (m: Record<string, UpstreamOutcome>) => (id: string) => m[id]

// ── isErrorEdge / ERR_HANDLE_ID ─────────────────────────────────────────────────

describe('ERR_HANDLE_ID + isErrorEdge', () => {
  it('the error handle id is the fixed "err"', () => {
    expect(ERR_HANDLE_ID).toBe('err')
  })

  it('is true only for the err sourceHandle', () => {
    expect(isErrorEdge({ source: 'a', target: 'b', sourceHandle: 'err' })).toBe(true)
  })

  it('is false for a normal geometric handle', () => {
    expect(isErrorEdge({ source: 'a', target: 'b', sourceHandle: 'SE-src' })).toBe(false)
  })

  it('is false for an absent / null sourceHandle', () => {
    expect(isErrorEdge({ source: 'a', target: 'b' })).toBe(false)
    expect(isErrorEdge({ source: 'a', target: 'b', sourceHandle: null })).toBe(false)
  })
})

// ── root / entry nodes ──────────────────────────────────────────────────────────

describe('decideNodeRun · entry nodes', () => {
  it('runs a node with no incoming edges', () => {
    const d = decideNodeRun('root', [], lookup({}))
    expect(d).toEqual({ run: true, errorInputs: {} })
  })

  it('runs a node fed only by a STATIC source (no tracked outcome)', () => {
    // e.g. a Text/Provider node wired in — always a normal input.
    const d = decideNodeRun('b', [n('textNode', 'b')], lookup({}))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({})
  })
})

// ── SUCCESS path: err-only targets are skipped ("no error to handle") ────────────

describe('decideNodeRun · success path skips err-only targets', () => {
  it('skips a target wired ONLY via an err-edge when the upstream succeeded', () => {
    const d = decideNodeRun('handler', [err('a', 'handler')], lookup({ a: { status: 'success' } }))
    expect(d).toEqual({ run: false, skipReason: 'no-error', errorInputs: {} })
  })

  it('still RUNS a normal target of a succeeded node', () => {
    const d = decideNodeRun('b', [n('a', 'b')], lookup({ a: { status: 'success' } }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({})
  })

  it('skips even when several err-edges all come from succeeded upstreams', () => {
    const d = decideNodeRun('h', [err('a', 'h'), err('b', 'h')], lookup({
      a: { status: 'success' }, b: { status: 'success' },
    }))
    expect(d).toEqual({ run: false, skipReason: 'no-error', errorInputs: {} })
  })
})

// ── FAILURE path: err-edge receives the error, normal targets are skipped ────────

describe('decideNodeRun · failure path', () => {
  it('feeds the error text through the err-edge and runs the handler', () => {
    const d = decideNodeRun('handler', [err('a', 'handler')], lookup({
      a: { status: 'error', error: 'boom: 500 upstream' },
    }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({ a: 'boom: 500 upstream' })
  })

  it('uses an empty string when the failed upstream has no error message', () => {
    const d = decideNodeRun('handler', [err('a', 'handler')], lookup({ a: { status: 'error' } }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({ a: '' })
  })

  it('skips a NORMAL target of a failed node ("upstream failed")', () => {
    const d = decideNodeRun('c', [n('a', 'c')], lookup({ a: { status: 'error', error: 'x' } }))
    expect(d).toEqual({ run: false, skipReason: 'upstream-failed', errorInputs: {} })
  })

  it('collects error text from MULTIPLE failed err-edge upstreams', () => {
    const d = decideNodeRun('h', [err('a', 'h'), err('b', 'h')], lookup({
      a: { status: 'error', error: 'A failed' }, b: { status: 'error', error: 'B failed' },
    }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({ a: 'A failed', b: 'B failed' })
  })
})

// ── MIXED inputs ────────────────────────────────────────────────────────────────

describe('decideNodeRun · mixed inputs', () => {
  it('runs with a satisfied normal input AND injects a failed err-edge', () => {
    const d = decideNodeRun('m', [n('x', 'm'), err('y', 'm')], lookup({
      x: { status: 'success' }, y: { status: 'error', error: 'y broke' },
    }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({ y: 'y broke' })
  })

  it('an err-edge from a SUCCEEDED upstream carries nothing (runs on the normal input)', () => {
    const d = decideNodeRun('m', [n('x', 'm'), err('z', 'm')], lookup({
      x: { status: 'success' }, z: { status: 'success' },
    }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({})
  })

  it('runs if ANY normal input succeeded, even when a sibling normal input failed', () => {
    const d = decideNodeRun('m', [n('ok', 'm'), n('bad', 'm')], lookup({
      ok: { status: 'success' }, bad: { status: 'error', error: 'nope' },
    }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({})
  })

  it('a failed NORMAL input wins the skip reason over an unfired err-edge', () => {
    // No satisfied inputs: normal upstream failed + err upstream succeeded.
    const d = decideNodeRun('m', [n('bad', 'm'), err('good', 'm')], lookup({
      bad: { status: 'error', error: 'nope' }, good: { status: 'success' },
    }))
    expect(d).toEqual({ run: false, skipReason: 'upstream-failed', errorInputs: {} })
  })
})

// ── skipped-upstream cascades ───────────────────────────────────────────────────

describe('decideNodeRun · skipped-upstream cascade', () => {
  it('cascade-skips a normal target of a skipped node', () => {
    const d = decideNodeRun('c', [n('b', 'c')], lookup({ b: { status: 'skipped' } }))
    expect(d).toEqual({ run: false, skipReason: 'upstream-failed', errorInputs: {} })
  })

  it('cascade-skips an err target whose upstream was skipped (neither ran nor failed)', () => {
    const d = decideNodeRun('c', [err('b', 'c')], lookup({ b: { status: 'skipped' } }))
    expect(d).toEqual({ run: false, skipReason: 'upstream-failed', errorInputs: {} })
  })

  it('still runs when a satisfied static input coexists with a skipped upstream', () => {
    const d = decideNodeRun('c', [n('b', 'c'), n('staticSrc', 'c')], lookup({ b: { status: 'skipped' } }))
    expect(d.run).toBe(true)
    expect(d.errorInputs).toEqual({})
  })
})
