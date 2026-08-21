// apps/desktop/test/unit/nodeRefs.test.ts
//
// Unit tests for the renderer-side reference-token utilities in
// src/lib/nodeRefs.ts — the {{node:<id>}} token regex plus upstream-ref
// substitution. These must stay byte-identical to the compiler's contract,
// so we pin: token detection, parsing (order + duplicates + whitespace),
// substitution against a provided map, unknown-token blanking, special chars
// in ids/labels, multiple tokens in one string, and the fast/trim paths.
//
// Pure module (only a type-only import from @xyflow/react), node environment.

import { describe, it, expect } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import {
  hasNodeToken,
  parseTokens,
  serializeToken,
  resolveTokens,
  listUpstreamRefs,
  previewMap,
  type UpstreamRef,
} from '../../src/lib/nodeRefs'

describe('hasNodeToken', () => {
  it('is true for a bare token', () => {
    expect(hasNodeToken('{{node:a}}')).toBe(true)
  })

  it('is true for a token embedded in surrounding text', () => {
    expect(hasNodeToken('mood is {{node:x}} today')).toBe(true)
  })

  it('tolerates whitespace after the braces', () => {
    expect(hasNodeToken('{{ node:x}}')).toBe(true)
  })

  it('is false for token-free text', () => {
    expect(hasNodeToken('plain text, no refs')).toBe(false)
  })

  it('is false for an empty string', () => {
    expect(hasNodeToken('')).toBe(false)
  })

  it('is false for braces that are not a node token', () => {
    expect(hasNodeToken('{{ var:x }}')).toBe(false)
  })
})

describe('parseTokens', () => {
  it('returns [] for token-free template', () => {
    expect(parseTokens('hello world')).toEqual([])
  })

  it('returns [] for empty string', () => {
    expect(parseTokens('')).toEqual([])
  })

  it('extracts a single node id', () => {
    expect(parseTokens('{{node:a}}')).toEqual([{ nodeId: 'a' }])
  })

  it('extracts ids in document order including duplicates', () => {
    expect(parseTokens('{{node:a}}, mood: {{ node:b }} and {{node:a}}')).toEqual([
      { nodeId: 'a' },
      { nodeId: 'b' },
      { nodeId: 'a' },
    ])
  })

  it('trims surrounding whitespace from the captured id', () => {
    expect(parseTokens('{{ node: spaced-id }}')).toEqual([{ nodeId: 'spaced-id' }])
  })

  it('captures ids with special characters (non-} run)', () => {
    expect(parseTokens('{{node:a:b/c-d_e 1}}')).toEqual([{ nodeId: 'a:b/c-d_e 1' }])
  })

  it('does not match across an interleaved closing brace', () => {
    // The non-greedy [^}]+? stops at the first '}', so the first valid token wins.
    expect(parseTokens('{{node:a}} {{node:b}}')).toEqual([
      { nodeId: 'a' },
      { nodeId: 'b' },
    ])
  })
})

describe('serializeToken', () => {
  it('wraps an id into the canonical token form', () => {
    expect(serializeToken('a')).toBe('{{node:a}}')
  })

  it('round-trips through parseTokens', () => {
    const tok = serializeToken('node-7')
    expect(parseTokens(tok)).toEqual([{ nodeId: 'node-7' }])
  })
})

describe('resolveTokens', () => {
  it('fast-paths a token-free template to a plain trim', () => {
    expect(resolveTokens('  hi there  ', new Map())).toBe('hi there')
  })

  it('substitutes a known token with its mapped value', () => {
    const out = resolveTokens('{{node:a}}', new Map([['a', 'OUTPUT']]))
    expect(out).toBe('OUTPUT')
  })

  it('replaces an unknown token with blank', () => {
    expect(resolveTokens('x{{node:missing}}y', new Map())).toBe('xy')
  })

  it('replaces a known empty-string value (present but blank)', () => {
    const out = resolveTokens('a{{node:e}}b', new Map([['e', '']]))
    expect(out).toBe('ab')
  })

  it('substitutes multiple distinct tokens in one string', () => {
    const map = new Map([
      ['a', 'ALPHA'],
      ['b', 'BETA'],
    ])
    expect(resolveTokens('{{node:a}} then {{node:b}}', map)).toBe('ALPHA then BETA')
  })

  it('substitutes repeated occurrences of the same token', () => {
    const map = new Map([['a', 'X']])
    expect(resolveTokens('{{node:a}}/{{node:a}}', map)).toBe('X/X')
  })

  it('resolves whitespace-tolerant tokens using the trimmed id', () => {
    const map = new Map([['a', 'OK']])
    expect(resolveTokens('{{  node: a  }}', map)).toBe('OK')
  })

  it('trims the final result after substitution', () => {
    const map = new Map([['a', '  spaced  ']])
    // outer template has no extra whitespace, value keeps its inner spaces but
    // the overall result is trimmed at the ends.
    expect(resolveTokens('{{node:a}}', map)).toBe('spaced')
  })

  it('mixes known and unknown tokens, blanking the unknown', () => {
    const map = new Map([['a', 'A']])
    expect(resolveTokens('[{{node:a}}|{{node:zzz}}]', map)).toBe('[A|]')
  })
})

