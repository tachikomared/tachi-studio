// apps/desktop/test/unit/canvasRunAllSeeds.test.ts
//
// "RUN ALL (IN ORDER)" DERIVED NO PER-STAGE SEEDS (FLF driver, finding 2).
//
// Driver proof, one flow run two ways:
//   • RUN AS ONE NETWORK → two distinct `--seed` values in the argv
//     (runMediaPhase draws a runSeed and deriveStageSeed fans it out — 56da00a);
//   • RUN ALL (IN ORDER) → `--seed` ABSENT on BOTH stages, i.e. sd.cpp's fixed
//     default 42 on every seedless stage, which is the exact correlation
//     56da00a was written to remove.
//
// The cause is structural, not a bug in the derivation: the in-order button is
// the RENDERER's loop (NodesPage.handleRunAll), which calls `graph:run-node`
// once per node — and that IPC is the per-node manual run, which passes no
// runSeed BY DESIGN so a single node stays reproducible. Nothing was drawing an
// invocation entropy for the sequence as a whole.
//
// The fix keeps both designs intact: the RENDERER draws ONE runSeed per Run-all
// click and threads it through the (new, optional) third IPC argument, so both
// run modes share deriveStageSeed semantics while a lone RUN button still
// invents nothing.
//
// Argv-level via the mediaChainOrder SdCall pattern for the main-process half;
// source assertions for the renderer half (house idiom — the canvas cannot be
// driven in a node test env).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-seed-'))
})

/** Where the sd-cpp mock writes its fake outputs. HOISTED (not created inside
 *  the vi.mock factory) for one reason: a temp dir born inside the factory has
 *  no name anything can clean up, and this suite left one behind on every run.
 *  Both dirs die in afterAll. */
const OUTDIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-seed-out-'))
})

afterAll(() => {
  for (const dir of [USERDATA, OUTDIR]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

interface SdCall { modelId: string; prompt: string; seed?: number }
const sd = vi.hoisted(() => ({ image: [] as SdCall[], video: [] as SdCall[] }))

vi.mock('../../electron/services/sd-cpp-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  const p  = require('node:path') as typeof import('node:path')
  const dir = OUTDIR
  let seq = 0
  const record = (bucket: SdCall[], mime: string) => async (input: SdCall) => {
    bucket.push({ ...input })
    const path = p.join(dir, `${input.modelId}-${seq++}.bin`)
    fs.writeFileSync(path, 'bytes')
    // Mirror the real client's resolveActualSeed contract: the engine reports
    // the seed it rendered with — the requested one when it was real, its own
    // roll (fixed default 42 here) when the request had none.
    return { mime, path, seed: typeof input.seed === 'number' && input.seed >= 0 ? input.seed : 42 }
  }
  return {
    generateImage: vi.fn(record(sd.image, 'image/png')),
    generateVideo: vi.fn(record(sd.video, 'video/mp4')),
  }
})

import { runMediaNode, runMediaPhase, deriveStageSeed } from '../../electron/services/graph-to-agentkit'
// The MOCKED client (factory above) — imported so one case can make the engine
// answer "I did not say" (seed -1) and prove the artifact stays silent too.
import { generateImage } from '../../electron/services/sd-cpp-client'
import type { TachiFlow, TachiMediaNode, TachiNode } from '../../src/pages/nodes/types'

const SEED_MAX = 2_147_483_647

function mediaNode(id: string, model: string, params: Record<string, unknown> = {}): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 },
    data: { label: id, modality: 'image', provider: 'local', model, prompt: `p ${id}`, params },
  } as TachiNode
}

const flowOf = (nodes: TachiNode[]): TachiFlow => ({ name: 'seeds', nodes, edges: [] } as TachiFlow)

/** What the renderer's in-order loop does: one runSeed, N per-node IPC calls. */
async function runAllInOrder(flow: TachiFlow, runSeed: string): Promise<void> {
  for (const n of flow.nodes) {
    await runMediaNode(n as TachiMediaNode, flow, new Map(), undefined, runSeed)
  }
}

