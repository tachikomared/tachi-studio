// apps/desktop/test/unit/canvasMediaLocalThreading.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 3D — items 1 & 2.
//
// STANDING RULE: every media feature wires into the nodes tab. Two gaps this
// pins, both at the ENGINE-ASSEMBLY seam graph-to-agentkit owns for the LOCAL
// route (argv-level, per the mediaChainOrder / canvasLocalNegative SdCall
// pattern — what is asserted is the input that reaches the engine client, not
// "a file appeared"):
//
//  1. KOKORO ON THE CANVAS. useMediaModels' local-TTS list was piper-only
//     (MediaPage's composer has offered STUDIO/kokoro voices since 4f384a5,
//     but the canvas node never did). Now that useMediaModels also lists
//     kokoro voices, runMediaNode's local/tts branch has to actually route a
//     kokoro voice id to kokoroSynthesize + saveWavToMediaLibrary (the SAME
//     synth → save-to-disk wire MediaPage's composer uses, so a canvas kokoro
//     artifact gets a `path` and can be Saved / survives a restart) rather
//     than handing every model id to piperSynthesize regardless.
//
//  2. LORAS / VAE ON THE CANVAS. MediaPage's composer sends `loras` (slug +
//     weight, the `<lora:…>` tag ingredients — 7c42c26's localSelections) and
//     `vaeAdapterId` (the `--vae` swap) on every local image/video call. A
//     canvas media node's `params` bag never reached the engine with either
//     field: this pins that IF a node's params carries them, the engine now
//     receives them too, so the canvas is not a second, adapter-blind route.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// hoisted: the media service chain reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-canvas-thread-'))
})

/** Where the fake sd-cpp engine client writes its bytes. */
const OUTDIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-canvas-thread-out-'))
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

// ── the local sd.cpp engine, stubbed at the seam graph-to-agentkit calls ─────
interface SdCall {
  modelId: string
  prompt: string
  loras?: Array<{ slug: string; weight?: number; highNoise?: boolean }>
  vaeAdapterId?: string
}
const sd = vi.hoisted(() => ({ image: [] as SdCall[], video: [] as SdCall[] }))

vi.mock('../../electron/services/sd-cpp-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('node:path') as typeof import('node:path')
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

// ── piper (the pre-existing local TTS route — must stay untouched for a
// non-kokoro voice id) ────────────────────────────────────────────────────
const piper = vi.hoisted(() => ({ calls: [] as Array<{ voiceId: string; text: string }> }))

vi.mock('../../electron/services/piper-client', () => ({
  synthesize: vi.fn(async (input: { voiceId: string; text: string }) => {
    piper.calls.push({ ...input })
    return { path: `/fake/piper/${input.voiceId}.wav`, b64: Buffer.from('PIPER-BYTES').toString('base64'), mime: 'audio/wav' }
  }),
}))

// ── kokoro-tts — mocked at the seam runMediaNode now calls ──────────────────
const kokoro = vi.hoisted(() => ({
  installed:  true,
  synthFail:  false,
  saveFail:   false,
  synthCalls: [] as Array<{ text: string; voice: string }>,
  saveCalls:  [] as Array<{ b64: string; name: string }>,
}))

vi.mock('../../electron/services/kokoro-tts', () => ({
  // A small fake catalog — the id is all runMediaNode's routing check reads;
  // its shape mirrors the real KOKORO_VOICES entry (id/label/gender/accent/grade).
  KOKORO_VOICES: [{ id: 'af_heart', label: 'Heart — US female, studio (A)', gender: 'f', accent: 'us', grade: 'A' }],
  kokoroInstalled: vi.fn(() => kokoro.installed),
  kokoroSynthesize: vi.fn(async (input: { text: string; voice: string }) => {
    kokoro.synthCalls.push({ ...input })
    if (kokoro.synthFail) return { ok: false, error: 'kokoro synth boom' }
    return { ok: true, b64: Buffer.from(`KOKORO-WAV-${input.voice}`).toString('base64') }
  }),
  saveWavToMediaLibrary: vi.fn((input: { b64: string; name: string }) => {
    kokoro.saveCalls.push({ ...input })
    if (kokoro.saveFail) return { ok: false, error: 'kokoro save boom' }
    return { ok: true, path: `/fake/media/kokoro/${input.name}` }
  }),
}))

import { runMediaNode } from '../../electron/services/graph-to-agentkit'
import type { TachiFlow, TachiMediaNode, TachiNode } from '../../src/pages/nodes/types'

/** A curated Wan row — same one canvasLocalNegative.test.ts pins as "cfg 6,
 *  its negative is LIVE". Reused here only as a real, schema-resolvable id. */
const WAN_ROW = 'wan21-t2v-1.3b'
/** A curated local IMAGE row with no row negative of its own. */
const SD_ROW = 'sd15'

function mediaNode(
  id: string,
  modality: 'image' | 'video' | 'tts',
  model: string,
  params: Record<string, unknown> = {},
): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 },
    data: { label: id, modality, provider: 'local', model, prompt: `prompt for ${id}`, params },
  } as TachiNode
}

const flowOf = (nodes: TachiNode[]): TachiFlow => ({ name: 'thread', nodes, edges: [] } as TachiFlow)

async function run(node: TachiNode) {
  const flow = flowOf([node])
  return runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
}

