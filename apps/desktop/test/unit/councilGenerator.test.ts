// apps/desktop/test/unit/councilGenerator.test.ts
import { describe, it, expect } from 'vitest'
import { buildCouncilGraph } from '../../src/pages/nodes/councilGenerator'

describe('buildCouncilGraph', () => {
  it('builds a 5-node fan-out: source -> 3 personas -> synthesis', () => {
    const { nodes } = buildCouncilGraph()
    expect(nodes).toHaveLength(5)
    expect(nodes.every(n => n.type === 'agent')).toBe(true)
    expect(nodes.every(n => (n.data as { harnessId?: string }).harnessId === 'openclaude')).toBe(true)

    const labels = nodes.map(n => (n.data as { label?: string }).label)
    expect(labels).toContain('Skeptic')
    expect(labels).toContain('Pragmatist')
    expect(labels).toContain('Critic')
  })

  it('marks exactly one node final (the synthesis)', () => {
    const { nodes } = buildCouncilGraph()
    const finals = nodes.filter(n => (n.data as { final?: boolean }).final === true)
    expect(finals).toHaveLength(1)
    expect((finals[0].data as { label?: string }).label).toBe('Synthesis')
  })

  it('wires 6 edges (3 in + 3 out) with resolved handles', () => {
    const { nodes, edges } = buildCouncilGraph()
    expect(edges).toHaveLength(6)
    expect(edges.every(e => e.source && e.target && e.sourceHandle && e.targetHandle)).toBe(true)

    const source = nodes.find(n => (n.data as { label?: string }).label === 'Proposal')!
    const synthesis = nodes.find(n => (n.data as { label?: string }).label === 'Synthesis')!
    // 3 edges fan OUT of the source; 3 edges fan INTO the synthesis.
    expect(edges.filter(e => e.source === source.id)).toHaveLength(3)
    expect(edges.filter(e => e.target === synthesis.id)).toHaveLength(3)
    // no edge directly connects source -> synthesis (deliberation goes via personas)
    expect(edges.some(e => e.source === source.id && e.target === synthesis.id)).toBe(false)
  })

  it('labels edges with consider (in) and synthesize (out) instructions', () => {
    const { edges } = buildCouncilGraph()
    const instructions = edges.map(e => (e.data as { instruction?: string })?.instruction)
    expect(instructions.filter(i => i === 'consider')).toHaveLength(3)
    expect(instructions.filter(i => i === 'synthesize')).toHaveLength(3)
  })
})
