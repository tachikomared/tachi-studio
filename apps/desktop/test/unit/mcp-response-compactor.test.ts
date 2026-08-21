// apps/desktop/test/unit/mcp-response-compactor.test.ts
//
// CONTEXT-ECONOMY P1 — MCP response compaction + expand_output recovery.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  compactResponse,
  putFullOutput,
  getFullOutput,
  registerExpandOutput,
  RESPONSE_BUDGET_CHARS,
  VERBATIM_TOOLS,
  _clearStore,
} from '../../electron/mcp/response-compactor'
import { newRegistry } from '../../electron/mcp/registry'

beforeEach(() => _clearStore())

const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')

describe('compactResponse', () => {
  it('returns short output unchanged (not compacted)', () => {
    const r = compactResponse('git_log', 'short result')
    expect(r.compacted).toBe(false)
    expect(r.text).toBe('short result')
    expect(r.id).toBeUndefined()
  })

  it('compacts large output, stashing the full bytes under a content id', () => {
    const payload = big(500)
    expect(payload.length).toBeGreaterThan(RESPONSE_BUDGET_CHARS)
    const r = compactResponse('fs_search', payload)
    expect(r.compacted).toBe(true)
    expect(r.text.length).toBeLessThan(payload.length)
    expect(r.id).toBeDefined()
    expect(r.text).toContain('expand_output')
    expect(r.text).toContain(`sha256:${r.id}`)
    // the full payload is recoverable
    expect(getFullOutput(r.id!)).toBe(payload)
  })

  it('never compacts verbatim tools (file reads stay byte-exact)', () => {
    const payload = big(500)
    const r = compactResponse('fs_read', payload)
    expect(r.compacted).toBe(false)
    expect(r.text).toBe(payload)
    expect(VERBATIM_TOOLS.has('fs_read')).toBe(true)
  })

  it('produces a stable id for identical output across calls', () => {
    const payload = big(500)
    const a = compactResponse('fetch', payload)
    const b = compactResponse('fetch', payload)
    expect(a.id).toBe(b.id)
  })
})

describe('putFullOutput / getFullOutput', () => {
  it('round-trips and accepts both bare and sha256-prefixed ids', () => {
    const id = putFullOutput('hello world')
    expect(getFullOutput(id)).toBe('hello world')
    expect(getFullOutput(`sha256:${id}`)).toBe('hello world')
  })
  it('returns undefined for an unknown id', () => {
    expect(getFullOutput('deadbeefdead')).toBeUndefined()
  })
})

describe('expand_output tool', () => {
  function tool() {
    const reg = newRegistry()
    registerExpandOutput(reg)
    return reg.get('expand_output')!
  }

  it('returns the full stored output by id', async () => {
    const payload = big(500)
    const { id } = compactResponse('fs_search', payload)
    const out = await tool().handler({ id }, 'agent') as { full?: string }
    expect(out.full).toBe(payload)
  })

  it('filters to matching lines when keywords are given', async () => {
    const id = putFullOutput('alpha\nbeta needle\ngamma\ndelta needle')
    const out = await tool().handler({ id, keywords: ['needle'] }, 'agent') as { matchedLines: number; result: string }
    expect(out.matchedLines).toBe(2)
    expect(out.result).toContain('beta needle')
    expect(out.result).not.toContain('alpha')
  })

  it('errors cleanly on a missing id', async () => {
    const out = await tool().handler({ id: 'nope000nope0' }, 'agent') as { error?: string }
    expect(out.error).toMatch(/no stored output/i)
  })
})
