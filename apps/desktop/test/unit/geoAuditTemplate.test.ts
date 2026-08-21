// apps/desktop/test/unit/geoAuditTemplate.test.ts
//
// BATCH35 lane B — the GEO-audit starter template.
//
// tachiflowPortability.test.ts already checks what EVERY template must satisfy
// (valid envelope, unique ids, resolvable edges, a provider per agent, gallery
// parity). This file pins the promises specific to THIS one, and they are the
// promises that make it usable rather than a demo:
//
//   · PROVIDER-AGNOSTIC — one provider node, no tool nodes, no media nodes. It
//     therefore runs on the bundled free router with no key AND on any other
//     provider by swapping that single node. A web-fetch tool would have pinned
//     it to a tool-capable (paid) model, which is why the page is PASTED.
//   · END-TO-END       — a linear agent chain from the inputs to exactly one
//     `final` node, so both Run-flow (one path) and Run-all (topological) reach
//     a report card.
//   · REPORT CARD      — the last step actually emits a graded card, which is
//     the deliverable the brief asked for.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { geoAudit } from '../../src/pages/nodes/templates/geoAudit'
import { FLOW_TEMPLATES, STARTER_CARD_TEMPLATES } from '../../src/pages/nodes/templates'
import { remapFlowIds } from '../../src/pages/nodes/templates/tachiflow'
import { KNOWN_NODE_TYPES } from '../../src/pages/nodes/serialization'

const APP = path.resolve(__dirname, '../..')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
const { flow } = geoAudit.file

const byId = (id: string) => flow.nodes.find(n => n.id === id)
const typed = (t: string) => flow.nodes.filter(n => n.type === t)
const dataOf = (id: string) => (byId(id)?.data ?? {}) as Record<string, unknown>

describe('GEO audit template · shipped and reachable', () => {
  it('is in the rail without displacing the three starter cards', () => {
    expect(FLOW_TEMPLATES.map(t => t.id)).toContain('geo-audit')
    expect(STARTER_CARD_TEMPLATES).toHaveLength(3)
    expect(STARTER_CARD_TEMPLATES.map(t => t.id)).not.toContain('geo-audit')
  })

  it('every node type it uses is one this build renders', () => {
    for (const n of flow.nodes) expect(KNOWN_NODE_TYPES.has(n.type), n.type).toBe(true)
  })

  it('instantiating it twice never shares ids (canvas Undo safety)', () => {
    const a = remapFlowIds(flow.nodes, flow.edges)
    const b = remapFlowIds(flow.nodes, flow.edges)
    const aIds = new Set(a.nodes.map(n => n.id))
    for (const n of b.nodes) expect(aIds.has(n.id)).toBe(false)
    expect(a.edges).toHaveLength(flow.edges.length)
  })
})

describe('GEO audit template · provider-agnostic by construction', () => {
  it('has exactly ONE provider node — swap it and the whole flow moves', () => {
    const providers = typed('provider')
    expect(providers).toHaveLength(1)
    expect(providers[0]!.id).toBe('geo-prov')
  })

  it('defaults to the free router, so it runs with no key at all', () => {
    const d = dataOf('geo-prov')
    expect(d.providerId).toBe('freellmapi')
    expect(d.model).toBe('auto')
  })

  it('needs no tool-capable model: no internet / mcp / folder / media / skill nodes', () => {
    for (const t of ['internet', 'mcp', 'folder', 'media', 'skill', 'imageref']) {
      expect(typed(t), `${t} node would pin this template to a specific provider`).toHaveLength(0)
    }
  })

  it('every agent draws its model from that one provider', () => {
    const agents = typed('agent')
    expect(agents.length).toBeGreaterThanOrEqual(4)
    for (const a of agents) {
      const fed = flow.edges.filter(e => e.target === a.id && e.source === 'geo-prov')
      expect(fed.length, `agent ${a.id} needs the provider edge`).toBe(1)
      expect((a.data as { harnessId?: string }).harnessId).toBe('openclaude')
    }
  })

  it('names no provider, model or vendor in any prompt (that is the provider node’s job)', () => {
    const prompts = typed('agent')
      .map(a => String((a.data as { systemPrompt?: string }).systemPrompt ?? ''))
      .join('\n')
      .toLowerCase()
    for (const vendor of ['bankr', 'openai', 'gpt-', 'claude', 'anthropic', 'surplus', 'opengateway', 'ollama']) {
      expect(prompts.includes(vendor), `prompt mentions ${vendor}`).toBe(false)
    }
  })
})

