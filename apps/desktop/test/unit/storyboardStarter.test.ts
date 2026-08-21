// apps/desktop/test/unit/storyboardStarter.test.ts
//
// THE STORYBOARD STARTER — the FLF chaining technique as a graph you can open.
//
// WORKFLOWS-RESEARCH-2026-07-28 §3.1 names it as the deliverable of the canvas-
// chains work: "a 'storyboard' starter template (text → prompt-agent →
// media(image) → media(i2v video))". The DELTA ADDENDUM ("FLF CHAINING") then
// extends it by one hop: the first scene's LAST FRAME starts the second scene,
// which is what turns a single clip into a chain.
//
// A starter is a PROMISE — it opens as a working graph or it is worse than
// nothing. So the shape is pinned here, not eyeballed:
//
//  • the wires exist AND land on the right plugs (an init-frame handoff on the
//    `image` plug, not the prompt plug — a media node renders TYPED plugs, and
//    a wire onto the wrong one silently feeds nothing);
//  • it runs in the order it reads (still → scene 1 → scene 2) under the same
//    topological sort Run-all uses;
//  • every segment obeys the ≤81-frame policy the flow-doctor enforces — a
//    starter that trips the app's own warning on open is a self-own;
//  • the description tells the truth about what chaining costs.

import { describe, it, expect } from 'vitest'
import { STARTER_TEMPLATES, type StarterTemplate } from '../../src/pages/nodes/starterTemplates'
import { analyzeFlow } from '../../src/pages/nodes/flow-doctor'
import { topoOrder } from '../../src/pages/nodes/canvas/topo-order'
import { requestedWanFrames } from '../../src/pages/media/localGenParams'

const storyboard = (): StarterTemplate => {
  const t = STARTER_TEMPLATES.find(x => x.id === 'storyboard')
  expect(t, 'no "storyboard" starter is registered').toBeTruthy()
  return t!
}

const nodesOfType = (t: StarterTemplate, type: string) => t.nodes.filter(n => n.type === type)
const byId = (t: StarterTemplate, id: string) => t.nodes.find(n => n.id === id)

