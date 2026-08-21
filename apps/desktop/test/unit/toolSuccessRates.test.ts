// apps/desktop/test/unit/toolSuccessRates.test.ts
import { describe, it, expect } from 'vitest'
import { selectToolSuccessRates } from '../../src/store/run-trace.store'
import type { Span } from '../../src/store/run-trace.store'

// Minimal span factory — only the fields the selector reads.
function tool(name: string, attrs: Record<string, unknown>): Span {
  return { id: `${name}_${Math.random()}`, name, kind: 'tool', startedAt: 0, endedAt: 1, attrs }
}

describe('selectToolSuccessRates', () => {
  it('returns [] for an empty store', () => {
    expect(selectToolSuccessRates([])).toEqual([])
  })

  it('ignores non-tool spans', () => {
    const spans: Span[] = [
      { id: 'a', name: 'llm', kind: 'llm', startedAt: 0, attrs: { ok: false } },
      { id: 'b', name: 'phase', kind: 'phase', startedAt: 0, attrs: {} },
      tool('read', { ok: true }),
    ]
    const out = selectToolSuccessRates(spans)
    expect(out).toEqual([{ tool: 'read', total: 1, okRate: 1 }])
  })

  it('computes okRate per tool name (ratio of ok:true over total)', () => {
    const spans: Span[] = [
      tool('read', { ok: true }),
      tool('read', { ok: true }),
      tool('read', { ok: false, error: 'boom' }),
      tool('write', { ok: false }),
    ]
    const out = selectToolSuccessRates(spans)
    const read = out.find(r => r.tool === 'read')!
    const write = out.find(r => r.tool === 'write')!
    expect(read).toEqual({ tool: 'read', total: 3, okRate: 2 / 3 })
    expect(write).toEqual({ tool: 'write', total: 1, okRate: 0 })
  })

  it('treats an error attr (no ok) as failure, and explicit error:undefined+ok:true as success', () => {
    const spans: Span[] = [
      tool('fetch', { error: 'timeout' }), // no ok field, has error -> fail
      tool('fetch', { ok: true }),
    ]
    const out = selectToolSuccessRates(spans)
    expect(out).toEqual([{ tool: 'fetch', total: 2, okRate: 0.5 }])
  })

  it('is tolerant of spans lacking any success attribute (counts as unknown -> failure)', () => {
    // Emitters may not stamp ok yet; selector must not crash and must still
    // count the call in total. An un-stamped tool span is conservatively
    // treated as NOT-ok so okRate never overstates success.
    const spans: Span[] = [
      tool('mystery', {}),
      tool('mystery', {}),
      tool('mystery', { ok: true }),
    ]
    const out = selectToolSuccessRates(spans)
    expect(out).toEqual([{ tool: 'mystery', total: 3, okRate: 1 / 3 }])
  })

  it('sorts by total descending (busiest tool first)', () => {
    const spans: Span[] = [
      tool('rare', { ok: true }),
      tool('busy', { ok: true }),
      tool('busy', { ok: false }),
      tool('busy', { ok: true }),
    ]
    const out = selectToolSuccessRates(spans)
    expect(out.map(r => r.tool)).toEqual(['busy', 'rare'])
  })

  it('groups by name even when ids differ', () => {
    const spans: Span[] = [
      { id: '1', name: 'grep', kind: 'tool', startedAt: 0, attrs: { ok: true } },
      { id: '2', name: 'grep', kind: 'tool', startedAt: 0, attrs: { ok: true } },
    ]
    const out = selectToolSuccessRates(spans)
    expect(out).toEqual([{ tool: 'grep', total: 2, okRate: 1 }])
  })
})
