// apps/desktop/test/unit/mediaChainOrder.test.ts
//
// RUN-ALL MEDIA CHAINS: TOPOLOGICAL ORDER + THE IMAGE HANDOFF.
//
// The bug (WORKFLOWS-RESEARCH-2026-07-28 §2, "REAL BUG FOUND"): Phase 2 ran
//
//     for (const media of mediaNodesOf(flow))        // ← flow.nodes ARRAY order
//       results.push(await runMediaNode(media, flow, …))   // ← the SAME flow, always
//
// Two independent defects in those two lines:
//
//  1. ARRAY ORDER, NOT TOPOLOGICAL. A canvas node's position in `flow.nodes` is
//     the order it was DROPPED, not the order it must RUN. Wire an image node
//     into a video node after the fact and the video runs FIRST.
//
//  2. THE RESULT NEVER RE-ENTERED THE FLOW. `flow` is the payload that came in
//     over IPC; nothing written into it during the phase. So a downstream media
//     node resolving its init frame saw the canvas as it was BEFORE the run —
//     the upstream media node's fresh artifact did not exist, and an Output card
//     between them still held the PREVIOUS run's image.
//
// Per-node manual runs hid all of it: each is its own IPC call, and the renderer
// stamps `lastArtifacts` / refreshes the Output card between them, so the flow
// that arrives for node B already contains node A's picture. Run-all is the one
// path where main has to thread the handoff itself.
//
// What this pins is the CONTRACT, not the plumbing: the image the second stage
// generates from must be THIS run's image — asserted on the bytes that reach
// `initImagePath`, per proof-driver item 4 ("assert initImagePath reaches
// buildSdArgs, not 'a video appeared'").

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Every temp dir this file makes, deleted when the suite ends. Without it the
// file did to the test machine what the bug in sdInitTempCleanup did to the
// driver's: a fistful of `tachi-chain-*` dirs left in %TEMP% on every run.
const TEMPS = vi.hoisted(() => [] as string[])

/** mkdtempSync + "remember to delete this in afterAll". */
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
  const d = mk(j(td(), 'tachi-chain-'))
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

// ── the local engine, stubbed at the seam graph-to-agentkit calls ─────────────
// Each stub records the call AND the BYTES of whatever init frame it was handed,
// read at call time (a temp init file is named by Date.now() and could be
// overwritten by a later case otherwise).
interface SdCall { modelId: string; prompt: string; seed?: number; initImagePath?: string; initBytes?: string }
const sd = vi.hoisted(() => ({
  order: [] as string[],
  image: [] as SdCall[],
  video: [] as SdCall[],
  /** modelId → the bytes that model's generated file should contain. */
  output: new Map<string, string>(),
  fail:   new Set<string>(),
}))

vi.mock('../../electron/services/sd-cpp-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  const p  = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'tachi-chain-out-'))
  TEMPS.push(dir)
  let seq = 0
  const record = (bucket: SdCall[], mime: string) => async (input: SdCall) => {
    sd.order.push(input.modelId)
    bucket.push({
      ...input,
      initBytes: input.initImagePath ? fs.readFileSync(input.initImagePath).toString('utf8') : undefined,
    })
    if (sd.fail.has(input.modelId)) throw new Error(`engine refused ${input.modelId}`)
    const path = p.join(dir, `${input.modelId}-${seq++}.bin`)
    fs.writeFileSync(path, sd.output.get(input.modelId) ?? `bytes-of-${input.modelId}`)
    return { mime, path }
  }
  return {
    generateImage: vi.fn(record(sd.image, 'image/png')),
    generateVideo: vi.fn(record(sd.video, 'video/mp4')),
  }
})

// ── the FLF last-frame hop, stubbed at ITS seam ───────────────────────────────
// The extractor's own contract (argv, the short-clip retry, cleanup) is pinned
// in videoLastFrame.test.ts against a fake ffmpeg. What THIS file pins is the
// WIRING: that a chained video artifact reaches the extractor at all, and that
// what comes back is what the next stage generates from.
const lastFrame = vi.hoisted(() => ({
  /** Every clip the hop was asked to extract a frame from, in order. */
  calls: [] as string[],
  /** null → extraction failed (no ffmpeg, unreadable clip). */
  enabled: true,
}))

vi.mock('../../electron/services/video-last-frame', () => ({
  lastFrameDataUrl: vi.fn(async (videoPath: string) => {
    lastFrame.calls.push(videoPath)
    if (!lastFrame.enabled) return null
    const name = videoPath.split(/[\\/]/).pop() ?? videoPath
    return `data:image/png;base64,${Buffer.from(`LASTFRAME-OF-${name}`).toString('base64')}`
  }),
}))

