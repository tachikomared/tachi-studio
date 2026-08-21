// apps/desktop/test/unit/canvasLocalNegative.test.ts
//
// THE CANVAS NEGATIVE PROMPT WAS COSMETIC (FLF driver, finding 1).
//
// Driver proof: three Wan invocations started from the canvas, ZERO `-n` flags
// in the argv. The textarea on the media node showed Wan's official negative
// the whole time — ParamFields renders `spec.default` when the bag holds no
// value (ParamFields.tsx, `asString(value, spec.default)`), so the string was
// on screen and nowhere else.
//
// WHY ONLY THE CANVAS. `negative_prompt` is a ROW-OWNED param: the local video
// schema carries the row's own string as the spec `default`
// (surplus-media-service → localGenOptionsFor → WAN_DEFAULT_NEGATIVE). The
// MEDIA PAGE re-seeds LOCAL_ROW_OWNED_PARAMS into its params bag when the
// schema arrives (MediaPage's schema effect), so by run time the value is IN
// the bag and resolveLocalNegative finds it. A canvas media node has no such
// effect: it is born `params: {}` and a saved flow reads `params:{duration:2}`
// — no negative key at all — so the same resolver answered '' and the arg
// builder emitted no `-n`.
//
// THE FIX IS AT ENGINE ASSEMBLY, not in a second re-seeding effect, so every
// surface that assembles local args is honest by construction:
//   • no negative key AT ALL  → the ROW's negative (what the field displays);
//   • an EMPTY string         → nothing, because the user cleared it on purpose
//     (ParamFields writes '' on clear — the distinction is load-bearing);
//   • text                    → that text, exactly as before.
//
// Argv-level, per the mediaChainOrder SdCall pattern: what is asserted is the
// input that reaches the engine client, plus the one line in each arg builder
// that turns it into `-n`.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// hoisted: the media service chain reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-neg-'))
})

/** Where the fake engine client writes its bytes. Hoisted (not made inside the
 *  mock factory) so afterAll can actually delete it — a suite that leaves temp
 *  dirs behind on every run is its own small leak. */
const OUTDIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-neg-out-'))
})

afterAll(() => {
  for (const dir of [USERDATA, OUTDIR]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
  }
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

/** What the engine client was actually handed (the argv, one level up). */
interface SdCall { modelId: string; prompt: string; negative?: string; seed?: number }
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
    return { mime, path }
  }
  return {
    generateImage: vi.fn(record(sd.image, 'image/png')),
    generateVideo: vi.fn(record(sd.video, 'video/mp4')),
  }
})

import { runMediaNode } from '../../electron/services/graph-to-agentkit'
import { WAN_DEFAULT_NEGATIVE } from '../../electron/services/sd-cpp-models'
import {
  resolveLocalNegative, applyParamEdit, reseedRecipeParams,
  LOCAL_ROW_OWNED_PARAMS, NEGATIVE_KEYS,
} from '../../src/pages/media/localGenParams'
import type { ParamSpec } from '../../src/types/electron'
import type { TachiFlow, TachiMediaNode, TachiNode } from '../../src/pages/nodes/types'

/** Source WITHOUT comments (the mediaLocalGenParams lane's helper). This file's
 *  own comments QUOTE the dead idioms, so a naive read() would let the
 *  post-mortem satisfy the assertion the post-mortem is about. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

const read = (rel: string): string => stripComments(readFileSync(resolve(__dirname, '..', '..', rel), 'utf8'))

/** Non-vacuous slice between two anchors (civitaiCatalogTab's `between`). */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(80)
  return body
}

const MEDIA_NODE = 'src/pages/nodes/canvas/nodeTypes/MediaNode.tsx'

/** A curated Wan row: cfg 6, so its negative is LIVE (not a distilled no-op). */
const WAN_ROW = 'wan21-t2v-1.3b'
/** A curated local IMAGE row — no row negative of its own. */
const SD_ROW  = 'sd15'

function mediaNode(
  id: string,
  modality: 'image' | 'video',
  model: string,
  params: Record<string, unknown>,
): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 },
    data: { label: id, modality, provider: 'local', model, prompt: `prompt for ${id}`, params },
  } as TachiNode
}