// --- listUpstreamRefs ------------------------------------------------------

const node = (id: string, data?: Record<string, unknown>, type?: string): Node =>
  ({ id, position: { x: 0, y: 0 }, data: data ?? {}, type } as unknown as Node)

const edge = (source: string, target: string): Edge =>
  ({ id: `${source}->${target}`, source, target } as Edge)

describe('listUpstreamRefs', () => {
  it('returns transitive predecessors, excluding the node itself', () => {
    // a -> b -> c ; current = c should see a and b (not c).
    const nodes = [node('a'), node('b'), node('c')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    const ids = listUpstreamRefs('c', nodes, edges).map(r => r.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('returns [] when the node has no upstream', () => {
    const nodes = [node('a'), node('b')]
    const edges = [edge('a', 'b')]
    expect(listUpstreamRefs('a', nodes, edges)).toEqual([])
  })

  it('does not loop forever on a cycle and excludes the current node', () => {
    // a <-> b cycle, plus a -> c ; current = c sees a and b once each.
    const nodes = [node('a'), node('b'), node('c')]
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('a', 'c'), edge('b', 'c')]
    const ids = listUpstreamRefs('c', nodes, edges).map(r => r.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('uses data.label as the human label', () => {
    const nodes = [node('a', { label: 'My Prompt' }), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.label).toBe('My Prompt')
  })

  it('preserves special characters in labels', () => {
    const nodes = [node('a', { label: 'café ✨ <b> {{x}}' }), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.label).toBe('café ✨ <b> {{x}}')
  })

  it('falls back to node type when label is missing', () => {
    const nodes = [node('a', {}, 'llmNode'), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.label).toBe('llmNode')
  })

  it('falls back to id when label is blank/whitespace and no type', () => {
    const nodes = [node('a', { label: '   ' }), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.label).toBe('a')
  })

  it('collapses lastOutput into a single-line preview', () => {
    const nodes = [node('a', { lastOutput: '  multi\n line\toutput  ' }), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.preview).toBe('multi line output')
  })

  it('truncates a long preview with an ellipsis at 80 chars', () => {
    const long = 'x'.repeat(200)
    const nodes = [node('a', { lastOutput: long }), node('b')]
    const edges = [edge('a', 'b')]
    const [ref] = listUpstreamRefs('b', nodes, edges)
    expect(ref.preview).toHaveLength(80)
    expect(ref.preview!.endsWith('…')).toBe(true)
  })

  it('leaves preview undefined when lastOutput is absent or blank', () => {
    const nodes = [node('a', { lastOutput: '   ' }), node('b'), node('c')]
    const edges = [edge('a', 'c'), edge('b', 'c')]
    const refs = listUpstreamRefs('c', nodes, edges)
    expect(refs.every(r => r.preview === undefined)).toBe(true)
  })

  it('skips reachable ids that have no matching node entry', () => {
    // edge references a ghost source 'g' with no node; it must be dropped.
    const nodes = [node('b')]
    const edges = [edge('g', 'b')]
    expect(listUpstreamRefs('b', nodes, edges)).toEqual([])
  })

  it('sorts by label then id for a stable dropdown order', () => {
    const nodes = [
      node('z', { label: 'Alpha' }),
      node('a', { label: 'Alpha' }),
      node('m', { label: 'Beta' }),
      node('cur'),
    ]
    const edges = [edge('z', 'cur'), edge('a', 'cur'), edge('m', 'cur')]
    const labels = listUpstreamRefs('cur', nodes, edges).map(r => `${r.label}:${r.id}`)
    // same label 'Alpha' breaks ties by id (a < z); 'Beta' last.
    expect(labels).toEqual(['Alpha:a', 'Alpha:z', 'Beta:m'])
  })
})

describe('previewMap + resolveTokens integration', () => {
  it('builds a map only from refs that have a preview', () => {
    const refs: UpstreamRef[] = [
      { id: 'a', label: 'A', preview: 'alpha' },
      { id: 'b', label: 'B' }, // no preview
    ]
    const m = previewMap(refs)
    expect(m.get('a')).toBe('alpha')
    expect(m.has('b')).toBe(false)
  })

  it('feeds resolveTokens so a live preview matches upstream output', () => {
    const nodes = [
      node('a', { label: 'Src', lastOutput: 'hello world' }),
      node('b'),
    ]
    const edges = [edge('a', 'b')]
    const upstream = listUpstreamRefs('b', nodes, edges)
    const resolved = resolveTokens('greeting: {{node:a}}', previewMap(upstream))
    expect(resolved).toBe('greeting: hello world')
  })
})