import { runMediaPhase, runMediaNode, resolveWiredImages, deriveStageSeed } from '../../electron/services/graph-to-agentkit'
import type { TachiFlow, TachiMediaNode, TachiNode, TachiEdge } from '../../src/pages/nodes/types'

// ── tiny flow builders ────────────────────────────────────────────────────────

let y = 0
function mediaNode(
  id: string,
  modality: 'image' | 'video',
  model: string,
  prompt = `prompt for ${id}`,
): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: (y += 60) },
    data: { label: id, modality, provider: 'local', model, prompt, params: {} },
  } as TachiNode
}

function outputCard(id: string, sourceId: string, artifacts?: unknown[]): TachiNode {
  return {
    id, type: 'output', position: { x: 0, y: (y += 60) },
    data: { label: `${sourceId} output`, auto: true, kind: 'media', sourceId, artifacts },
  } as TachiNode
}

/** An edge into a media node's `image` plug (the init-frame / img2img handoff). */
function imageEdge(source: string, target: string): TachiEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle: 'out', targetHandle: 'image', type: 'link' } as TachiEdge
}

const flowOf = (nodes: TachiNode[], edges: TachiEdge[]): TachiFlow =>
  ({ name: 'chain', nodes, edges } as TachiFlow)

/** A file on disk pretending to be an already-generated picture. */
function onDisk(bytes: string): string {
  const dir = tempDir('tachi-chain-src-')
  const p = join(dir, 'stale.png')
  writeFileSync(p, bytes)
  return p
}