const flowOf = (nodes: TachiNode[]): TachiFlow => ({ name: 'neg', nodes, edges: [] } as TachiFlow)

async function run(node: TachiNode): Promise<void> {
  const flow = flowOf([node])
  await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
}

beforeEach(() => {
  sd.image.length = 0
  sd.video.length = 0
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE REGRESSION — the saved flow's own params bag
// ═════════════════════════════════════════════════════════════════════════════

describe('a canvas Wan run with UNTOUCHED params', () => {
  it('sends the row negative the node has been DISPLAYING all along', async () => {
    // The exact bag the driver's saved .tachi-flow.json held.
    await run(mediaNode('vid', 'video', WAN_ROW, { duration: 2 }))
    expect(sd.video[0]!.negative).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('and a brand-new node (params: {}) is the same case', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, {}))
    expect(sd.video[0]!.negative).toBe(WAN_DEFAULT_NEGATIVE)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. ABSENT ≠ CLEARED
// ═════════════════════════════════════════════════════════════════════════════

describe('the user CLEARED the field', () => {
  it("an empty string sends NO negative — '' is a decision, not a hole", async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, { duration: 2, negative_prompt: '' }))
    expect(sd.video[0]!.negative).toBeFalsy()
  })

  it('a whitespace-only field is the same decision', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, { negative_prompt: '   ' }))
    expect(sd.video[0]!.negative).toBeFalsy()
  })

  it('the legacy `negative` key, cleared, also blocks the row default', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, { negative: '' }))
    expect(sd.video[0]!.negative).toBeFalsy()
  })
})

