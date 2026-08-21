// apps/desktop/test/unit/rifeNode.test.ts
//
// THE RIFE NODE ON THE CANVAS — the nodes-tab half of the frame-interpolation
// vertical that 48381ca shipped for the gallery only.
//
// The standing product rule is that every feature is ALSO a node, and a
// post-process node is a shape the canvas has never had before: it consumes an
// ARTIFACT rather than a prompt, and the artifact it consumes is the one thing
// the FLF hop deliberately refuses to hand over whole (that hop decodes a clip's
// LAST FRAME — a rife node needs the CLIP).
//
// So the load-bearing claims pinned here are:
//
//  1. REGISTRATION IS COMPLETE. A node type that is registered in four of the
//     five places is worse than absent: sanitizeFlow silently rewrites it to
//     'unknown' on the next load and the user's wiring is gone. Every seam is
//     asserted — union, canvas registry, palette, drag colours, KNOWN_NODE_TYPES,
//     RUNNABLE_NODE_TYPES.
//  2. THE STAGE RECEIVES THIS RUN'S CLIP. Same contract mediaChainOrder pins for
//     the image handoff, asserted on the path that reaches interpolateVideo —
//     not on "a video appeared".
//  3. THE MULTIPLIER THAT REACHES THE SIDECAR IS THE ONE ON THE NODE. x4 is one
//     pass with -n (rife-plan), so a node set to x4 must not silently run x2.
//  4. THE LAST FRAME HOP IS NOT IN THE WAY. A rife node takes the whole video;
//     a media node fed BY a rife node still gets a frame.
//  5. THE DOCTOR WARNS, NEVER BLOCKS. Two honest rows (no video wired, engine
//     missing) and fail-open everywhere else.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const read = (p: string) => readFileSync(join(DESKTOP, p), 'utf8')

const TEMPS = vi.hoisted(() => [] as string[])
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  TEMPS.push(d)
  return d
}
afterAll(() => {
  for (const d of TEMPS) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } }
})

// hoisted: the media service chain reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  const d = mk(j(td(), 'tachi-rifenode-'))
  TEMPS.push(d)
  return d
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => String(b),
  },
}))

// ── the local image/video engine, stubbed at the seam graph-to-agentkit calls ──
interface SdCall { modelId: string; prompt: string; seed?: number; initImagePath?: string; initBytes?: string }
const sd = vi.hoisted(() => ({
  order: [] as string[],
  image: [] as SdCall[],
  video: [] as SdCall[],
  output: new Map<string, string>(),
  fail: new Set<string>(),
}))

vi.mock('../../electron/services/sd-cpp-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  const p = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'tachi-rifenode-out-'))
  TEMPS.push(dir)
  let seq = 0
  const record = (bucket: SdCall[], mime: string, ext: string) => async (input: SdCall) => {
    sd.order.push(input.modelId)
    bucket.push({
      ...input,
      initBytes: input.initImagePath ? fs.readFileSync(input.initImagePath).toString('utf8') : undefined,
    })
    if (sd.fail.has(input.modelId)) throw new Error(`engine refused ${input.modelId}`)
    const path = p.join(dir, `${input.modelId}-${seq++}.${ext}`)
    fs.writeFileSync(path, sd.output.get(input.modelId) ?? `bytes-of-${input.modelId}`)
    return { mime, path }
  }
  return {
    generateImage: vi.fn(record(sd.image, 'image/png', 'png')),
    generateVideo: vi.fn(record(sd.video, 'video/mp4', 'mp4')),
  }
})

// ── the RIFE sidecar, stubbed at ITS seam ─────────────────────────────────────
// The pipeline's own contract (argv, fps arithmetic, temp cleanup, cancel) is
// pinned by rifePlan/rifeRunner.test.ts against a fake ffmpeg. What THIS file
// pins is the WIRING: which clip reaches it, with which multiplier, and what the
// canvas does with what comes back.
interface RifeCall { sourcePath: string; multiplier?: number; sourceBytes?: string }
const rife = vi.hoisted(() => ({
  calls: [] as RifeCall[],
  /** false → the run fails (engine missing, ffmpeg gone, a cancel). */
  ok: true,
  error: 'the engine said no',
  cancelled: false,
}))