beforeEach(() => {
  sd.image.length = 0
  sd.video.length = 0
  piper.calls.length = 0
  kokoro.installed = true
  kokoro.synthFail = false
  kokoro.saveFail = false
  kokoro.synthCalls.length = 0
  kokoro.saveCalls.length = 0
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. KOKORO VOICE ROUTING — a kokoro id never reaches piper, and vice versa
// ═════════════════════════════════════════════════════════════════════════════

describe('local TTS: a kokoro voice id routes to kokoroSynthesize, not piper', () => {
  it('synthesizes via kokoro with the exact (text, voice) pair', async () => {
    const r = await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(r.ok).toBe(true)
    expect(kokoro.synthCalls).toEqual([{ text: 'prompt for tts', voice: 'af_heart' }])
    expect(piper.calls).toHaveLength(0)
  })

  it('the resulting artifact carries a PATH (not b64-only) — Save survives a restart', async () => {
    const r = await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(r.ok).toBe(true)
    expect(r.artifacts).toHaveLength(1)
    expect(r.artifacts[0]!.path).toMatch(/^\/fake\/media\/kokoro\//)
    expect(r.artifacts[0]!.b64).toBeTruthy()
    expect(r.artifacts[0]!.mimeType).toBe('audio/wav')
  })

  it('saveWavToMediaLibrary is handed the bytes kokoroSynthesize returned', async () => {
    await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(kokoro.saveCalls).toHaveLength(1)
    expect(kokoro.saveCalls[0]!.b64).toBe(Buffer.from('KOKORO-WAV-af_heart').toString('base64'))
    expect(kokoro.saveCalls[0]!.name.endsWith('.wav')).toBe(true)
  })

  it('a NON-kokoro voice id is unaffected — still piper, exactly as before', async () => {
    const r = await run(mediaNode('tts', 'tts', 'en_US-amy-medium'))
    expect(r.ok).toBe(true)
    expect(piper.calls).toEqual([{ voiceId: 'en_US-amy-medium', text: 'prompt for tts' }])
    expect(kokoro.synthCalls).toHaveLength(0)
    expect(r.artifacts[0]!.path).toBe('/fake/piper/en_US-amy-medium.wav')
  })
})

describe('local TTS: kokoro failure paths surface, never throw', () => {
  it('an uninstalled kokoro model fails cleanly with no synth attempt', async () => {
    kokoro.installed = false
    const r = await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(kokoro.synthCalls).toHaveLength(0)
  })

  it('a failed synth resolves ok:false with its own message', async () => {
    kokoro.synthFail = true
    const r = await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('kokoro synth boom')
  })

  it('a failed save also resolves ok:false, distinct from a synth failure', async () => {
    kokoro.saveFail = true
    const r = await run(mediaNode('tts', 'tts', 'af_heart'))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('kokoro save boom')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. LORAS / VAE ADAPTER THREADING — the canvas can reach the same engine
//    fields the composer's localSelections already send (7c42c26)
// ═════════════════════════════════════════════════════════════════════════════

describe('local image: params.loras and params.vaeAdapterId reach the engine', () => {
  it('a single LoRA (slug + weight) is forwarded verbatim', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { loras: [{ slug: 'my-style', weight: 0.8 }] }))
    expect(sd.image[0]!.loras).toEqual([{ slug: 'my-style', weight: 0.8 }])
  })

  it('multiple LoRAs keep their order', async () => {
    await run(mediaNode('img', 'image', SD_ROW, {
      loras: [{ slug: 'a', weight: 0.5 }, { slug: 'b', weight: 1 }],
    }))
    expect(sd.image[0]!.loras).toEqual([{ slug: 'a', weight: 0.5 }, { slug: 'b', weight: 1 }])
  })

  it('vaeAdapterId is forwarded', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { vaeAdapterId: 'my-vae-adapter' }))
    expect(sd.image[0]!.vaeAdapterId).toBe('my-vae-adapter')
  })

  it('no loras/vaeAdapterId on the node sends NEITHER key (unchanged default)', async () => {
    await run(mediaNode('img', 'image', SD_ROW, {}))
    expect(sd.image[0]!.loras).toBeUndefined()
    expect(sd.image[0]!.vaeAdapterId).toBeUndefined()
  })

  it('a whitespace-only vaeAdapterId is treated as absent', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { vaeAdapterId: '   ' }))
    expect(sd.image[0]!.vaeAdapterId).toBeUndefined()
  })

  it('a highNoise tag survives when explicitly true', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { loras: [{ slug: 'hn', weight: 1, highNoise: true }] }))
    expect(sd.image[0]!.loras).toEqual([{ slug: 'hn', weight: 1, highNoise: true }])
  })

  it('malformed entries are dropped, not sent half-formed', async () => {
    await run(mediaNode('img', 'image', SD_ROW, {
      loras: [{ slug: '' }, { notASlug: 1 }, null, 'garbage', { slug: 'ok' }],
    }))
    expect(sd.image[0]!.loras).toEqual([{ slug: 'ok' }])
  })

  it('a non-array loras value is ignored entirely', async () => {
    await run(mediaNode('img', 'image', SD_ROW, { loras: 'not-an-array' }))
    expect(sd.image[0]!.loras).toBeUndefined()
  })
})

describe('local video: the SAME two fields reach generateVideo', () => {
  it('loras + vaeAdapterId both thread through on a video node', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, {
      duration: 2,
      loras: [{ slug: 'wan-style', weight: 0.7 }],
      vaeAdapterId: 'wan-vae',
    }))
    expect(sd.video[0]!.loras).toEqual([{ slug: 'wan-style', weight: 0.7 }])
    expect(sd.video[0]!.vaeAdapterId).toBe('wan-vae')
  })

  it('an untouched video node sends neither key', async () => {
    await run(mediaNode('vid', 'video', WAN_ROW, { duration: 2 }))
    expect(sd.video[0]!.loras).toBeUndefined()
    expect(sd.video[0]!.vaeAdapterId).toBeUndefined()
  })
})
