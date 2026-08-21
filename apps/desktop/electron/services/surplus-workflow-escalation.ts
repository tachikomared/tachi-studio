// apps/desktop/electron/services/surplus-workflow-escalation.ts
//
// Phase 3 of the Surplus smart router: a genuinely HARD + agentic task is run as
// a minimal agent-kit "plan-then-execute" network instead of a single model.
// It reuses the EXISTING graph compiler/runner (graph-to-agentkit) — no new
// engine code — by building a tiny TachiFlow in code and running it.
//
// The network returns a single final string (no token stream), which the chat
// path splices into the reply. Conservative by design: the caller only invokes
// this when the request is hard AND multi-step/agentic AND the user opted in.

import { compileGraph } from './graph-to-agentkit'
import { listSurplusModels } from './surplus-service'
import { routeSurplus } from './surplus-router'
import type { TachiFlow, TachiNode, TachiEdge } from '../../src/pages/nodes/types'

/** Flatten an AgentResult.output array into a single string (mirrors graph.ipc). */
function flattenOutput(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const m of output) {
    if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'text') {
      const content = (m as { content?: unknown }).content
      if (typeof content === 'string') parts.push(content)
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
            parts.push((c as { text: string }).text)
          }
        }
      }
    }
  }
  return parts.join('\n')
}

/**
 * Run the hard task as a minimal Surplus-backed agent-kit network and return the
 * final answer text. The provider node is pinned to a tool-capable TOP model
 * (cheap/free models can't drive multi-step reliably). Never returns empty —
 * falls back to a marker string. Throws only on a hard compile/run failure (the
 * caller catches and surfaces it).
 */
export async function runSurplusWorkflow(
  userInput: string,
  system: string | undefined,
  surplusApiKey: string,
): Promise<string> {
  const catalogIds = (await listSurplusModels()).models.map(m => m.id)
  // Pin a tool-capable, top-tier Surplus model for the workflow's provider.
  const model = routeSurplus({ message: userInput, tools: true }, catalogIds).primary

  const planner =
    'You are a senior problem-solver running as a focused workflow. Decompose the ' +
    'task into clear steps, work through each carefully, then synthesize ONE complete, ' +
    'correct answer. Be rigorous and concise; do not ask clarifying questions.'

  const nodes: TachiNode[] = [
    { id: 'prov', type: 'provider', position: { x: 0, y: 0 },
      data: { label: 'Surplus', providerId: 'surplus', model } } as TachiNode,
    { id: 'planner', type: 'agent', position: { x: 320, y: 0 },
      data: {
        label: 'Planner', harnessId: 'openclaude', final: true,
        systemPrompt: system ? `${planner}\n\nContext:\n${system}` : planner,
      } } as TachiNode,
  ]
  const edges: TachiEdge[] = [
    { id: 'e1', source: 'prov', target: 'planner', type: 'link', data: {} },
  ]
  const flow: TachiFlow = {
    version: 1,
    name: 'surplus-smart-escalation',
    nodes,
    edges,
    savedAt: new Date().toISOString(),
  }

  const compiled = compileGraph(flow, { surplusApiKey, disableTools: false, maxIter: 12 })
  await compiled.network.run(userInput, { state: compiled.state })

  const rawResults =
    (compiled.state as unknown as { results?: Array<{ agentName: string; output: unknown }> }).results ?? []
  let final = ''
  for (const r of rawResults) {
    const t = flattenOutput(r.output)
    if (t.trim()) final = t
  }
  return final || '[workflow produced no output]'
}