describe('the storyboard starter is registered like every other one', () => {
  it('carries the fields the template menu renders', () => {
    const t = storyboard()
    expect(t.label.length).toBeGreaterThan(0)
    expect(t.name.length).toBeGreaterThan(0)
    expect(t.description.length).toBeGreaterThan(0)
  })

  it('has unique node ids and edges that both ends exist for', () => {
    const t = storyboard()
    const ids = t.nodes.map(n => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    const idSet = new Set(ids)
    for (const e of t.edges) {
      expect(idSet.has(e.source), `edge ${e.id} sources a node that isn't there`).toBe(true)
      expect(idSet.has(e.target), `edge ${e.id} targets a node that isn't there`).toBe(true)
    }
    expect(new Set(t.edges.map(e => e.id)).size).toBe(t.edges.length)
  })

  it('does not collide with another starter\'s ids', () => {
    const mine = new Set(storyboard().nodes.map(n => n.id))
    const others = STARTER_TEMPLATES.filter(t => t.id !== 'storyboard').flatMap(t => t.nodes.map(n => n.id))
    for (const id of others) expect(mine.has(id)).toBe(false)
  })
})

describe('the §3.1 shape: text → prompt → image → video', () => {
  it('opens with a text node the user types their premise into', () => {
    const t = storyboard()
    const texts = nodesOfType(t, 'text')
    expect(texts).toHaveLength(1)
    expect(typeof (texts[0]!.data as { text?: unknown }).text).toBe('string')
  })

  it('has prompt nodes that author each scene, and they are free to run', () => {
    const t = storyboard()
    const prompts = nodesOfType(t, 'prompt')
    expect(prompts.length).toBeGreaterThanOrEqual(3) // still + one per segment
    for (const p of prompts) {
      expect((p.data as { providerId?: string }).providerId).toBe('freellmapi')
      expect(String((p.data as { instruction?: string }).instruction ?? '').length).toBeGreaterThan(0)
    }
  })

  it('generates ONE still and TWO chained video segments', () => {
    const t = storyboard()
    const mediaNodes = nodesOfType(t, 'media')
    const modalities = mediaNodes.map(n => (n.data as { modality?: string }).modality)
    expect(modalities.filter(m => m === 'image')).toHaveLength(1)
    expect(modalities.filter(m => m === 'video')).toHaveLength(2)
  })

  it('every media node targets the LOCAL engine — this is the low-VRAM technique', () => {
    for (const n of nodesOfType(storyboard(), 'media')) {
      expect((n.data as { provider?: string }).provider).toBe('local')
    }
  })

  it('each media node is fed by a prompt node on the PROMPT plug', () => {
    const t = storyboard()
    for (const m of nodesOfType(t, 'media')) {
      const feeder = t.edges.find(e => e.target === m.id && e.targetHandle === 'prompt')
      expect(feeder, `media node ${m.id} has no prompt feeder`).toBeTruthy()
      expect(byId(t, feeder!.source)!.type).toBe('prompt')
    }
  })
})

describe('the handoffs — the whole point of the template', () => {
  it('the still feeds segment 1 on the IMAGE plug (the i2v init frame)', () => {
    const t = storyboard()
    const still = nodesOfType(t, 'media').find(n => (n.data as { modality?: string }).modality === 'image')!
    const wire = t.edges.find(e => e.source === still.id && e.targetHandle === 'image')
    expect(wire, 'the still is not wired into anything as an init frame').toBeTruthy()
    expect((byId(t, wire!.target)!.data as { modality?: string }).modality).toBe('video')
  })

  it('segment 1 feeds segment 2 on the IMAGE plug — the last-frame hop', () => {
    const t = storyboard()
    const videos = nodesOfType(t, 'media').filter(n => (n.data as { modality?: string }).modality === 'video')
    const hop = t.edges.find(e => videos.some(v => v.id === e.source) && videos.some(v => v.id === e.target))
    expect(hop, 'no video → video wire: the chain is one scene long').toBeTruthy()
    expect(hop!.targetHandle, 'the hop must land on the image plug, not the prompt plug').toBe('image')
  })

  it('runs still → segment 1 → segment 2 under Run-all\'s own topological sort', () => {
    const t = storyboard()
    const rank = new Map(topoOrder(t.nodes, t.edges).map((id, i) => [id, i] as const))
    const media = nodesOfType(t, 'media').sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    expect(media.map(n => (n.data as { modality?: string }).modality)).toEqual(['image', 'video', 'video'])
  })

  it('is acyclic — a chain, never a loop', () => {
    const t = storyboard()
    expect(topoOrder(t.nodes, t.edges)).toHaveLength(t.nodes.length)
  })
})

describe('the segment-length policy is baked in, not left to luck', () => {
  it('every video segment asks for at most 81 frames', () => {
    for (const v of nodesOfType(storyboard(), 'media')) {
      if ((v.data as { modality?: string }).modality !== 'video') continue
      const params = ((v.data as { params?: Record<string, unknown> }).params ?? {})
      const asked = requestedWanFrames(params)
      expect(asked, `segment ${v.id} carries no explicit length`).not.toBeNull()
      expect(asked!).toBeLessThanOrEqual(81)
    }
  })

  it('and the flow-doctor finds nothing to complain about on open', () => {
    const t = storyboard()
    // Local media needs no key; the free router needs no key. A fully-unknown
    // env is the harshest honest case (every env-dependent check fails open).
    expect(analyzeFlow(t.nodes, t.edges, {})).toEqual([])
  })

  it('every segment carries its OWN seed slot or none at all — never a shared one', () => {
    // sd.cpp's default seed is a fixed 42; two segments pinned to the SAME
    // explicit seed would be correlated by construction. Run-all derives per
    // stage when none is set, so "none" is the correct template value.
    const seeds = nodesOfType(storyboard(), 'media')
      .map(n => ((n.data as { params?: Record<string, unknown> }).params ?? {}).seed)
      .filter(s => typeof s === 'number')
    expect(new Set(seeds).size).toBe(seeds.length)
  })
})

describe('the description is honest about what chaining costs', () => {
  const d = () => storyboard().description.toLowerCase()

  it('names the technique in scenes, not in minutes of movie', () => {
    expect(d()).toMatch(/scene/)
    // "a 4-minute movie" is the promise the addendum forbids: 4 min ≈ 48
    // chained segments ≈ hours of wall-clock on an 8 GB tier.
    expect(d()).not.toMatch(/\bmovie\b/)
    expect(d()).not.toMatch(/\d+\s*-?\s*minute (film|movie)/)
  })

  it('warns that quality drifts across hops', () => {
    expect(d()).toMatch(/drift|degrad|accumulat/)
  })

  it('warns that each scene is its own render', () => {
    expect(d()).toMatch(/each scene|per scene|every scene/)
  })
})