vi.mock('../../electron/services/rife-runner', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  const p = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'tachi-rifenode-interp-'))
  TEMPS.push(dir)
  let seq = 0
  return {
    interpolateVideo: vi.fn(async (input: { sourcePath: string; multiplier?: number }) => {
      let sourceBytes: string | undefined
      try { sourceBytes = fs.readFileSync(input.sourcePath).toString('utf8') } catch { sourceBytes = undefined }
      rife.calls.push({ sourcePath: input.sourcePath, multiplier: input.multiplier, sourceBytes })
      if (!rife.ok) return { ok: false, error: rife.error, ...(rife.cancelled ? { cancelled: true } : {}) }
      const name = input.sourcePath.split(/[\\/]/).pop() ?? 'clip'
      const outputPath = p.join(dir, `${name}-rife${input.multiplier ?? 2}x-${seq++}.mp4`)
      fs.writeFileSync(outputPath, `INTERPOLATED(${sourceBytes ?? name})`)
      return { ok: true, outputPath }
    }),
    cancelRifeRun: vi.fn(() => true),
    activeRifeRuns: vi.fn(() => [] as string[]),
  }
})

// ── the FLF last-frame hop, stubbed at ITS seam ───────────────────────────────
const lastFrame = vi.hoisted(() => ({ calls: [] as string[], enabled: true }))
vi.mock('../../electron/services/video-last-frame', () => ({
  lastFrameDataUrl: vi.fn(async (videoPath: string) => {
    lastFrame.calls.push(videoPath)
    if (!lastFrame.enabled) return null
    const name = videoPath.split(/[\\/]/).pop() ?? videoPath
    return `data:image/png;base64,${Buffer.from(`LASTFRAME-OF-${name}`).toString('base64')}`
  }),
}))

import { runMediaPhase, runRifeNode } from '../../electron/services/graph-to-agentkit'
import {
  RIFE_NODE_MULTIPLIERS,
  hasVideoCapableUpstream,
  nextRifeMultiplier,
  resolveRifeMultiplier,
  rifeNodeState,
  rifeSourcePath,
  wiredVideoPathsInto,
} from '../../src/pages/nodes/rifeNode'
import { KNOWN_NODE_TYPES } from '../../src/pages/nodes/serialization'
import { RUNNABLE_NODE_TYPES, isRunnableType } from '../../src/pages/nodes/run-eligibility'
import { paletteCategoryColor } from '../../src/pages/nodes/sidebar/paletteDrag'
import { analyzeFlow } from '../../src/pages/nodes/flow-doctor'
import type { TachiEdge, TachiFlow, TachiNode, TachiRifeNode } from '../../src/pages/nodes/types'

// ── tiny flow builders ────────────────────────────────────────────────────────

let y = 0
function mediaNode(id: string, modality: 'image' | 'video', model: string): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: (y += 60) },
    data: { label: id, modality, provider: 'local', model, prompt: `prompt for ${id}`, params: {} },
  } as TachiNode
}

function rifeNode(id: string, multiplier?: 2 | 4): TachiNode {
  return {
    id, type: 'rife', position: { x: 0, y: (y += 60) },
    data: { label: id, ...(multiplier !== undefined ? { multiplier } : {}) },
  } as TachiNode
}

function outputCard(id: string, sourceId: string, artifacts?: unknown[]): TachiNode {
  return {
    id, type: 'output', position: { x: 0, y: (y += 60) },
    data: { label: `${sourceId} output`, auto: true, kind: 'media', sourceId, artifacts },
  } as TachiNode
}

const edge = (source: string, target: string, targetHandle = 'video'): TachiEdge =>
  ({ id: `${source}->${target}`, source, target, sourceHandle: 'out', targetHandle, type: 'link' } as TachiEdge)

/** An edge into a media node's `image` plug (init-frame / img2img handoff). */
const imageEdge = (source: string, target: string): TachiEdge => edge(source, target, 'image')

const flowOf = (nodes: TachiNode[], edges: TachiEdge[]): TachiFlow =>
  ({ name: 'rife-chain', nodes, edges } as TachiFlow)

function onDisk(bytes: string, name = 'clip.mp4'): string {
  const p = join(tempDir('tachi-rifenode-src-'), name)
  writeFileSync(p, bytes)
  return p
}