describe('the user TYPED their own', () => {
  it('their text wins over the row default, byte-for-byte', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, { negative_prompt: 'blurry, watermark' }))
    expect(sd.video[0]!.negative).toBe('blurry, watermark')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. ROWS THAT DECLARE NO NEGATIVE STAY EMPTY
// ═════════════════════════════════════════════════════════════════════════════

describe('a row with no negative of its own', () => {
  it('a local IMAGE checkpoint sends no negative for an untouched bag', async () => {
    await run(mediaNode('img', 'image', SD_ROW, {}))
    expect(sd.image[0]!.negative).toBeFalsy()
  })

  it('an unknown model id invents nothing', async () => {
    await run(mediaNode('vid', 'video', 'not-a-real-row', { duration: 2 }))
    expect(sd.video[0]!.negative).toBeFalsy()
  })

  it('a typed negative still reaches a row that declares none', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { negative_prompt: 'extra fingers' }))
    expect(sd.image[0]!.negative).toBe('extra fingers')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE RESOLVER ITSELF (pure, both surfaces call it)
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveLocalNegative(params, rowDefault)', () => {
  it('falls back only when NO negative key exists', () => {
    expect(resolveLocalNegative({}, 'ROW')).toBe('ROW')
    expect(resolveLocalNegative({ duration: 2 }, 'ROW')).toBe('ROW')
  })

  it('treats an explicitly-undefined value as absent (healParamsForSchema semantics)', () => {
    expect(resolveLocalNegative({ negative_prompt: undefined }, 'ROW')).toBe('ROW')
  })

  it("returns '' when the key is present and empty", () => {
    expect(resolveLocalNegative({ negative_prompt: '' }, 'ROW')).toBe('')
    expect(resolveLocalNegative({ negative: '' }, 'ROW')).toBe('')
  })

  it('is unchanged with no rowDefault at all (the old one-arg contract)', () => {
    expect(resolveLocalNegative({})).toBe('')
    expect(resolveLocalNegative({ negative_prompt: 'x' })).toBe('x')
    expect(resolveLocalNegative({ negative: 'legacy' })).toBe('legacy')
  })

  it('prefers the schema name over the legacy key', () => {
    expect(resolveLocalNegative({ negative_prompt: 'new', negative: 'old' }, 'ROW')).toBe('new')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. …AND THE ARG BUILDER STILL TURNS IT INTO `-n`
// ═════════════════════════════════════════════════════════════════════════════
//
// The value above is only worth something if the client still spells it. Both
// builders share the same line; a source assertion is the cheapest way to keep
// the image and video halves from drifting apart (the video argv is built
// inline inside generateVideo, so there is no pure builder to call).

describe('the `-n` flag itself', () => {
  const client = readFileSync(
    resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8',
  )

  it('is emitted for a truthy negative on BOTH the image and video paths', () => {
    const hits = client.match(/args\.push\('-n', input\.negative\)/g) ?? []
    expect(hits.length).toBe(2)
  })

  it('is guarded, so an empty negative adds no flag', () => {
    expect(client).toContain("if (input.negative) args.push('-n', input.negative)")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. …AND THE CANVAS COULD NOT REACH THE EMPTY CASE AT ALL (review of this lane)
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above rests on the resolver's premise: "ParamFields writes '' when
// the user clears". That is TRUE of the media tab — media.store's setParam
// ASSIGNS ({ ...bag, [name]: value }), so the empty string lands in the bag —
// and it was FALSE on the canvas, where the node's own setParam ran
// `if (value == null || value === '') delete next[name]`.
//
// The full loop of the bug this lane shipped a half-fix for: clear the textarea
// → the key is DELETED → ParamFields re-renders `asString(undefined,
// spec.default)` and Wan's official negative SNAPS BACK into the box →
// negativeWasTouched() reads an untouched bag → the engine is handed
// `-n <WAN_DEFAULT_NEGATIVE>` by a user who explicitly deleted it. The empty
// branch of section 2 was unreachable from the surface that needed it.
//
// (Verified while fixing: ParamFields' asString returns '' for a '' value —
// `typeof value === 'string'` wins before the fallback — so the textarea shows
// an EMPTY box as soon as the key survives. The renderer never needed a change.)

describe('applyParamEdit — the canvas edit path', () => {
  it("KEEPS an empty negative_prompt, because '' is the decision", () => {
    const bag = applyParamEdit({ duration: 2, negative_prompt: WAN_DEFAULT_NEGATIVE }, 'negative_prompt', '')
    expect('negative_prompt' in bag).toBe(true)
    expect(bag.negative_prompt).toBe('')
    // …which is the ONLY thing that makes the resolver answer '' here.
    expect(resolveLocalNegative(bag, WAN_DEFAULT_NEGATIVE)).toBe('')
  })

  it('keeps the legacy `negative` key empty too', () => {
    const bag = applyParamEdit({ negative: 'blurry' }, 'negative', '')
    expect('negative' in bag).toBe(true)
    expect(resolveLocalNegative(bag, WAN_DEFAULT_NEGATIVE)).toBe('')
  })

  it('and both keys it protects are the resolver\'s own', () => {
    expect([...NEGATIVE_KEYS]).toEqual(['negative_prompt', 'negative'])
  })

  it('every OTHER param keeps delete-on-empty — a blank size means "the row\'s"', () => {
    expect(applyParamEdit({ size: '512x512' }, 'size', '')).toEqual({})
    expect(applyParamEdit({ sampler: 'euler' }, 'sampler', '')).toEqual({})
  })

  it('null / undefined still deletes, even a negative — that is "back to untouched"', () => {
    expect(applyParamEdit({ negative_prompt: 'x' }, 'negative_prompt', undefined)).toEqual({})
    expect(applyParamEdit({ negative_prompt: 'x' }, 'negative_prompt', null)).toEqual({})
    // …and the row default is what runs again, exactly as for a fresh node.
    const bag = applyParamEdit({ negative_prompt: 'x' }, 'negative_prompt', undefined)
    expect(resolveLocalNegative(bag, WAN_DEFAULT_NEGATIVE)).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('a typed value is stored verbatim, and the input bag is never mutated', () => {
    const before = { duration: 2 }
    expect(applyParamEdit(before, 'negative_prompt', 'blurry')).toEqual({ duration: 2, negative_prompt: 'blurry' })
    expect(before).toEqual({ duration: 2 })
  })

  it('END TO END: the bag a CLEAR produces sends no -n from the canvas', async () => {
    const bag = applyParamEdit({ duration: 2, negative_prompt: WAN_DEFAULT_NEGATIVE }, 'negative_prompt', '')
    await run(mediaNode('vid', 'video', WAN_ROW, bag))
    expect(sd.video[0]!.negative).toBeFalsy()
  })

  it('the media NODE routes its edits through it (no local delete-on-empty)', () => {
    const src = read(MEDIA_NODE)
    const body = between(src, 'const setParam = useCallback', 'const clearOutput = useCallback')
    expect(body).toContain('applyParamEdit(params, name, value)')
    // The line that deleted the decision.
    expect(body).not.toContain("if (value == null || value === '') delete next[name]")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. SWITCHING CHECKPOINT ON THE CANVAS RE-SEEDS WHAT THE ROW OWNS
// ═════════════════════════════════════════════════════════════════════════════
//
// The other half of the same gap, and the "stuck valid params" bug class again:
// MediaPage's schema effect re-seeds LOCAL_ROW_OWNED_PARAMS when the MODEL
// changes (the mush incident — SD-Turbo's steps:1 surviving onto a 20-step
// checkpoint), and the canvas node wrote `{ model }` and nothing else. So a Wan
// negative in a node's bag survived a switch to a distilled row whose schema
// default is '' PRECISELY to clear it, and the argv carried Wan's string to a
// checkpoint that never asked for it.
//
// The re-seeding RULE is reseedRecipeParams (owned by mediaModelSwitchRecipe);
// what is asserted here is the CANVAS's use of it, plus the one semantic a
// canvas user will notice.

describe('the canvas model switch', () => {
  /** A distilled row's local negative spec: declared, defaulting to ''. */
  const DISTILLED: ParamSpec[] = [
    { name: 'negative_prompt', label: 'Negative prompt', kind: 'text', default: '' },
    { name: 'steps', label: 'Steps', kind: 'int', default: 1, min: 1, max: 4 },
  ]

  it("re-seeds a Wan negative to the new row's default", () => {
    const bag = { duration: 2, negative_prompt: WAN_DEFAULT_NEGATIVE }
    const { next, changed } = reseedRecipeParams(bag, DISTILLED, LOCAL_ROW_OWNED_PARAMS)
    expect(changed).toBe(true)
    expect(next.negative_prompt).toBe('')
    expect(next.duration).toBe(2)          // not row-owned: untouched
  })

  it('CLOBBERS a user-typed negative as well — MediaPage\'s own semantics', () => {
    // Deliberately mirrored, not softened: the value belongs to the ROW, and the
    // media tab has behaved this way since the mush incident. A canvas that kept
    // the typed string would be a second, quieter rule for the same control.
    const { next } = reseedRecipeParams({ negative_prompt: 'my own words' }, DISTILLED, LOCAL_ROW_OWNED_PARAMS)
    expect(next.negative_prompt).toBe('')
  })

  it('touches nothing the bag does not already hold (no seeding on the canvas)', () => {
    const { next, changed } = reseedRecipeParams({ duration: 2 }, DISTILLED, LOCAL_ROW_OWNED_PARAMS)
    expect(changed).toBe(false)
    expect(next).toEqual({ duration: 2 })
  })

  it('the node re-seeds ONLY on a real model change, with the route\'s own list', () => {
    const src = read(MEDIA_NODE)
    const effect = between(src, 'const [schema, setSchema] = useState<ParamSpec[]>([])', 'const promptParam = PROMPT_PARAM[modality]')
    expect(effect).toContain('reseedRecipeParams(bag, specs, rowOwned)')
    // First mount and a re-fetch for the SAME model must keep what the user set.
    expect(effect).toContain('seededForModelRef')
    expect(effect).toMatch(/priorModel === null \|\| priorModel === model/)
    // …and `size` / `negative_prompt` are re-seeded on the LOCAL route only.
    expect(effect).toMatch(/provider === 'local'[\s\S]{0,120}?LOCAL_ROW_OWNED_PARAMS[\s\S]{0,120}?RECIPE_OWNED_PARAMS/)
  })
})