beforeEach(() => {
  sd.order.length = 0
  sd.image.length = 0
  sd.video.length = 0
  sd.output.clear()
  sd.fail.clear()
  lastFrame.calls.length = 0
  lastFrame.enabled = true
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE REGRESSION: array order ≠ topological order
// ═════════════════════════════════════════════════════════════════════════════

describe('Run-all media→media: the picture the second stage starts from', () => {
  // The storyboard shape: media(image) → media(i2v video). The VIDEO node is
  // first in `flow.nodes` — it was dropped on the canvas first and wired later.
  const storyboard = () => flowOf(
    [mediaNode('vid', 'video', 'wan-i2v'), mediaNode('img', 'image', 'sd-a')],
    [imageEdge('img', 'vid')],
  )

  it('runs the upstream image node FIRST even when it is LAST in the array', async () => {
    await runMediaPhase(storyboard(), new Map())
    expect(sd.order).toEqual(['sd-a', 'wan-i2v'])
  })

  it('hands the video stage THIS run\'s image — the bytes, not a promise of one', async () => {
    sd.output.set('sd-a', 'FRESH-FRAME-FROM-THIS-RUN')
    await runMediaPhase(storyboard(), new Map())

    const vid = sd.video[0]!
    expect(vid.initImagePath, 'the i2v stage got NO init frame at all').toBeTruthy()
    expect(vid.initBytes).toBe('FRESH-FRAME-FROM-THIS-RUN')
  })

  it('still reports both nodes, in the order they ran', async () => {
    const results = await runMediaPhase(storyboard(), new Map())
    expect(results.map(r => r.nodeId)).toEqual(['img', 'vid'])
    expect(results.every(r => r.ok)).toBe(true)
  })

  it('a 3-stage chain threads the handoff at every hop', async () => {
    // img → refine(img2img) → video, deliberately scrambled in the array.
    sd.output.set('sd-refine', 'REFINED')
    const flow = flowOf(
      [mediaNode('vid', 'video', 'wan-i2v'), mediaNode('refine', 'image', 'sd-refine'), mediaNode('img', 'image', 'sd-a')],
      [imageEdge('img', 'refine'), imageEdge('refine', 'vid')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['sd-a', 'sd-refine', 'wan-i2v'])
    expect(sd.image.find(c => c.modelId === 'sd-refine')!.initBytes).toBe('bytes-of-sd-a')
    expect(sd.video[0]!.initBytes).toBe('REFINED')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE STALE CARD: media → Output card → media
// ═════════════════════════════════════════════════════════════════════════════

describe('an Output card between two media nodes carries the CURRENT result', () => {
  it('the second stage never sees the previous run\'s image', async () => {
    sd.output.set('sd-a', 'RUN-2-IMAGE')
    const flow = flowOf(
      [
        mediaNode('img', 'image', 'sd-a'),
        outputCard('card', 'img', [{ kind: 'image', mimeType: 'image/png', path: onDisk('RUN-1-IMAGE') }]),
        mediaNode('vid', 'video', 'wan-i2v'),
      ],
      [
        { id: 'img->card', source: 'img', target: 'card', sourceHandle: 'out', type: 'link' } as TachiEdge,
        imageEdge('card', 'vid'),
      ],
    )

    await runMediaPhase(flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('RUN-2-IMAGE')
  })

  it('an Output card that has NEVER run is filled in rather than skipped', async () => {
    sd.output.set('sd-a', 'FIRST-EVER')
    const flow = flowOf(
      [
        mediaNode('vid', 'video', 'wan-i2v'),
        outputCard('card', 'img'),                    // no artifacts key at all
        mediaNode('img', 'image', 'sd-a'),
      ],
      [
        { id: 'img->card', source: 'img', target: 'card', sourceHandle: 'out', type: 'link' } as TachiEdge,
        imageEdge('card', 'vid'),
      ],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('FIRST-EVER')
  })

  it('does NOT touch cards belonging to some other node', async () => {
    const other = onDisk('SOMEONE-ELSES-PICTURE')
    const flow = flowOf(
      [
        mediaNode('img', 'image', 'sd-a'),
        outputCard('elsewhere', 'someAgent', [{ kind: 'image', mimeType: 'image/png', path: other }]),
        mediaNode('vid', 'video', 'wan-i2v'),
      ],
      [imageEdge('elsewhere', 'vid')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('SOMEONE-ELSES-PICTURE')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. BRANCHING, CYCLES, AND THE GRAPHS THAT MUST NOT CHANGE
// ═════════════════════════════════════════════════════════════════════════════

describe('branching and diamonds resolve deterministically', () => {
  it('two media nodes feeding a third: both run before it, in array order', async () => {
    const flow = flowOf(
      [mediaNode('sink', 'video', 'wan-c'), mediaNode('a', 'image', 'sd-a'), mediaNode('b', 'image', 'sd-b')],
      [imageEdge('a', 'sink'), imageEdge('b', 'sink')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['sd-a', 'sd-b', 'wan-c'])
  })

  it('and the same order twice — no set/map iteration luck', async () => {
    const build = () => flowOf(
      [mediaNode('sink', 'video', 'wan-c'), mediaNode('b', 'image', 'sd-b'), mediaNode('a', 'image', 'sd-a')],
      [imageEdge('a', 'sink'), imageEdge('b', 'sink')],
    )
    await runMediaPhase(build(), new Map())
    const first = [...sd.order]
    sd.order.length = 0
    await runMediaPhase(build(), new Map())
    expect(sd.order).toEqual(first)
    expect(sd.order[sd.order.length - 1]).toBe('wan-c')
  })

  it('one source fanning out to two sinks runs the source first, once', async () => {
    const flow = flowOf(
      [mediaNode('v1', 'video', 'wan-1'), mediaNode('v2', 'video', 'wan-2'), mediaNode('img', 'image', 'sd-a')],
      [imageEdge('img', 'v1'), imageEdge('img', 'v2')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['sd-a', 'wan-1', 'wan-2'])
    expect(sd.video.map(c => c.initBytes)).toEqual(['bytes-of-sd-a', 'bytes-of-sd-a'])
  })
})

describe('a cycle is survived, not crashed on', () => {
  it('runs every node of a two-node media cycle exactly once', async () => {
    const flow = flowOf(
      [mediaNode('a', 'image', 'sd-a'), mediaNode('b', 'image', 'sd-b')],
      [imageEdge('a', 'b'), imageEdge('b', 'a')],
    )
    const results = await runMediaPhase(flow, new Map())
    expect(results).toHaveLength(2)
    expect(new Set(sd.order)).toEqual(new Set(['sd-a', 'sd-b']))
    expect(sd.order).toHaveLength(2)
  })

  it('a self-looping media node runs once and does not hang', async () => {
    const flow = flowOf([mediaNode('a', 'image', 'sd-a')], [imageEdge('a', 'a')])
    const results = await runMediaPhase(flow, new Map())
    expect(results).toHaveLength(1)
    expect(sd.order).toEqual(['sd-a'])
  })
})

describe('graphs with no media→media handoff behave EXACTLY as before', () => {
  it('a lone media node runs with no init frame', async () => {
    const results = await runMediaPhase(flowOf([mediaNode('img', 'image', 'sd-a')], []), new Map())
    expect(results).toHaveLength(1)
    expect(sd.image[0]!.initImagePath).toBeUndefined()
  })

  it('unconnected media nodes keep their canvas order', async () => {
    const flow = flowOf(
      [mediaNode('c', 'image', 'sd-c'), mediaNode('a', 'image', 'sd-a'), mediaNode('b', 'image', 'sd-b')],
      [],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['sd-c', 'sd-a', 'sd-b'])
  })

  it('a Reference-Image node still supplies the init frame', async () => {
    const ref: TachiNode = {
      id: 'ref', type: 'imageref', position: { x: 0, y: 0 },
      data: { label: 'ref', dataUrl: `data:image/png;base64,${Buffer.from('HAND-PICKED').toString('base64')}` },
    } as TachiNode
    const flow = flowOf([ref, mediaNode('vid', 'video', 'wan-i2v')], [imageEdge('ref', 'vid')])
    await runMediaPhase(flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('HAND-PICKED')
  })

  it('a node\'s OWN typed image_url still wins over a wired upstream', async () => {
    const own = `data:image/png;base64,${Buffer.from('TYPED-ON-THE-NODE').toString('base64')}`
    const vid = mediaNode('vid', 'video', 'wan-i2v')
    ;(vid.data as { params: Record<string, unknown> }).params = { image_url: own }
    const flow = flowOf([mediaNode('img', 'image', 'sd-a'), vid], [imageEdge('img', 'vid')])
    await runMediaPhase(flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('TYPED-ON-THE-NODE')
  })
})

describe('a failed upstream stage does not fake a handoff', () => {
  it('the downstream node runs with no init frame instead of a stale one', async () => {
    sd.fail.add('sd-a')
    const flow = flowOf(
      [mediaNode('vid', 'video', 'wan-i2v'), mediaNode('img', 'image', 'sd-a')],
      [imageEdge('img', 'vid')],
    )
    const results = await runMediaPhase(flow, new Map())
    expect(results.find(r => r.nodeId === 'img')!.ok).toBe(false)
    expect(results.find(r => r.nodeId === 'vid')!.ok).toBe(true)
    expect(sd.video[0]!.initImagePath).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE PER-NODE CONTRACT (renderer persistence) IS UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════

describe('graph:run-node keeps working off what the renderer persisted', () => {
  it('an Output card the renderer filled in still feeds the next node', async () => {
    const flow = flowOf(
      [
        mediaNode('img', 'image', 'sd-a'),
        outputCard('card', 'img', [{ kind: 'image', mimeType: 'image/png', path: onDisk('PERSISTED-BY-RENDERER') }]),
        mediaNode('vid', 'video', 'wan-i2v'),
      ],
      [imageEdge('card', 'vid')],
    )
    const vid = flow.nodes.find(n => n.id === 'vid') as TachiMediaNode
    const r = await runMediaNode(vid, flow, new Map())
    expect(r.ok).toBe(true)
    expect(sd.video[0]!.initBytes).toBe('PERSISTED-BY-RENDERER')
    // the single-node path runs exactly the node asked for
    expect(sd.order).toEqual(['wan-i2v'])
  })

  it('a media node\'s persisted lastArtifacts feed a directly-wired next node', async () => {
    const img = mediaNode('img', 'image', 'sd-a')
    ;(img.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'image', mimeType: 'image/png', path: onDisk('LAST-RUN-OF-THIS-NODE') }]
    const flow = flowOf([img, mediaNode('vid', 'video', 'wan-i2v')], [imageEdge('img', 'vid')])
    const vid = flow.nodes.find(n => n.id === 'vid') as TachiMediaNode
    await runMediaNode(vid, flow, new Map())
    expect(sd.video[0]!.initBytes).toBe('LAST-RUN-OF-THIS-NODE')
  })

  it('the same artifact reachable twice is offered ONCE (no double-write)', async () => {
    const p = onDisk('ONE-PICTURE')
    const art = [{ kind: 'image', mimeType: 'image/png', path: p }]
    const img = mediaNode('img', 'image', 'sd-a')
    ;(img.data as { lastArtifacts?: unknown[] }).lastArtifacts = art
    const flow = flowOf(
      [img, outputCard('card', 'img', art), mediaNode('vid', 'video', 'wan-i2v')],
      [imageEdge('img', 'vid'), imageEdge('card', 'vid')],
    )
    expect(await resolveWiredImages('vid', flow)).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE FLF LAST-FRAME HOP — video → (frame) → i2v video
// ═════════════════════════════════════════════════════════════════════════════
//
// The storyboard technique the DELTA ADDENDUM ("FLF CHAINING") maps onto this
// canvas: a scene is rendered, its LAST frame starts the next scene, and the
// chain walks forward. §4 above already proved the image handoff; a VIDEO
// handoff has one extra step, because the artifact travelling down the wire is
// an .mp4 and the consuming slot is an INIT FRAME.
//
// Before this hop, resolveWiredImages simply skipped a video artifact
// (`.find(a => a.kind === 'image')`), so segment 2 of a chain silently
// generated from TEXT ONLY — the same class of silent-wrong-picture bug the
// topo fix cured one layer up, and just as invisible in the output.
//
// The contract:
//   • the hop fires ONLY when nothing else supplies the picture — an explicit
//     image wire, or an image_url typed on the node, always wins untouched;
//   • it fires only for slots that CONSUME an image (image / video), never for
//     music, TTS or STT;
//   • what reaches the engine is a PNG THAT EXISTS, holding the extracted
//     frame — never the .mp4 path, which sd-cli would reject as an init image;
//   • a failed extraction degrades to "no init frame", exactly like a failed
//     upstream stage — the segment still runs.

describe('a video wired into an i2v stage hands over its LAST FRAME', () => {
  /** Two chained segments: media(video) → media(video). */
  const twoSegments = () => flowOf(
    [mediaNode('seg2', 'video', 'wan-b'), mediaNode('seg1', 'video', 'wan-a')],
    [imageEdge('seg1', 'seg2')],
  )

  it('extracts from THIS run\'s clip, on disk, exactly once', async () => {
    await runMediaPhase(twoSegments(), new Map())
    expect(sd.order).toEqual(['wan-a', 'wan-b'])
    expect(lastFrame.calls).toHaveLength(1)
    // the file handed to the extractor is the artifact segment 1 just wrote
    expect(lastFrame.calls[0]!).toMatch(/wan-a-\d+\.bin$/)
    expect(existsSync(lastFrame.calls[0]!)).toBe(true)
  })

  it('the second segment starts from a .png THAT EXISTS — not the .mp4', async () => {
    await runMediaPhase(twoSegments(), new Map())
    const seg2 = sd.video[1]!
    expect(seg2.initImagePath, 'segment 2 got no init frame — the hop never fired').toBeTruthy()
    expect(seg2.initImagePath!.toLowerCase().endsWith('.png')).toBe(true)
    expect(seg2.initImagePath!.toLowerCase().endsWith('.mp4')).toBe(false)
    // EXISTS WHEN IT MATTERS: `initBytes` is read inside the engine stub, i.e.
    // while sd-cli would have the file open — so a truthy value here is the
    // "that .png is real" claim this case was written to make. The file itself
    // is gone by now on purpose: the temp is removed in runMediaNode's `finally`
    // (FLF driver finding 5 — 882 of these had piled up in %TEMP%), and
    // sdInitTempCleanup.test.ts owns that behaviour.
    expect(seg2.initBytes).toBeTruthy()
    expect(existsSync(seg2.initImagePath!)).toBe(false)
  })

  it('and the bytes it generates from ARE the extracted frame', async () => {
    await runMediaPhase(twoSegments(), new Map())
    expect(sd.video[1]!.initBytes).toMatch(/^LASTFRAME-OF-wan-a-\d+\.bin$/)
  })

  it('a THREE-segment storyboard hops at every seam, in order', async () => {
    const flow = flowOf(
      [
        mediaNode('seg3', 'video', 'wan-c'),
        mediaNode('seg1', 'video', 'wan-a'),
        mediaNode('seg2', 'video', 'wan-b'),
      ],
      [imageEdge('seg1', 'seg2'), imageEdge('seg2', 'seg3')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['wan-a', 'wan-b', 'wan-c'])
    expect(lastFrame.calls).toHaveLength(2)
    expect(sd.video[1]!.initBytes).toMatch(/^LASTFRAME-OF-wan-a-\d+\.bin$/)
    expect(sd.video[2]!.initBytes).toMatch(/^LASTFRAME-OF-wan-b-\d+\.bin$/)
  })

  it('the full storyboard shape — image → video → video — threads both kinds of handoff', async () => {
    sd.output.set('sd-a', 'THE-OPENING-STILL')
    const flow = flowOf(
      [
        mediaNode('seg2', 'video', 'wan-b'),
        mediaNode('still', 'image', 'sd-a'),
        mediaNode('seg1', 'video', 'wan-a'),
      ],
      [imageEdge('still', 'seg1'), imageEdge('seg1', 'seg2')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.order).toEqual(['sd-a', 'wan-a', 'wan-b'])
    expect(sd.video[0]!.initBytes).toBe('THE-OPENING-STILL')     // plain image handoff
    expect(sd.video[1]!.initBytes).toMatch(/^LASTFRAME-OF-wan-a-\d+\.bin$/) // last-frame hop
  })

  it('an Output card carrying a video result hops just the same', async () => {
    const flow = flowOf(
      [
        mediaNode('seg1', 'video', 'wan-a'),
        outputCard('card', 'seg1'),
        mediaNode('seg2', 'video', 'wan-b'),
      ],
      [
        { id: 'seg1->card', source: 'seg1', target: 'card', sourceHandle: 'out', type: 'link' } as TachiEdge,
        imageEdge('card', 'seg2'),
      ],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.video[1]!.initBytes).toMatch(/^LASTFRAME-OF-wan-a-\d+\.bin$/)
  })

  it('an IMAGE stage fed by a video gets the frame too (img2img off a clip)', async () => {
    const flow = flowOf(
      [mediaNode('edit', 'image', 'sd-edit'), mediaNode('seg1', 'video', 'wan-a')],
      [imageEdge('seg1', 'edit')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.image[0]!.initBytes).toMatch(/^LASTFRAME-OF-wan-a-\d+\.bin$/)
  })
})

describe('the hop stays out of the way of every path that already worked', () => {
  it('an explicit IMAGE wire wins — nothing is extracted at all', async () => {
    sd.output.set('sd-a', 'THE-WIRED-PICTURE')
    const flow = flowOf(
      [mediaNode('vid', 'video', 'wan-i2v'), mediaNode('img', 'image', 'sd-a')],
      [imageEdge('img', 'vid')],
    )
    await runMediaPhase(flow, new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[0]!.initBytes).toBe('THE-WIRED-PICTURE')
  })

  it('an image AND a video wired into the same node: the image is used, un-hopped', async () => {
    sd.output.set('sd-a', 'CHOSEN-PICTURE')
    const flow = flowOf(
      [
        mediaNode('seg2', 'video', 'wan-b'),
        mediaNode('seg1', 'video', 'wan-a'),
        mediaNode('img', 'image', 'sd-a'),
      ],
      [imageEdge('seg1', 'seg2'), imageEdge('img', 'seg2')],
    )
    await runMediaPhase(flow, new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[1]!.initBytes).toBe('CHOSEN-PICTURE')
  })

  it('an image_url typed on the node wins over a wired clip', async () => {
    const seg2 = mediaNode('seg2', 'video', 'wan-b')
    ;(seg2.data as { params: Record<string, unknown> }).params = {
      image_url: `data:image/png;base64,${Buffer.from('TYPED-ON-THE-NODE').toString('base64')}`,
    }
    await runMediaPhase(flowOf([mediaNode('seg1', 'video', 'wan-a'), seg2], [imageEdge('seg1', 'seg2')]), new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[1]!.initBytes).toBe('TYPED-ON-THE-NODE')
  })

  it('an image→image chain never touches the extractor', async () => {
    const flow = flowOf(
      [mediaNode('a', 'image', 'sd-a'), mediaNode('b', 'image', 'sd-b')],
      [imageEdge('a', 'b')],
    )
    await runMediaPhase(flow, new Map())
    expect(lastFrame.calls).toHaveLength(0)
  })

  it('a video wired into a MUSIC node is not turned into a frame', async () => {
    const music: TachiNode = {
      id: 'song', type: 'media', position: { x: 0, y: 0 },
      data: { label: 'song', modality: 'music', provider: 'local', model: 'm', prompt: 'p', params: {} },
    } as TachiNode
    await runMediaPhase(flowOf([mediaNode('seg1', 'video', 'wan-a'), music], [imageEdge('seg1', 'song')]), new Map())
    expect(lastFrame.calls).toHaveLength(0)
  })

  it('a lone video node with nothing wired in extracts nothing', async () => {
    await runMediaPhase(flowOf([mediaNode('v', 'video', 'wan-a')], []), new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[0]!.initImagePath).toBeUndefined()
  })
})

describe('a hop that cannot produce a frame degrades, it does not break', () => {
  it('the next segment runs WITHOUT an init frame rather than with an .mp4', async () => {
    lastFrame.enabled = false
    const results = await runMediaPhase(
      flowOf([mediaNode('seg1', 'video', 'wan-a'), mediaNode('seg2', 'video', 'wan-b')], [imageEdge('seg1', 'seg2')]),
      new Map(),
    )
    expect(lastFrame.calls).toHaveLength(1)
    expect(sd.video[1]!.initImagePath).toBeUndefined()
    expect(results.every(r => r.ok)).toBe(true)
  })

  it('a video artifact with no path on disk is skipped, not guessed at', async () => {
    // b64-only artifacts exist for small images; a clip that never landed on
    // disk has nothing for ffmpeg to open.
    const seg1 = mediaNode('seg1', 'video', 'wan-a')
    ;(seg1.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', b64: 'AAAA' }]
    const flow = flowOf([seg1, mediaNode('seg2', 'video', 'wan-b')], [imageEdge('seg1', 'seg2')])
    await runMediaNode(flow.nodes[1] as TachiMediaNode, flow, new Map())
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[0]!.initImagePath).toBeUndefined()
  })

  it('a FAILED upstream segment hands nothing forward', async () => {
    sd.fail.add('wan-a')
    await runMediaPhase(
      flowOf([mediaNode('seg1', 'video', 'wan-a'), mediaNode('seg2', 'video', 'wan-b')], [imageEdge('seg1', 'seg2')]),
      new Map(),
    )
    expect(lastFrame.calls).toHaveLength(0)
    expect(sd.video[1]!.initImagePath).toBeUndefined()
  })
})

describe('the per-node run hops off what the renderer persisted', () => {
  it('a persisted video result feeds the next segment a frame', async () => {
    const clip = onDisk('MP4-BYTES')
    const seg1 = mediaNode('seg1', 'video', 'wan-a')
    ;(seg1.data as { lastArtifacts?: unknown[] }).lastArtifacts =
      [{ kind: 'video', mimeType: 'video/mp4', path: clip }]
    const flow = flowOf([seg1, mediaNode('seg2', 'video', 'wan-b')], [imageEdge('seg1', 'seg2')])
    await runMediaNode(flow.nodes[1] as TachiMediaNode, flow, new Map())
    expect(lastFrame.calls).toEqual([clip])
    expect(sd.video[0]!.initBytes).toBe('LASTFRAME-OF-stale.png')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. PER-STAGE SEEDS — the follow-up d3e4ffd queued
// ═════════════════════════════════════════════════════════════════════════════
//
// sd.cpp's own default seed is a FIXED 42, not "random" (sd-cpp-client's
// resolveActualSeed comment says it in as many words: "buildSdArgs omits
// `--seed` entirely when the caller passes none, and sd-cli's own default is a
// fixed number, not random"). So in a Run-all, EVERY stage that omits a seed
// samples from the SAME noise: two txt2img nodes in one flow come out
// suspiciously alike, and an i2v stage re-uses the image stage's noise pattern.
// A canvas media node starts life with `params: {}` — nothing pre-fills the
// schema's `-1` default onto it — so "omits a seed" is the DEFAULT state, not a
// corner case.
//
// The contract pinned here:
//   • Run-all fills the hole with hash(run-invocation entropy, node id), so
//     stages decorrelate WITHIN a run and runs decorrelate FROM EACH OTHER.
//   • An explicit seed always wins, byte-for-byte — including an explicit -1,
//     which is the user asking the engine for a random one.
//   • The per-node manual run is untouched: no seed invented, so today's
//     reproducible-by-default single-node behaviour survives exactly.
//   • The derived value is in the engine-accepted range, and is a number the
//     tachi-gen chunk can record (Remix reproduces the stage).

const SEED_MAX = 2_147_483_647   // the app's own seed schema ceiling
                                 // (surplus-media-service CURATED_SCHEMA: min -1, max 2_147_483_647)

describe('Run-all derives a per-stage seed when the node carries none', () => {
  it('two seedless stages in ONE run do NOT land on the same seed', async () => {
    const flow = flowOf([mediaNode('a', 'image', 'sd-a'), mediaNode('b', 'image', 'sd-b')], [])
    await runMediaPhase(flow, new Map())

    const [a, b] = sd.image
    expect(typeof a!.seed, 'stage A ran with no seed → sd.cpp default 42').toBe('number')
    expect(typeof b!.seed, 'stage B ran with no seed → sd.cpp default 42').toBe('number')
    expect(a!.seed).not.toBe(b!.seed)
  })

  it('an image stage and the video stage it feeds also differ', async () => {
    const flow = flowOf(
      [mediaNode('vid', 'video', 'wan-i2v'), mediaNode('img', 'image', 'sd-a')],
      [imageEdge('img', 'vid')],
    )
    await runMediaPhase(flow, new Map())
    expect(sd.image[0]!.seed).toEqual(expect.any(Number))
    expect(sd.video[0]!.seed).toEqual(expect.any(Number))
    expect(sd.image[0]!.seed).not.toBe(sd.video[0]!.seed)
  })

  it('the derived seed is a non-negative int32 the engine accepts', async () => {
    await runMediaPhase(flowOf([mediaNode('a', 'image', 'sd-a')], []), new Map())
    const seed = sd.image[0]!.seed!
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(SEED_MAX)
  })

  it('the SAME flow run twice derives DIFFERENT seeds (invocations decorrelate)', async () => {
    const build = () => flowOf([mediaNode('a', 'image', 'sd-a')], [])
    await runMediaPhase(build(), new Map())
    const first = sd.image[0]!.seed
    sd.image.length = 0
    await runMediaPhase(build(), new Map())
    expect(sd.image[0]!.seed).not.toBe(first)
  })

  it('an explicit seed reaches the engine byte-for-byte', async () => {
    const node = mediaNode('a', 'image', 'sd-a')
    ;(node.data as { params: Record<string, unknown> }).params = { seed: 12345 }
    await runMediaPhase(flowOf([node], []), new Map())
    expect(sd.image[0]!.seed).toBe(12345)
  })

  it('an explicit -1 ("pick one for me") is NOT overwritten', async () => {
    const node = mediaNode('a', 'image', 'sd-a')
    ;(node.data as { params: Record<string, unknown> }).params = { seed: -1 }
    await runMediaPhase(flowOf([node], []), new Map())
    expect(sd.image[0]!.seed).toBe(-1)
  })

  it('an explicit seed on ONE stage leaves the other stage derived', async () => {
    const pinned = mediaNode('pinned', 'image', 'sd-a')
    ;(pinned.data as { params: Record<string, unknown> }).params = { seed: 777 }
    await runMediaPhase(flowOf([pinned, mediaNode('free', 'image', 'sd-b')], []), new Map())
    expect(sd.image[0]!.seed).toBe(777)
    expect(sd.image[1]!.seed).toEqual(expect.any(Number))
    expect(sd.image[1]!.seed).not.toBe(777)
  })
})

describe('the per-node manual run keeps TODAY behaviour exactly', () => {
  it('invents no seed — the reproducible sd.cpp default still applies', async () => {
    const flow = flowOf([mediaNode('img', 'image', 'sd-a')], [])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
    expect(sd.image[0]!.seed).toBeUndefined()
  })

  it('and a video node run on its own is equally untouched', async () => {
    const flow = flowOf([mediaNode('vid', 'video', 'wan-i2v')], [])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
    expect(sd.video[0]!.seed).toBeUndefined()
  })

  it('an explicit seed still reaches the engine on the per-node path', async () => {
    const node = mediaNode('img', 'image', 'sd-a')
    ;(node.data as { params: Record<string, unknown> }).params = { seed: 99 }
    const flow = flowOf([node], [])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
    expect(sd.image[0]!.seed).toBe(99)
  })
})

describe('deriveStageSeed: the derivation itself', () => {
  it('is deterministic for one (run, node) pair', () => {
    expect(deriveStageSeed('run-1', 'node-a')).toBe(deriveStageSeed('run-1', 'node-a'))
  })

  it('separates two nodes inside the same run', () => {
    expect(deriveStageSeed('run-1', 'node-a')).not.toBe(deriveStageSeed('run-1', 'node-b'))
  })

  it('separates the same node across two runs', () => {
    expect(deriveStageSeed('run-1', 'node-a')).not.toBe(deriveStageSeed('run-2', 'node-a'))
  })

  it('does not confuse a run/node split (no delimiter collision)', () => {
    // 'ab' + 'c' and 'a' + 'bc' are different pairs and must not collide.
    expect(deriveStageSeed('ab', 'c')).not.toBe(deriveStageSeed('a', 'bc'))
  })

  it('never leaves [0, 2147483647] — no negative, no overflow', () => {
    for (let i = 0; i < 2000; i++) {
      const s = deriveStageSeed(`run-${i}`, `node-${i * 7919}`)
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(SEED_MAX)
    }
  })

  it('spreads: 2000 nodes of one run produce ~2000 distinct seeds', () => {
    const run = 'one-invocation'
    const seeds = new Set(Array.from({ length: 2000 }, (_, i) => deriveStageSeed(run, `node-${i}`)))
    expect(seeds.size).toBeGreaterThan(1990)
  })

  it('is a seed the tachi-gen chunk can record — Remix reproduces the stage', async () => {
    // resolveActualSeed honours the REQUEST only when it is >= 0; a negative
    // derived seed would be written to the chunk as -1 and the stage would be
    // unreproducible. Real implementation, not the module mock this file installs.
    const { resolveActualSeed } = await vi.importActual<
      typeof import('../../electron/services/sd-cpp-client')
    >('../../electron/services/sd-cpp-client')
    const seed = deriveStageSeed('run-1', 'node-a')
    expect(resolveActualSeed(null, seed)).toBe(seed)
  })
})