beforeEach(() => {
  sd.image.length = 0
  sd.video.length = 0
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE TWO RUN MODES NOW AGREE
// ═════════════════════════════════════════════════════════════════════════════

describe('RUN ALL (IN ORDER) — one runSeed threaded per node', () => {
  it('gives two seedless stages DIFFERENT seeds (they shared 42 before)', async () => {
    const flow = flowOf([mediaNode('a', 'sd15'), mediaNode('b', 'sd-turbo')])
    await runAllInOrder(flow, 'run-alpha')

    const [a, b] = sd.image
    expect(a!.seed).toEqual(expect.any(Number))
    expect(b!.seed).toEqual(expect.any(Number))
    expect(a!.seed).not.toBe(b!.seed)
  })

  it('matches RUN AS ONE NETWORK exactly — same runSeed, same per-stage seeds', async () => {
    const build = () => flowOf([mediaNode('a', 'sd15'), mediaNode('b', 'sd-turbo')])
    await runAllInOrder(build(), 'run-alpha')
    const inOrder = sd.image.map(c => c.seed)

    // deriveStageSeed is the shared law both modes obey.
    expect(inOrder).toEqual([deriveStageSeed('run-alpha', 'a'), deriveStageSeed('run-alpha', 'b')])
  })

  it('two Run-all clicks decorrelate (a fresh draw per click)', async () => {
    const build = () => flowOf([mediaNode('a', 'sd15')])
    await runAllInOrder(build(), 'click-1')
    const first = sd.image[0]!.seed
    sd.image.length = 0
    await runAllInOrder(build(), 'click-2')
    expect(sd.image[0]!.seed).not.toBe(first)
  })

  it('derives a non-negative int32 the engine + the tachi-gen chunk accept', async () => {
    await runAllInOrder(flowOf([mediaNode('a', 'sd15')]), 'run-alpha')
    const seed = sd.image[0]!.seed!
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(SEED_MAX)
  })
})

describe('what the runSeed must never override', () => {
  it('an explicit seed wins byte-for-byte', async () => {
    await runAllInOrder(flowOf([mediaNode('a', 'sd15', { seed: 4242 })]), 'run-alpha')
    expect(sd.image[0]!.seed).toBe(4242)
  })

  it('an explicit -1 ("engine, pick one") is left alone', async () => {
    await runAllInOrder(flowOf([mediaNode('a', 'sd15', { seed: -1 })]), 'run-alpha')
    expect(sd.image[0]!.seed).toBe(-1)
  })

  it('a lone RUN button (no runSeed) still invents nothing', async () => {
    const flow = flowOf([mediaNode('a', 'sd15')])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
    expect(sd.image[0]!.seed).toBeUndefined()
  })

  it('RUN AS ONE NETWORK is untouched by the new argument', async () => {
    await runMediaPhase(flowOf([mediaNode('a', 'sd15'), mediaNode('b', 'sd-turbo')]), new Map())
    expect(sd.image[0]!.seed).not.toBe(sd.image[1]!.seed)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE WIRE — the new optional IPC argument, end to end
// ═════════════════════════════════════════════════════════════════════════════

describe('graph:run-node carries the runSeed', () => {
  it('preload forwards it (and omits it when the caller passes none)', () => {
    const pre = read('electron/preload.ts')
    expect(pre).toContain('runNode: (flow: unknown, nodeId: string, runSeed?: string) =>')
    expect(pre).toContain("ipcRenderer.invoke('graph:run-node', { flow, nodeId, ...(runSeed ? { runSeed } : {}) })")
  })

  it('the renderer contract declares it optional', () => {
    expect(read('src/types/electron.d.ts'))
      .toContain('runNode(flow: unknown, nodeId: string, runSeed?: string): Promise<')
  })

  it('the handler validates it and hands it to runMediaNode', () => {
    const ipc = read('electron/ipc/graph.ipc.ts')
    expect(ipc).toContain('runSeed: rawRunSeed')
    expect(ipc).toContain("const runSeed = typeof rawRunSeed === 'string' && rawRunSeed.trim() ? rawRunSeed.trim() : undefined")
    expect(ipc).toContain('await runMediaNode(node, flow, outputsByNodeId, (id) => emitActive(id), runSeed)')
  })
})

describe('the renderer draws ONE runSeed per Run-all click', () => {
  const page = read('src/pages/nodes/NodesPage.tsx')
  /** handleRunAll's body — the in-order loop, and nothing else.
   *  Both anchors are CODE, not comments: the end anchor used to be a `// ──
   *  BATCH35 …` banner, and a renamed banner would make indexOf return -1 and
   *  silently truncate the slice to nothing — every assertion below would then
   *  pass on an empty string. Asserted found, so a moved anchor fails loudly. */
  const runAllStart = page.indexOf('const handleRunAll = useCallback')
  const runAllEnd   = page.indexOf('useEffect(() => onWebhookFired(')
  it('the slice anchors still exist (a renamed anchor must fail, not vanish)', () => {
    expect(runAllStart).toBeGreaterThan(0)
    expect(runAllEnd).toBeGreaterThan(runAllStart)
  })
  const runAll = page.slice(runAllStart, runAllEnd)

  it('draws it OUTSIDE the per-node loop (one invocation, not one per node)', () => {
    expect(runAll).toContain('const runSeed = globalThis.crypto.randomUUID()')
    const draw = runAll.indexOf('const runSeed = globalThis.crypto.randomUUID()')
    const loop = runAll.indexOf('for (let i = 0; i < runIds.length; i++)')
    expect(draw).toBeGreaterThan(0)
    expect(draw).toBeLessThan(loop)
  })

  it('passes it on every per-node call of the sequence', () => {
    expect(runAll).toContain('api.runNode(flow, nodeId, runSeed)')
  })

  it('and the per-node RUN button still passes none', () => {
    const hook = read('src/pages/nodes/canvas/useNodeRun.ts')
    // The single-run branch calls runOnce with NOTHING — no variant, no runSeed
    // — which is what keeps a lone RUN reproducible. The old form of this test
    // banned the string 'runSeed' anywhere in the file, which locked in finding
    // 3 of the review: a fan-out could then never thread one either.
    expect(hook).toContain('await runOnce()')
    expect(hook).not.toContain('await runOnce(undefined,')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. FAN-OUT ×N ON A SEEDLESS LOCAL NODE (review of the fix lane, finding 3)
// ═════════════════════════════════════════════════════════════════════════════
//
// ×4 on a fresh media node produced FOUR IDENTICAL images. fanout.ts returns
// null for an absent seed on the premise that "the engine rerolls it each run"
// — which is true of the cloud providers and false of the one provider fan-out
// exists for: sd.cpp's default seed is a FIXED 42 (graph-to-agentkit says so in
// as many words above deriveStageSeed). So all N variants sampled the same
// noise, and the fan-out chip promised variation it could not deliver.
//
// The fix reuses the Run-all wire rather than inventing a second one: ONE
// entropy draw per doRun click, one runSeed per variant (`<entropy>#v<i>`), and
// main's existing deriveStageSeed does the decorrelating. fanout.ts is
// untouched — its explicit-seed bump is correct and still wins here.

describe('FAN-OUT ×N: variants of ONE seedless node decorrelate', () => {
  /** What the fan-out loop does per variant: same node, per-variant runSeed. */
  const variantSeed = (entropy: string, i: number) => `${entropy}#v${i}`

  it('two variants get DIFFERENT engine seeds (both were sd.cpp 42 before)', async () => {
    const flow = flowOf([mediaNode('p2i-image', 'sd15')])
    const entropy = 'fan-click-1'
    for (let i = 0; i < 2; i++) {
      await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, variantSeed(entropy, i))
    }
    expect(sd.image[0]!.seed).toEqual(expect.any(Number))
    expect(sd.image[0]!.seed).not.toBe(sd.image[1]!.seed)
  })

  it('all four of a ×4 are pairwise distinct', async () => {
    const flow = flowOf([mediaNode('p2i-image', 'sd15')])
    for (let i = 0; i < 4; i++) {
      await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, variantSeed('fan-click-2', i))
    }
    expect(new Set(sd.image.map(c => c.seed)).size).toBe(4)
  })

  it('a second ×2 click draws fresh entropy, so the two clicks differ too', async () => {
    const flow = flowOf([mediaNode('p2i-image', 'sd15')])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, variantSeed('click-a', 0))
    const first = sd.image[0]!.seed
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, variantSeed('click-b', 0))
    expect(sd.image[1]!.seed).not.toBe(first)
  })

  it('an EXPLICIT seed still wins — fanout.ts owns the variation there', async () => {
    const flow = flowOf([mediaNode('p2i-image', 'sd15', { seed: 4242 })])
    await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, variantSeed('fan-click-3', 0))
    expect(sd.image[0]!.seed).toBe(4242)
  })
})

describe('the fan-out loop draws the entropy once and varies it per variant', () => {
  const hook = read('src/pages/nodes/canvas/useNodeRun.ts')

  it('threads an optional runSeed through runOnce into the IPC', () => {
    expect(hook).toContain('runSeed?: string')
    expect(hook).toContain('api.runNode(flow, nodeId, runSeed)')
  })

  it('draws ONE entropy per click, OUTSIDE the variant loop', () => {
    const draw = hook.indexOf('const fanoutEntropy = globalThis.crypto.randomUUID()')
    const loop = hook.indexOf('for (let i = 0; i < n; i++)')
    expect(draw).toBeGreaterThan(0)
    expect(loop).toBeGreaterThan(draw)
  })

  it('passes a per-variant value, so main derives a different stage seed each time', () => {
    expect(hook).toContain('`${fanoutEntropy}#v${i}`')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. PROVENANCE — the seed that rendered rides the artifact into the gallery
// ═════════════════════════════════════════════════════════════════════════════
//
// The other half of the seed story (review of the FLF fix lane, P2): main
// DERIVED a per-stage seed and then threw it away at three layers — the artifact
// carried no seed field, the node params never held it, and the runSeed was a
// throwaway uuid. A PNG self-records its seed in the tachi-gen tEXt chunk; a
// .webm records NOTHING, so a Run-all video clip the user liked was
// unreproducible by construction. Now the engine's reported seed (>= 0 only)
// rides the artifact, and both gallery captures stamp it into the entry params
// with stampLocalSeed — the exact wiring MediaPage has had since the SIZE work.

describe('the engine seed rides the artifact (gallery provenance)', () => {
  function videoNode(id: string, model: string, params: Record<string, unknown> = {}): TachiNode {
    return {
      id, type: 'media', position: { x: 0, y: 0 },
      data: { label: id, modality: 'video', provider: 'local', model, prompt: `p ${id}`, params },
    } as TachiNode
  }

  it('an image stage returns its artifact WITH the seed that rendered it', async () => {
    const flow = flowOf([mediaNode('a', 'sd15')])
    const res = await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, 'run-alpha')
    expect(res.ok).toBe(true)
    expect(res.artifacts[0]!.seed).toBe(sd.image[0]!.seed)
    expect(res.artifacts[0]!.seed).toBe(deriveStageSeed('run-alpha', 'a'))
  })

  it('a VIDEO stage too — the .webm has no tEXt chunk, so this field is the ONLY provenance', async () => {
    const flow = flowOf([videoNode('v', 'wan21-t2v-1.3b')])
    const res = await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map(), undefined, 'run-alpha')
    expect(res.ok).toBe(true)
    expect(res.artifacts[0]!.kind).toBe('video')
    expect(res.artifacts[0]!.seed).toBe(sd.video[0]!.seed)
    expect(res.artifacts[0]!.seed).toBeGreaterThanOrEqual(0)
  })

  it('an engine that DID NOT SAY (seed -1) puts no seed on the artifact — provenance is never invented', async () => {
    vi.mocked(generateImage).mockResolvedValueOnce(
      { mime: 'image/png', path: join(OUTDIR, 'noseed.bin'), b64: '', seed: -1 } as never)
    const flow = flowOf([mediaNode('a', 'sd15')])
    const res = await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
    expect(res.ok).toBe(true)
    expect(res.artifacts[0] && 'seed' in res.artifacts[0]!).toBe(false)
  })

  it('both gallery captures stamp it into the entry params (stampLocalSeed, like MediaPage)', () => {
    for (const rel of ['src/pages/nodes/canvas/useNodeRun.ts', 'src/pages/nodes/NodesPage.tsx']) {
      const src = read(rel)
      expect(src, rel).toContain("artifacts.find(a => typeof a.seed === 'number')?.seed")
      expect(src, rel).toContain('stampLocalSeed({ ...(d.params ?? {}) }, engineSeed)')
      // The old unconditional snapshot is gone — a bag with a seed to stamp must
      // not be dropped just because the node held no params of its own.
      expect(src, rel).not.toContain('...(d.params ? { params: { ...d.params } } : {})')
    }
  })
})
