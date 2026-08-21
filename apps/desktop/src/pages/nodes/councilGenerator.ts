// apps/desktop/src/pages/nodes/councilGenerator.ts
//
// "Council" generator — builds a fan-out deliberation graph:
//
//        ┌─ Skeptic ─┐
//   Prompt ─┼─ Pragmatist ─┼─ Synthesis (final)
//        └─ Critic ──┘
//
// One prompt/decision SOURCE agent fans out to three persona agents (Skeptic /
// Pragmatist / Critic), each of which feeds a single Synthesis agent marked
// final:true. Edges are auto-routed with the same nearestHandlePair + APPROX
// logic the rest of the canvas uses, so wires land on sensible handles.
//
// Pure data builder (no React) so it's trivially testable and reusable.

import { nearestHandlePair, APPROX_NODE_RECT } from './canvas/EightHandles'
import type { TachiNode, TachiEdge } from './types'

// Layout: a horizontal column of personas in the middle, source on the left,
// synthesis on the right. Keeps the fan-out readable without auto-layout.
const SOURCE_X = 60
const PERSONA_X = 420
const SYNTH_X = 820
const TOP_Y = 80
const ROW_GAP = 200

interface Persona {
  key: string
  label: string
  prompt: string
}

const PERSONAS: Persona[] = [
  {
    key: 'skeptic',
    label: 'Skeptic',
    prompt:
      'You are the Skeptic. Stress-test the proposal: surface hidden assumptions, ' +
      'failure modes, and unanswered questions. Be rigorous and specific, not cynical.',
  },
  {
    key: 'pragmatist',
    label: 'Pragmatist',
    prompt:
      'You are the Pragmatist. Focus on what is actually feasible: cost, effort, ' +
      'timeline, and the simplest path that works. Cut scope where it earns its keep.',
  },
  {
    key: 'critic',
    label: 'Critic',
    prompt:
      'You are the Critic. Judge quality and coherence: where the idea is weak, ' +
      'inconsistent, or could be sharper. Give concrete, actionable critique.',
  },
]

function routeEdge(id: string, src: TachiNode, tgt: TachiNode, instruction?: string): TachiEdge {
  const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const tRect = { x: tgt.position.x, y: tgt.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const { sourceHandle, targetHandle } = nearestHandlePair(sRect, tRect)
  return {
    id,
    source: src.id,
    target: tgt.id,
    sourceHandle,
    targetHandle,
    type: 'link',
    ...(instruction ? { data: { instruction } } : { data: {} }),
  }
}

/**
 * Build the council fan-out. Returns nodes + edges ready to splice onto the
 * canvas (e.g. via setNodes([...nodes, ...council.nodes])).
 */
export function buildCouncilGraph(): { nodes: TachiNode[]; edges: TachiEdge[] } {
  const ts = Date.now()
  const midY = TOP_Y + ROW_GAP // center the source/synthesis on the middle persona row

  const source: TachiNode = {
    id: `council-${ts}-source`,
    type: 'agent',
    position: { x: SOURCE_X, y: midY },
    data: {
      label: 'Proposal',
      harnessId: 'openclaude',
      systemPrompt:
        'You frame the decision. Restate the question or proposal clearly and lay out ' +
        'the options on the table for the council to deliberate.',
    },
  } as TachiNode

  const personaNodes: TachiNode[] = PERSONAS.map((p, i) => ({
    id: `council-${ts}-${p.key}`,
    type: 'agent',
    position: { x: PERSONA_X, y: TOP_Y + i * ROW_GAP },
    data: { label: p.label, harnessId: 'openclaude', systemPrompt: p.prompt },
  } as TachiNode))

  const synthesis: TachiNode = {
    id: `council-${ts}-synthesis`,
    type: 'agent',
    position: { x: SYNTH_X, y: midY },
    data: {
      label: 'Synthesis',
      harnessId: 'openclaude',
      final: true,
      systemPrompt:
        'You are the Synthesizer. Read the Skeptic, Pragmatist, and Critic above and ' +
        'weigh their points. Produce one balanced recommendation with the reasoning ' +
        'and the key trade-offs that decided it.',
    },
  } as TachiNode

  const nodes = [source, ...personaNodes, synthesis]

  const edges: TachiEdge[] = []
  for (const persona of personaNodes) {
    edges.push(routeEdge(`council-e-${ts}-in-${persona.id}`, source, persona, 'consider'))
    edges.push(routeEdge(`council-e-${ts}-out-${persona.id}`, persona, synthesis, 'synthesize'))
  }

  return { nodes, edges }
}
