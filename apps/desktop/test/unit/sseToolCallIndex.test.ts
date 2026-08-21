// SSE tool_call index normalizer — the wire-level repair for gateways that
// stream tool_calls deltas with missing/sparse `index` (crashes the AI-SDK
// assembler: "reading 'hasFinished'" on a sparse-array hole).
import { describe, it, expect } from 'vitest'
import { createSseToolCallIndexNormalizer } from '../../electron/services/tachi/wire'

const line = (obj: unknown) => `data: ${JSON.stringify(obj)}`
const tc = (delta: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [delta] } }] })
const parseIdx = (s: string) =>
  (JSON.parse(s.slice(5)) as { choices: Array<{ delta: { tool_calls: Array<{ index?: number }> } }> }).choices[0].delta.tool_calls[0].index

describe('createSseToolCallIndexNormalizer', () => {
  it('remaps a sparse provider index (1 with no 0) to dense 0', () => {
    const n = createSseToolCallIndexNormalizer()
    expect(parseIdx(n(line(tc({ index: 1, id: 'a', function: { name: 'glob', arguments: '' } }))))).toBe(0)
    expect(parseIdx(n(line(tc({ index: 1, function: { arguments: '{"x"' } }))))).toBe(0)
  })

  it('assigns indices by id when the provider omits index entirely', () => {
    const n = createSseToolCallIndexNormalizer()
    expect(parseIdx(n(line(tc({ id: 'call_1', function: { name: 'read' } }))))).toBe(0)
    expect(parseIdx(n(line(tc({ id: 'call_2', function: { name: 'grep' } }))))).toBe(1)
    expect(parseIdx(n(line(tc({ id: 'call_1', function: { arguments: 'abc' } }))))).toBe(0)
  })

  it('continuation chunks with neither index nor id stick to the last call', () => {
    const n = createSseToolCallIndexNormalizer()
    expect(parseIdx(n(line(tc({ id: 'only', function: { name: 'bash' } }))))).toBe(0)
    expect(parseIdx(n(line(tc({ function: { arguments: '{"cmd":' } }))))).toBe(0)
    expect(parseIdx(n(line(tc({ function: { arguments: '"ls"}' } }))))).toBe(0)
  })

  it('cross-registers index+id so later id-only chunks resolve', () => {
    const n = createSseToolCallIndexNormalizer()
    expect(parseIdx(n(line(tc({ index: 3, id: 'x', function: { name: 'edit' } }))))).toBe(0)
    expect(parseIdx(n(line(tc({ id: 'x', function: { arguments: 'zz' } }))))).toBe(0)
  })

  it('keeps already-dense streams byte-identical', () => {
    const n = createSseToolCallIndexNormalizer()
    const l0 = line(tc({ index: 0, id: 'a', function: { name: 'glob' } }))
    expect(n(l0)).toBe(l0)
    const l1 = line(tc({ index: 1, id: 'b', function: { name: 'read' } }))
    expect(n(l1)).toBe(l1)
  })

  it('passes non-tool lines, [DONE], comments and malformed JSON through untouched', () => {
    const n = createSseToolCallIndexNormalizer()
    for (const l of ['data: [DONE]', 'data: {"choices":[{"delta":{"content":"hi"}}]}', ': keepalive', '', 'event: ping', 'data: {broken']) {
      expect(n(l)).toBe(l)
    }
  })
})