beforeEach(() => {
  sd.order.length = 0; sd.image.length = 0; sd.video.length = 0
  sd.output.clear(); sd.fail.clear()
  rife.calls.length = 0; rife.ok = true; rife.cancelled = false; rife.error = 'the engine said no'
  lastFrame.calls.length = 0; lastFrame.enabled = true
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. REGISTRATION — every seam, because four out of five silently deletes work
// ═════════════════════════════════════════════════════════════════════════════

describe('the rife node is registered everywhere a node type has to be', () => {
  it('is a KNOWN node type — so a saved flow does not reload as "unknown"', () => {
    expect(KNOWN_NODE_TYPES.has('rife')).toBe(true)
  })

  it('survives a load round-trip with its data intact', async () => {
    const { sanitizeFlow } = await import('../../src/pages/nodes/serialization')
    const healed = sanitizeFlow(flowOf([rifeNode('r1', 4)], []))
    expect(healed.nodes[0]!.type).toBe('rife')
    expect((healed.nodes[0]!.data as { multiplier?: number }).multiplier).toBe(4)
    expect((healed.nodes[0]!.data as { originalType?: string }).originalType).toBeUndefined()
  })

  it('RUNS — it is in RUNNABLE_NODE_TYPES (Run-all must not skip it)', () => {
    expect(isRunnableType('rife')).toBe(true)
    expect([...RUNNABLE_NODE_TYPES]).toContain('rife')
    // and the types that were never runnable still are not
    expect(isRunnableType('note')).toBe(false)
    expect(isRunnableType('webhook')).toBe(false)
  })

  it('is declared in the node union AND the palette type list', () => {
    const types = read('src/pages/nodes/types.ts')
    expect(types).toContain("export type TachiRifeNode")
    expect(types).toMatch(/Node<RifeNodeData,\s*'rife'>/)
    expect(types).toContain('| TachiRifeNode')
    expect(types).toMatch(/PaletteNodeType\s*=[^\n]*'rife'/)
  })

  it('is registered on the canvas and drawn on the minimap', () => {
    const canvas = read('src/pages/nodes/canvas/FlowCanvas.tsx')
    expect(canvas).toContain("import { RifeNode }")
    expect(canvas).toMatch(/\n\s*rife:\s*React\.memo\(RifeNode\)/)
    expect(canvas).toMatch(/node\.type === 'rife'/)
  })

  it('is offered by the palette (drag AND click-to-insert both read one list)', () => {
    const palette = read('src/pages/nodes/sidebar/NodePalette.tsx')
    expect(palette).toMatch(/type: 'rife'/)
    // and the filtered re-grouping actually renders it — a template nobody
    // filters into a group is invisible in the sidebar.
    expect(palette).toMatch(/t\.type === 'rife'/)
  })

  it('is coloured as part of the MEDIA family, by an explicit entry', () => {
    // A post-process step of the media vertical — it deliberately shares that
    // accent rather than inventing a category. Registered explicitly all the
    // same: the unknown-type fallback happens to be the same colour, so only
    // the map itself can tell "chosen" from "fell through".
    expect(paletteCategoryColor('rife')).toBe(paletteCategoryColor('media'))
    expect(read('src/pages/nodes/sidebar/paletteDrag.ts')).toMatch(/\n\s*rife:\s*'var\(--accent\)'/)
  })

  it('drops onto its typed plugs, not the geometric 8-handle router', () => {
    const store = read('src/pages/nodes/store/nodes.store.ts')
    expect(store).toMatch(/rife:\s*\['video'\]/)
    expect(store).toMatch(/rife:\s*\['out'\]/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE PURE CORE — multiplier, source resolution, the button's state
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveRifeMultiplier', () => {
  it('offers exactly the two the sidecar does in one pass', () => {
    expect([...RIFE_NODE_MULTIPLIERS]).toEqual([2, 4])
  })

  it('and that list is the SAME one rife-plan enforces', async () => {
    // The canvas module re-declares it rather than importing rife-plan: that
    // module's zero-egress property is asserted by walking its transitive
    // imports (rifeWiring), and dragging a renderer module into that graph would
    // put a hole in the thing being checked. THIS is the drift alarm — the
    // runner's own zod union would refuse a factor the node offered, minutes
    // into a run, and the user would see a spawn failure instead of a video.
    const { RIFE_MULTIPLIERS } = await import('../../electron/services/rife-plan')
    expect([...RIFE_NODE_MULTIPLIERS]).toEqual([...RIFE_MULTIPLIERS])
  })

  it('defaults to x2 for a node that has never been touched', () => {
    expect(resolveRifeMultiplier({})).toBe(2)
    expect(resolveRifeMultiplier(undefined)).toBe(2)
    expect(resolveRifeMultiplier(null)).toBe(2)
  })

  it('reads x2 and x4 off the node verbatim', () => {
    expect(resolveRifeMultiplier({ multiplier: 2 })).toBe(2)
    expect(resolveRifeMultiplier({ multiplier: 4 })).toBe(4)
  })

  it('refuses a value the sidecar would reject rather than passing it on', () => {
    // rife-plan's RIFE_MULTIPLIERS is the law; a hand-edited flow must degrade
    // to the safe default instead of failing the run at the spawn.
    for (const bad of [3, 8, 0, -2, 2.5, '4', NaN, Infinity]) {
      expect(resolveRifeMultiplier({ multiplier: bad }), String(bad)).toBe(2)
    }
  })

  it('cycles x2 → x4 → x2 for the on-node toggle', () => {
    expect(nextRifeMultiplier(2)).toBe(4)
    expect(nextRifeMultiplier(4)).toBe(2)
  })
})

describe('the clip a rife node interpolates', () => {
  it('is the video artifact on the media node wired into it', () => {
    const clip = onDisk('SEGMENT-ONE')
    const vid = mediaNode('vid', 'video', 'wan-a')
    ;(vid.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const flow = flowOf([vid, rifeNode('r')], [edge('vid', 'r')])
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBe(clip)
  })

  it('is also read off an Output card mirroring that result', () => {
    const clip = onDisk('CARD-CLIP')
    const flow = flowOf(
      [outputCard('card', 'vid', [{ kind: 'video', mimeType: 'video/mp4', path: clip }]), rifeNode('r')],
      [edge('card', 'r')],
    )
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBe(clip)
  })

  it('and off ANOTHER rife node — x2 then x2 again is a legal chain', () => {
    const clip = onDisk('ALREADY-SMOOTH')
    const first = rifeNode('r1')
    ;(first.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const flow = flowOf([first, rifeNode('r2')], [edge('r1', 'r2')])
    expect(rifeSourcePath('r2', flow.nodes, flow.edges)).toBe(clip)
  })

  it('is undefined when nothing is wired in', () => {
    const flow = flowOf([rifeNode('r')], [])
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBeUndefined()
  })

  it('skips an IMAGE artifact — an image is not a clip', () => {
    const img = mediaNode('img', 'image', 'sd-a')
    ;(img.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'image', mimeType: 'image/png', path: onDisk('A-PICTURE', 'p.png') }]
    const flow = flowOf([img, rifeNode('r')], [edge('img', 'r')])
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBeUndefined()
  })

  it('skips a b64-only clip: ffmpeg needs a file, and inventing one would lie', () => {
    const vid = mediaNode('vid', 'video', 'wan-a')
    ;(vid.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', b64: 'AAAA' }]
    const flow = flowOf([vid, rifeNode('r')], [edge('vid', 'r')])
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBeUndefined()
  })

  it('offers one clip once even when it is reachable twice', () => {
    const clip = onDisk('ONE-CLIP')
    const arts = [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const vid = mediaNode('vid', 'video', 'wan-a')
    ;(vid.data as { lastArtifacts?: unknown[] }).lastArtifacts = arts
    const flow = flowOf(
      [vid, outputCard('card', 'vid', arts), rifeNode('r')],
      [edge('vid', 'r'), edge('card', 'r')],
    )
    expect(wiredVideoPathsInto('r', flow.nodes, flow.edges)).toEqual([clip])
  })

  it('never walks the wrong way down a wire (a rife node feeding something else)', () => {
    const clip = onDisk('DOWNSTREAM')
    const r = rifeNode('r')
    ;(r.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const flow = flowOf([r, mediaNode('vid', 'video', 'wan-a')], [edge('r', 'vid')])
    expect(rifeSourcePath('r', flow.nodes, flow.edges)).toBeUndefined()
  })
})

describe('hasVideoCapableUpstream — the structural question the doctor asks', () => {
  it('is true for a video media node, before it has ever run', () => {
    const flow = flowOf([mediaNode('vid', 'video', 'wan-a'), rifeNode('r')], [edge('vid', 'r')])
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(true)
  })

  it('is false for an IMAGE media node — it can never produce a clip', () => {
    const flow = flowOf([mediaNode('img', 'image', 'sd-a'), rifeNode('r')], [edge('img', 'r')])
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(false)
  })

  it('is false with nothing wired in at all', () => {
    expect(hasVideoCapableUpstream('r', [rifeNode('r')], [])).toBe(false)
  })

  it('is false for a text node wired in by mistake', () => {
    const text = { id: 't', type: 'text', position: { x: 0, y: 0 }, data: { label: 't', text: 'hi' } } as TachiNode
    const flow = flowOf([text, rifeNode('r')], [edge('t', 'r')])
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(false)
  })

  it('FAILS OPEN on an Output card that has not run yet', () => {
    const flow = flowOf([outputCard('card', 'vid'), rifeNode('r')], [edge('card', 'r')])
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(true)
  })

  it('but says no to a card that demonstrably holds a picture', () => {
    const flow = flowOf(
      [outputCard('card', 'img', [{ kind: 'image', mimeType: 'image/png', path: '/p.png' }]), rifeNode('r')],
      [edge('card', 'r')],
    )
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(false)
  })

  it('one good upstream is enough, even beside a useless one', () => {
    const text = { id: 't', type: 'text', position: { x: 0, y: 0 }, data: { label: 't', text: 'hi' } } as TachiNode
    const flow = flowOf(
      [text, mediaNode('vid', 'video', 'wan-a'), rifeNode('r')],
      [edge('t', 'r'), edge('vid', 'r')],
    )
    expect(hasVideoCapableUpstream('r', flow.nodes, flow.edges)).toBe(true)
  })
})

describe('rifeNodeState — what the ONE control on the node says', () => {
  const base = { supported: true, installed: true, installing: false, hasInput: true, running: false }

  it('says nothing until the status has actually been read', () => {
    expect(rifeNodeState({ ...base, supported: undefined, installed: undefined })).toBe('checking')
  })

  it('names the platform gap instead of rendering a dead button', () => {
    expect(rifeNodeState({ ...base, supported: false })).toBe('unsupported')
  })

  it('offers the INSTALL before anything else — 431 MB is the headline', () => {
    expect(rifeNodeState({ ...base, installed: false })).toBe('not-installed')
    // …even with no clip wired: the download is worth starting either way.
    expect(rifeNodeState({ ...base, installed: false, hasInput: false })).toBe('not-installed')
  })

  it('latches while installing so it cannot be pressed twice', () => {
    expect(rifeNodeState({ ...base, installed: false, installing: true })).toBe('installing')
  })

  it('a run in flight outranks everything below it', () => {
    expect(rifeNodeState({ ...base, running: true })).toBe('running')
    expect(rifeNodeState({ ...base, running: true, hasInput: false })).toBe('running')
  })

  it('asks for a clip when the engine is ready and nothing is wired', () => {
    expect(rifeNodeState({ ...base, hasInput: false })).toBe('no-input')
  })

  it('is READY only when the engine is installed and a clip is wired', () => {
    expect(rifeNodeState(base)).toBe('ready')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE GRAPH PHASE — the clip that reaches the sidecar is THIS run's clip
// ═════════════════════════════════════════════════════════════════════════════

describe('Run-all: media(video) → rife', () => {
  const chain = (multiplier?: 2 | 4) => flowOf(
    // rife FIRST in the array — dropped first, wired later. Array order is not
    // run order; the same trap mediaChainOrder pins for two media nodes.
    [rifeNode('r', multiplier), mediaNode('seg', 'video', 'wan-a')],
    [edge('seg', 'r')],
  )

  it('runs the upstream video node FIRST even when it is LAST in the array', async () => {
    const results = await runMediaPhase(chain(), new Map())
    expect(sd.order).toEqual(['wan-a'])
    expect(results.map(r => r.nodeId)).toEqual(['seg', 'r'])
  })

  it('hands the sidecar THIS run\'s clip — the bytes, not last run\'s file', async () => {
    sd.output.set('wan-a', 'FRESH-CLIP-FROM-THIS-RUN')
    await runMediaPhase(chain(), new Map())
    expect(rife.calls, 'the rife stage never ran').toHaveLength(1)
    expect(rife.calls[0]!.sourceBytes).toBe('FRESH-CLIP-FROM-THIS-RUN')
  })

  it('takes the WHOLE VIDEO — the last-frame hop never fires for a rife node', async () => {
    await runMediaPhase(chain(), new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(rife.calls[0]!.sourcePath.toLowerCase().endsWith('.mp4')).toBe(true)
    expect(rife.calls[0]!.sourcePath.toLowerCase().endsWith('.png')).toBe(false)
  })

  it('sends x2 by default and x4 when the node says x4', async () => {
    await runMediaPhase(chain(), new Map())
    expect(rife.calls[0]!.multiplier).toBe(2)
    rife.calls.length = 0
    await runMediaPhase(chain(4), new Map())
    expect(rife.calls[0]!.multiplier).toBe(4)
  })

  it('reports the interpolated file as a VIDEO artifact on the node', async () => {
    const results = await runMediaPhase(chain(4), new Map())
    const r = results.find(x => x.nodeId === 'r')!
    expect(r.ok).toBe(true)
    expect(r.modality).toBe('video')
    expect(r.artifacts).toHaveLength(1)
    expect(r.artifacts[0]!.kind).toBe('video')
    // a NEW file, never the source (the sidecar refuses to overwrite)
    expect(r.artifacts[0]!.path).not.toBe(rife.calls[0]!.sourcePath)
    expect(readFileSync(r.artifacts[0]!.path!, 'utf8')).toContain('INTERPOLATED(')
  })

  it('an Output card between the two carries the CURRENT clip', async () => {
    sd.output.set('wan-a', 'RUN-2-CLIP')
    const flow = flowOf(
      [
        mediaNode('seg', 'video', 'wan-a'),
        outputCard('card', 'seg', [{ kind: 'video', mimeType: 'video/mp4', path: onDisk('RUN-1-CLIP') }]),
        rifeNode('r'),
      ],
      [
        { id: 'seg->card', source: 'seg', target: 'card', sourceHandle: 'out', type: 'link' } as TachiEdge,
        edge('card', 'r'),
      ],
    )
    await runMediaPhase(flow, new Map())
    expect(rife.calls[0]!.sourceBytes).toBe('RUN-2-CLIP')
  })

  it('a failed upstream stage hands nothing forward — no stale clip smoothed', async () => {
    sd.fail.add('wan-a')
    const results = await runMediaPhase(chain(), new Map())
    expect(results.find(r => r.nodeId === 'seg')!.ok).toBe(false)
    expect(rife.calls).toHaveLength(0)
    const r = results.find(x => x.nodeId === 'r')!
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/video/i)
  })

  it('a sidecar failure is reported honestly, not swallowed', async () => {
    rife.ok = false
    rife.error = 'The frame-interpolation engine is not installed yet.'
    const results = await runMediaPhase(chain(), new Map())
    const r = results.find(x => x.nodeId === 'r')!
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not installed')
    expect(r.artifacts).toEqual([])
  })

  it('a cancel is a failure with the run\'s own words, not a fake success', async () => {
    rife.ok = false; rife.cancelled = true; rife.error = 'Frame interpolation was stopped.'
    const results = await runMediaPhase(chain(), new Map())
    expect(results.find(x => x.nodeId === 'r')!.ok).toBe(false)
    expect(results.find(x => x.nodeId === 'r')!.error).toContain('stopped')
  })
})

describe('the interpolated clip threads onward like any media artifact', () => {
  it('feeds a SECOND rife node the first one\'s output', async () => {
    sd.output.set('wan-a', 'ORIGINAL')
    const flow = flowOf(
      [rifeNode('r2'), rifeNode('r1'), mediaNode('seg', 'video', 'wan-a')],
      [edge('seg', 'r1'), edge('r1', 'r2')],
    )
    await runMediaPhase(flow, new Map())
    expect(rife.calls).toHaveLength(2)
    expect(rife.calls[0]!.sourceBytes).toBe('ORIGINAL')
    expect(rife.calls[1]!.sourceBytes).toBe('INTERPOLATED(ORIGINAL)')
  })

  it('feeds a downstream i2v segment the LAST FRAME of the smoothed clip', async () => {
    sd.output.set('wan-a', 'ORIGINAL')
    const flow = flowOf(
      [mediaNode('seg2', 'video', 'wan-b'), rifeNode('r'), mediaNode('seg1', 'video', 'wan-a')],
      [edge('seg1', 'r'), imageEdge('r', 'seg2')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['wan-a', 'wan-b'])
    // the hop fired on the INTERPOLATED file, not the original segment
    expect(lastFrame.calls).toHaveLength(1)
    expect(lastFrame.calls[0]!).toMatch(/rife2x/)
    expect(sd.video[1]!.initBytes).toMatch(/^LASTFRAME-OF-.*rife2x/)
  })

  it('a rife node that FAILED hands nothing to the segment after it', async () => {
    rife.ok = false
    const flow = flowOf(
      [mediaNode('seg2', 'video', 'wan-b'), rifeNode('r'), mediaNode('seg1', 'video', 'wan-a')],
      [edge('seg1', 'r'), imageEdge('r', 'seg2')],
    )
    await runMediaPhase(flow, new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[1]!.initImagePath).toBeUndefined()
  })

  it('a rife-only flow (no media nodes at all) still runs its stage', async () => {
    const clip = onDisk('PERSISTED-BY-THE-RENDERER')
    const card = outputCard('card', 'someNode', [{ kind: 'video', mimeType: 'video/mp4', path: clip }])
    const results = await runMediaPhase(flowOf([card, rifeNode('r')], [edge('card', 'r')]), new Map())
    expect(results.map(r => r.nodeId)).toEqual(['r'])
    expect(rife.calls[0]!.sourceBytes).toBe('PERSISTED-BY-THE-RENDERER')
  })
})

describe('runRifeNode — the per-node RUN button\'s path', () => {
  it('works off what the renderer persisted, with no upstream run', async () => {
    const clip = onDisk('LAST-RUN-OF-THIS-NODE')
    const seg = mediaNode('seg', 'video', 'wan-a')
    ;(seg.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const flow = flowOf([seg, rifeNode('r', 4)], [edge('seg', 'r')])
    const res = await runRifeNode(flow.nodes[1] as TachiRifeNode, flow)
    expect(res.ok).toBe(true)
    expect(rife.calls).toEqual([expect.objectContaining({ sourcePath: clip, multiplier: 4 })])
    // and it ran ONLY this node
    expect(sd.order).toEqual([])
  })

  it('refuses with a sentence that names the fix when nothing is wired', async () => {
    const flow = flowOf([rifeNode('r')], [])
    const res = await runRifeNode(flow.nodes[0] as TachiRifeNode, flow)
    expect(res.ok).toBe(false)
    expect(res.artifacts).toEqual([])
    expect(res.error).toMatch(/video/i)
    expect(rife.calls).toHaveLength(0)
  })

  it('never throws — a sidecar that blows up becomes a message', async () => {
    const clip = onDisk('BOOM')
    const card = outputCard('card', 'x', [{ kind: 'video', mimeType: 'video/mp4', path: clip }])
    const flow = flowOf([card, rifeNode('r')], [edge('card', 'r')])
    const { interpolateVideo } = await import('../../electron/services/rife-runner')
    vi.mocked(interpolateVideo).mockRejectedValueOnce(new Error('vulkan device lost'))
    const res = await runRifeNode(flow.nodes[1] as TachiRifeNode, flow)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('vulkan device lost')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE FLOW DOCTOR — two honest warnings, and nothing else
// ═════════════════════════════════════════════════════════════════════════════

describe('flow-doctor · a rife node with no video wired', () => {
  it('warns, with no repair button (the fix is a wire, not a download)', () => {
    const issues = analyzeFlow([rifeNode('r')], [], {})
    const row = issues.find(i => i.kind === 'rife-no-input')
    expect(row).toBeTruthy()
    expect(row!.nodeId).toBe('r')
    expect(row!.fix).toEqual({ kind: 'none' })
  })

  it('is silent once a video node is wired in', () => {
    const flow = flowOf([mediaNode('vid', 'video', 'wan-a'), rifeNode('r')], [edge('vid', 'r')])
    expect(analyzeFlow(flow.nodes, flow.edges, {}).some(i => i.kind === 'rife-no-input')).toBe(false)
  })

  it('fires for an IMAGE node wired in — that wire can never carry a clip', () => {
    const flow = flowOf([mediaNode('img', 'image', 'sd-a'), rifeNode('r')], [edge('img', 'r')])
    expect(analyzeFlow(flow.nodes, flow.edges, {}).some(i => i.kind === 'rife-no-input')).toBe(true)
  })

  it('never fires for any other node type', () => {
    const flow = flowOf([mediaNode('img', 'image', 'sd-a'), outputCard('card', 'img')], [])
    expect(analyzeFlow(flow.nodes, flow.edges, {}).some(i => i.kind === 'rife-no-input')).toBe(false)
  })
})

describe('flow-doctor · the engine is not installed', () => {
  const flow = () => flowOf([mediaNode('vid', 'video', 'wan-a'), rifeNode('r')], [edge('vid', 'r')])

  it('warns when the probe says it is missing', () => {
    const row = analyzeFlow(flow().nodes, flow().edges, { rifeInstalled: false })
      .find(i => i.kind === 'rife-missing')
    expect(row).toBeTruthy()
    expect(row!.nodeId).toBe('r')
    // The install lives ON the node (it is 431 MB and the button says so) —
    // there is nowhere to navigate to, so the row carries no button.
    expect(row!.fix).toEqual({ kind: 'none' })
  })

  it('is silent when it IS installed', () => {
    expect(analyzeFlow(flow().nodes, flow().edges, { rifeInstalled: true })
      .some(i => i.kind === 'rife-missing')).toBe(false)
  })

  it('FAILS OPEN when the probe could not answer', () => {
    expect(analyzeFlow(flow().nodes, flow().edges, {})
      .some(i => i.kind === 'rife-missing')).toBe(false)
  })

  it('says nothing about a flow with no rife node in it', () => {
    const f = flowOf([mediaNode('vid', 'video', 'wan-a')], [])
    expect(analyzeFlow(f.nodes, f.edges, { rifeInstalled: false })).toEqual([])
  })

  it('the env gatherer only probes when the flow actually has a rife node', () => {
    const src = read('src/pages/nodes/flow-doctor-env.ts')
    expect(src).toContain("n?.type === 'rife'")
    expect(src).toContain('rifeInstalled')
  })

  it('the banner renders BOTH rows with real copy, not the generic fallback', () => {
    const banner = read('src/pages/nodes/RepairBanner.tsx')
    expect(banner).toContain("case 'rife-no-input'")
    expect(banner).toContain("case 'rife-missing'")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. i18n — every key the node asks for, in every locale we ship
// ═════════════════════════════════════════════════════════════════════════════

describe('the rife node speaks every language the app does', () => {
  const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'] as const
  const load = (l: string) =>
    JSON.parse(read(`src/i18n/locales/${l}/nodes.json`)) as Record<string, Record<string, unknown>>

  const usedKeys = (() => {
    const src = read('src/pages/nodes/canvas/nodeTypes/RifeNode.tsx')
    return [...new Set([...src.matchAll(/t\('rifeNode\.([a-zA-Z.]+)'/g)].map(m => m[1]!))]
  })()

  it('resolves a non-trivial number of keys (guards a regex that found nothing)', () => {
    expect(usedKeys.length).toBeGreaterThan(5)
  })

  for (const locale of LOCALES) {
    it(`${locale}: every rifeNode.* key the component resolves exists`, () => {
      const json = load(locale)
      for (const key of usedKeys) {
        const value = key.split('.').reduce<unknown>(
          (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
          json.rifeNode,
        )
        expect(typeof value, `${locale}: rifeNode.${key}`).toBe('string')
        expect((value as string).length, `${locale}: rifeNode.${key} is empty`).toBeGreaterThan(0)
      }
    })

    it(`${locale}: both repair rows have real copy`, () => {
      const problem = load(locale).repair as { problem?: Record<string, string> }
      expect(typeof problem.problem?.rifeNoInput, locale).toBe('string')
      expect(typeof problem.problem?.rifeMissing, locale).toBe('string')
    })
  }

  it('the install label really interpolates the size it promises', () => {
    const en = load('en').rifeNode as Record<string, string>
    expect(en.install).toContain('{{size}}')
    expect(read('src/pages/nodes/canvas/nodeTypes/RifeNode.tsx'))
      .toMatch(/t\('rifeNode\.install',\s*\{\s*size/)
  })

  it('every locale carries the SAME rifeNode key set — no half-translated node', () => {
    const enKeys = Object.keys(load('en').rifeNode as Record<string, unknown>).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(load(locale).rifeNode as Record<string, unknown>).sort(), locale).toEqual(enKeys)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE RUN-STATE CONTRACT — the node card reuses the shared machinery
// ═════════════════════════════════════════════════════════════════════════════

describe('the node card is wired to the shared run state, not its own', () => {
  const src = read('src/pages/nodes/canvas/nodeTypes/RifeNode.tsx')

  it('runs through useNodeRun (inflight guard + remount-proof state live there)', () => {
    expect(src).toContain("import { useNodeRun }")
    expect(src).toMatch(/useNodeRun\(id\)/)
  })

  it('STOPs through the app\'s ONE cancel dispatcher, with the clip as the job id', () => {
    expect(src).toContain('runActivityCancel')
    expect(src).toMatch(/kind: 'rife'/)
  })

  it('does not render a second progress bar beside the activity rail\'s', () => {
    expect(src).not.toContain('rife.onProgress')
  })

  it('shares ONE engine-status read with the gallery instead of an IPC storm', () => {
    expect(src).toMatch(/useRifeStatus/)
    // the shared cache still lives in ONE place
    const action = read('src/pages/media/RifeAction.tsx')
    expect(action).toContain('let inFlight')
    expect(action).toContain('export function useRifeStatus')
  })
})