describe('GEO audit template · the flow actually runs end to end', () => {
  it('takes the URL/content and the target prompts as static Text inputs', () => {
    const texts = typed('text')
    expect(texts.map(n => n.id).sort()).toEqual(['geo-page', 'geo-queries'])
    for (const n of texts) {
      const d = n.data as { text?: string; lastOutput?: string }
      expect(d.text && d.text.length).toBeGreaterThan(0)
      // Text nodes resolve downstream through `lastOutput`, so the mirror must
      // be present or the first agent starts with an empty brief.
      expect(d.lastOutput).toBe(d.text)
    }
    // The page input carries a URL placeholder — that is the "URL/content" input.
    expect(String(dataOf('geo-page').text)).toMatch(/https?:\/\//)
  })

  it('feeds both inputs into the chain', () => {
    expect(flow.edges.some(e => e.source === 'geo-page' && e.target === 'geo-inventory')).toBe(true)
    expect(flow.edges.some(e => e.source === 'geo-queries' && e.target === 'geo-simulate')).toBe(true)
  })

  it('chains the analysis agents linearly: inventory → simulation → recommendations → report', () => {
    const chain = ['geo-inventory', 'geo-simulate', 'geo-recommend', 'geo-report']
    for (const id of chain) expect(byId(id)?.type, id).toBe('agent')
    for (let i = 0; i < chain.length - 1; i++) {
      const e = flow.edges.find(x => x.source === chain[i] && x.target === chain[i + 1])
      expect(e, `${chain[i]} → ${chain[i + 1]}`).toBeTruthy()
      expect((e!.data as { instruction?: string }).instruction).toBeTruthy()
    }
    // LINEAR: no agent forks to a second agent, so the single-path graph router
    // reaches the report card on a full Run-flow too.
    const agentIds = new Set(typed('agent').map(n => n.id))
    for (const id of agentIds) {
      const outToAgents = flow.edges.filter(e => e.source === id && agentIds.has(e.target))
      expect(outToAgents.length, `${id} forks`).toBeLessThanOrEqual(1)
    }
  })

  it('ends on exactly one final node, and that node is the report card', () => {
    const finals = flow.nodes.filter(n => (n.data as { final?: boolean }).final === true)
    expect(finals).toHaveLength(1)
    expect(finals[0]!.id).toBe('geo-report')
    const prompt = String(dataOf('geo-report').systemPrompt).toLowerCase()
    // A "report card" that does not grade is just another summary.
    expect(prompt).toContain('grade')
    expect(prompt).toMatch(/\ba-f\b/)
    expect(prompt).toContain('top 3 actions')
  })

  it('the simulation is grounded — it may only use what the page says', () => {
    const inventory = String(dataOf('geo-inventory').systemPrompt).toLowerCase()
    const simulate  = String(dataOf('geo-simulate').systemPrompt).toLowerCase()
    expect(inventory).toContain('invent nothing')
    expect(simulate).toContain('cite')
    expect(simulate).toMatch(/only|nothing but/)
  })

  it('recommendations are structured, not prose', () => {
    const rec = String(dataOf('geo-recommend').systemPrompt)
    for (const bucket of ['QUOTABILITY', 'COVERAGE', 'EVIDENCE', 'STRUCTURE', 'ENTITY']) {
      expect(rec, bucket).toContain(bucket)
    }
    expect(rec.toLowerCase()).toContain('effort')
    expect(rec.toLowerCase()).toContain('impact')
  })

  it('nothing in the template auto-runs or reaches a tool', () => {
    const src = fs.readFileSync(path.join(APP, 'src/pages/nodes/templates/geoAudit.ts'), 'utf8')
    expect(src).not.toContain('allowedTools')
    expect(src).not.toContain('autoRun')
    expect(src).not.toContain('codexAllowWrite')
  })
})

describe('GEO audit template · gallery + i18n', () => {
  it('the shareable gallery copy exists and mirrors the module', () => {
    const raw = fs.readFileSync(path.resolve(APP, '../../examples/flows/geo-audit.tachiflow.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(geoAudit.file)))
  })

  it('is listed in the gallery README', () => {
    const readme = fs.readFileSync(path.resolve(APP, '../../examples/flows/README.md'), 'utf8')
    expect(readme).toContain('geo-audit.tachiflow.json')
  })

  it('has a translated label + description in all 8 locales', () => {
    for (const lang of LANGS) {
      const ns = JSON.parse(fs.readFileSync(path.join(APP, `src/i18n/locales/${lang}/nodes.json`), 'utf8'))
      const item = ns?.templatesRail?.items?.['geo-audit']
      expect(item, lang).toBeTruthy()
      expect(typeof item.label === 'string' && item.label.trim().length, lang).toBeGreaterThan(0)
      expect(typeof item.description === 'string' && item.description.trim().length, lang).toBeGreaterThan(0)
    }
  })
})
