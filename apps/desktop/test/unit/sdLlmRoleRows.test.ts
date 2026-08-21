// apps/desktop/test/unit/sdLlmRoleRows.test.ts
//
// THE `llm` FILE ROLE, AND THE THREE ROWS IT (AND clip_vision) UNLOCK.
//
// LOWVRAM-META-RESEARCH §3, verbatim: "SdFileRole has no 'llm'; sd-cpp-client
// emits no --llm. ~3 LINES (role → flag) unlock Z-Image Turbo/Base, Klein-4B/9B,
// Flux.2-dev, and every future LLM-conditioned arch at our pin. Highest
// leverage-per-line item of both passes."
//
// The flag is NOT a guess. `sd-cli --help` on the INSTALLED pinned binary
// (master-782-b290693) prints, under Context Options:
//
//     --llm <string>           path to the llm text encoder. For example:
//                              (qwenvl2.5 for qwen-image, mistral-small3.2 for
//                              flux2, ...)
//     --llm_vision <string>    path to the llm vit
//     --qwen2vl <string>       alias of --llm. Deprecated.
//
// so `--llm` is the CURRENT spelling and `--qwen2vl` the deprecated alias —
// emitting the alias would work today and rot on the next pin bump.
//
// Every param below is source-asserted against upstream's own example command
// at the pinned commit (docs/z_image.md, docs/wan.md), not invented here.

import { describe, it, expect, vi } from 'vitest'

// hoisted: sd-cpp-client pulls storage-root, which reads app.getPath() at
// IMPORT time (the idiom sdCppAdapters.test.ts uses in this dir).
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdllm-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSdArgs, type SdGenerateInput } from '../../electron/services/sd-cpp-client'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  SD_IMAGE_MODELS, SD_VIDEO_MODELS, SD_BLOCKED_MODELS, SD_SAMPLING_METHODS,
  sdFilesWithSha, sdCatalogFiles, isShaPlaceholder, modelTotalMb, presetsForRow,
} from '../../electron/services/sd-cpp-models'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

/** The value that follows `flag` in an argv, or undefined. */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

const zimage = () => SD_IMAGE_MODELS.find(m => m.id === 'z-image-turbo')!
const i2v    = () => SD_VIDEO_MODELS.find(m => m.id === 'wan21-i2v-14b-480p')!
const flux   = () => SD_IMAGE_MODELS.find(m => m.id === 'flux-schnell-q4')!
const t2v    = () => SD_VIDEO_MODELS.find(m => m.id === 'wan21-t2v-1.3b')!

const base = (over: Partial<SdGenerateInput> = {}): SdGenerateInput =>
  ({ modelId: 'z-image-turbo', prompt: 'a cat on a roof', ...over })

// ═══ 1. THE ROLE → THE FLAG ═════════════════════════════════════════════════

describe('the llm role reaches sd-cli as --llm', () => {
  const COMPONENTS = {
    diffusion: 'C:/w/z/diffusion.gguf',
    vae:       'C:/w/z/vae.safetensors',
    llm:       'C:/w/z/llm.gguf',
  }

  it('emits --llm with the component path (the whole feature, in one assertion)', () => {
    const args = buildSdArgs(COMPONENTS, base(), 'C:/out.png')
    expect(args).toContain('--llm')
    expect(valueOf(args, '--llm')).toBe('C:/w/z/llm.gguf')
  })

  it('uses the CURRENT spelling, never the deprecated --qwen2vl alias', () => {
    const args = buildSdArgs(COMPONENTS, base(), 'C:/out.png')
    expect(args).not.toContain('--qwen2vl')
    expect(args).not.toContain('--llm_vision')   // no curated row ships a vit
  })

  it('a row WITHOUT an llm component is byte-identical to before (no empty flag)', () => {
    const fluxComponents = {
      diffusion: 'C:/w/f/diffusion.gguf', vae: 'C:/w/f/vae.safetensors',
      clip_l: 'C:/w/f/clip_l.safetensors', t5xxl: 'C:/w/f/t5xxl.gguf',
    }
    const args = buildSdArgs(fluxComponents, base({ modelId: 'flux-schnell-q4' }), 'C:/out.png')
    expect(args).not.toContain('--llm')
  })

  it('the single-file `-m` branch never emits it either — that shape has no encoder', () => {
    const args = buildSdArgs({ model: 'C:/w/sd15/model.safetensors', llm: 'C:/w/z/llm.gguf' }, base({ modelId: 'sd15' }), 'C:/out.png')
    expect(args).not.toContain('--llm')
    expect(args).toContain('-m')
  })

  it('--clip-on-cpu still rides with the multi-component branch (the llm IS a text encoder)', () => {
    // The research names --clip-on-cpu as the lever that keeps a 2.4 GB Qwen3
    // encoder off the GPU during sampling; it was already emitted here and the
    // new role must not have moved it out of the branch.
    const args = buildSdArgs(COMPONENTS, base(), 'C:/out.png')
    expect(args).toContain('--clip-on-cpu')
  })
})

// ═══ 2. Z-IMAGE TURBO ═══════════════════════════════════════════════════════

describe('the Z-Image Turbo row is upstream\'s own recipe, not a guess', () => {
  it('exists with exactly the three roles the engine needs', () => {
    expect(zimage()).toBeDefined()
    expect(zimage().files.map(f => f.role).sort()).toEqual(['diffusion', 'llm', 'vae'])
  })

  it('carries the distill defaults from docs/z_image.md at the pinned commit', () => {
    // `--cfg-scale 1.0 ... --steps 8` — leejet's own example command.
    expect(zimage().steps).toBe(8)
    expect(zimage().cfgScale).toBe(1.0)
    expect(SD_SAMPLING_METHODS).toContain(zimage().samplingMethod)
    expect(zimage().baseSize).toBe(1024)
  })

  it('cfg 1.0 is what makes the composer drop the guidance slider and call negatives inert', () => {
    // localGenOptionsFor keys `inert` off `row.cfgScale <= 1`, so the row's own
    // number is what disables a control that would otherwise move nothing (the
    // NAG-absence note in the research: at cfg 1 the negative prompt is ignored).
    expect(zimage().cfgScale).toBeLessThanOrEqual(1)
  })

  it('is TURBO — never the Base GGUF, which renders blank white images (#1488, still open)', () => {
    expect(zimage().id).toContain('turbo')
    for (const f of zimage().files) expect(f.url.toLowerCase()).not.toContain('z-image-base')
    expect(zimage().files.find(f => f.role === 'diffusion')!.url)
      .toBe('https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf')
  })

  it('THE ENCODER TRAP: Instruct-2507, not plain Qwen3-4B', () => {
    // leejet pins Qwen3-4B-INSTRUCT-2507; the community uses plain Qwen3-4B,
    // which is a DIFFERENT checkpoint. Same flag, different weights, quietly
    // worse prompts.
    const llm = zimage().files.find(f => f.role === 'llm')!
    expect(llm.url).toContain('Qwen3-4B-Instruct-2507')
    expect(llm.url).toBe('https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf')
    expect(llm.sha256).toBe('3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597')
  })

  it('its VAE is the FLUX.1 autoencoder, BYTE-IDENTICAL — same url, same sha, same size', () => {
    // Z-Image reuses the Flux.1 autoencoder verbatim. Declaring the same file
    // identity is what makes the reuse below possible at all.
    const zv = zimage().files.find(f => f.role === 'vae')!
    const fv = flux().files.find(f => f.role === 'vae')!
    expect(zv.sha256).toBe(fv.sha256)
    expect(zv.url).toBe(fv.url)
    expect(zv.sizeMb).toBe(fv.sizeMb)
    expect(zv.sha256).toBe('afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38')
  })

  it('the incremental download for a FLUX owner is the whole row MINUS the shared VAE', () => {
    const shared = zimage().files.find(f => f.role === 'vae')!.sizeMb
    expect(modelTotalMb(zimage())).toBe(6388)
    expect(modelTotalMb(zimage()) - shared).toBe(6068)
    // …which is SMALLER than the flux row it sits next to, for a newer model.
    expect(modelTotalMb(zimage()) - shared).toBeLessThan(modelTotalMb(flux()))
  })

  it('declares its own family — a flux LoRA must not think it fits', () => {
    // isAdapterCompatible is an equality test on `family`, so calling Z-Image
    // "flux" would let a Flux.1 LoRA load onto an S3-DiT and silently apply
    // nothing (the failure the whole compat gate exists to prevent).
    expect(zimage().family).toBe('zimage')
    expect(zimage().family).not.toBe('flux')
  })

  it('is offered tiers derived from ITS OWN row, never another family\'s ladder', () => {
    const offers = presetsForRow({ ...zimage(), family: zimage().family })
    expect(offers.map(o => o.id)).toEqual(['speed', 'quality'])
    // Guidance stays at 1 in every tier: a CFG-disabled distill has no other
    // honest setting, and the sd15/flux columns would have moved it.
    expect(offers.every(o => o.params.cfgScale === 1)).toBe(true)
    expect(offers.some(o => o.id === 'lightning')).toBe(false)
  })
})

// ═══ 2b. WHAT THE COMPOSER SHOWS FOR IT ═════════════════════════════════════
//
// This row USED to have no column of its own: a family with none falls through
// to the id-substring table, which has matched /z-image|zimage/ since before the
// row existed — a real dependency on a coincidence, which is why the schema the
// composer renders is asserted here rather than assumed.
//
// It has a column now (LOCAL_IMAGE_TIERS in surplus-media-service), because the
// tiers gained an orientation axis and a coincidence of the id cannot carry a
// landscape pair. The numbers below are unchanged by that on purpose: same 1024
// default, same ~2048 family cap.

describe('the Z-Image row narrows the composer the way its own numbers say', () => {
  const specOf = (name: string) => modelParamSchema('image', 'z-image-turbo').find(s => s.name === name)

  it('renders on the 1024 grid, not SD 1.5\'s 512', () => {
    const size = specOf('size')!
    expect(size.default).toBe('1024x1024')
    expect(size.enum).toContain('1024x1024')
    expect(size.enum).not.toContain('2048x2048')   // upstream caps this family at ~2048px
  })

  it('the STEPS slider starts at the row\'s 8 (upstream\'s own --steps 8)', () => {
    expect(specOf('steps')!.default).toBe(8)
  })

  it('the GUIDANCE slider is GONE, because at cfg 1 it would move nothing', () => {
    // sd.cpp's resolve_guidance only encodes an unconditional pass when cfg ≠ 1.
    expect(specOf('cfg')).toBeUndefined()
  })

  it('…and the negative prompt says so out loud instead of pretending to work', () => {
    const neg = specOf('negative_prompt')
    expect(neg?.description ?? '').toMatch(/ignore|inert|no effect|not used/i)
  })

  it('the sampler dropdown offers only names the pinned binary accepts', () => {
    const sampler = specOf('sampler')!
    expect(sampler.default).toBe(zimage().samplingMethod)
    for (const s of sampler.enum ?? []) expect(SD_SAMPLING_METHODS).toContain(s)
  })
})

// ═══ 3. THE i2v ROW — the init-frame control comes back ═════════════════════

describe('Wan 2.1 I2V-14B-480P turns the init-frame control back on', () => {
  it('is the first row that declares i2v, and it ships the clip_vision the flag needs', () => {
    expect(i2v().i2v).toBe(true)
    expect(i2v().files.map(f => f.role).sort()).toEqual(['clip_vision', 'diffusion', 't5xxl', 'vae'])
    // the invariant mediaInitFrame.test.ts pins, restated from the other side.
    // The two Wan 2.2 rows joined it later — and NEITHER ships a clip_vision,
    // which is the point: that file is a Wan 2.1 i2v requirement, not an
    // image→video one (upstream's own 2.2 commands pass no --clip_vision).
    // LTX-2.3 joined them later still, from a THIRD direction: it needs no
    // clip_vision either, and it conditions through `--llm` rather than a umt5
    // — the same role this suite exists for, arriving on a video row.
    expect(SD_VIDEO_MODELS.filter(r => r.i2v).map(r => r.id))
      .toEqual(['wan21-i2v-14b-480p', 'wan22-ti2v-5b', 'wan22-i2v-a14b', 'ltx-2-3-22b-distilled'])
    expect(SD_VIDEO_MODELS.filter(r => r.files.some(f => f.role === 'clip_vision')).map(r => r.id))
      .toEqual(['wan21-i2v-14b-480p'])
    // …and the rows that CANNOT start from an image: the 1.3B t2v, and its
    // A14B text-only twin that joined 2026-07-31 (upstream ships a SEPARATE
    // T2I section for the still-frame variant of that checkpoint — nothing
    // here takes a `-i`).
    expect(SD_VIDEO_MODELS.filter(r => !r.i2v).map(r => r.id))
      .toEqual(['wan21-t2v-1.3b', 'wan22-t2v-a14b'])
  })

  it('carries docs/wan.md\'s own i2v numbers at the pinned commit', () => {
    // `--cfg-scale 6.0 --sampling-method euler --video-frames 33 --flow-shift 3.0`
    expect(i2v().cfgScale).toBe(6)
    expect(i2v().samplingMethod).toBe('euler')
    expect(i2v().frames).toBe(33)
    expect(i2v().flowShift).toBe(3)
    // --steps is not in the example, so the row takes sd-cli's own documented
    // default (`--steps <int>  number of sample steps (default: 20)`).
    expect(i2v().steps).toBe(20)
  })

  it('is a 480p Wan: 4n+1 frames on the 16px grid, at the family\'s native pair', () => {
    expect([i2v().width, i2v().height]).toEqual([832, 480])
    expect(i2v().width % 16).toBe(0)
    expect(i2v().height % 16).toBe(0)
    expect((i2v().frames - 1) % 4).toBe(0)
  })

  it('its vae and t5xxl ARE the 2.1 files already curated — byte-identical, not lookalikes', () => {
    for (const role of ['vae', 't5xxl'] as const) {
      const a = i2v().files.find(f => f.role === role)!
      const b = t2v().files.find(f => f.role === role)!
      expect(a.sha256, role).toBe(b.sha256)
      expect(a.url, role).toBe(b.url)
      expect(a.sizeMb, role).toBe(b.sizeMb)
    }
  })

  it('so a 2.1 owner downloads only the DiT and the clip_vision', () => {
    const shared = i2v().files.filter(f => f.role === 'vae' || f.role === 't5xxl')
      .reduce((a, f) => a + f.sizeMb, 0)
    const total = i2v().files.reduce((a, f) => a + f.sizeMb, 0)
    expect(total).toBe(18029)
    expect(total - shared).toBe(12022)
  })

  it('the video path already emits --clip_vision and -i, so this row is DATA ONLY', () => {
    const client = read('electron/services/sd-cpp-client.ts')
    expect(client).toContain("if (c.clip_vision) args.push('--clip_vision', c.clip_vision)")
    expect(client).toContain("if (input.initImagePath) args.push('-i', input.initImagePath)")
    // …and --flow-shift, which the row now sets to upstream's 3.0. The ?? ladder
    // that resolved it moved into effectiveVideoParams (the speed-pack
    // provenance fix — one resolution, read by the argv AND by the gallery
    // entry), so the pin is on the push and on the resolver's own fallback.
    expect(client).toContain("if (typeof eff.flowShift === 'number') args.push('--flow-shift', String(eff.flowShift))")
    expect(client).toContain('const flowShift = speed?.preset.flowShift ?? input.flowShift ?? m?.flowShift')
  })
})

// ═══ 4. THE sha IDENTITY INDEX (what makes "already on disk" true) ══════════

describe('sdFilesWithSha — one sha, every row that declares it', () => {
  it('finds BOTH the flux row and the Z-Image row for the shared autoencoder', () => {
    const sha = flux().files.find(f => f.role === 'vae')!.sha256
    const hits = sdFilesWithSha(sha, [])
    expect(hits.map(h => h.modelId).sort()).toEqual(['flux-schnell-q4', 'z-image-turbo'])
    expect(hits.every(h => h.role === 'vae')).toBe(true)
  })

  it('finds every Wan row for the umt5 encoder, and every 2.1-VAE row for the 2.1 vae', () => {
    // The two lists differ BY ONE and that difference is load-bearing: all four
    // Wan rows share the 5.6 GB text encoder, but Wan 2.2 TI2V-5B has its own
    // autoencoder ("wan_2.1_vae — for all the wan model except Wan2.2 TI2V 5B").
    // Reuse must engage on the encoder for that row and must NOT engage on the
    // VAE, or the render decodes through the wrong latent format.
    // wan22-t2v-a14b joined both lists 2026-07-31 — the text-only twin shares
    // the SAME umt5 encoder and the SAME 2.1 vae as every other Wan row here.
    const shaOf = (role: 'vae' | 't5xxl') => t2v().files.find(f => f.role === role)!.sha256
    expect(sdFilesWithSha(shaOf('t5xxl'), []).map(h => h.modelId).sort())
      .toEqual(['wan21-i2v-14b-480p', 'wan21-t2v-1.3b', 'wan22-i2v-a14b', 'wan22-t2v-a14b', 'wan22-ti2v-5b'])
    expect(sdFilesWithSha(shaOf('vae'), []).map(h => h.modelId).sort())
      .toEqual(['wan21-i2v-14b-480p', 'wan21-t2v-1.3b', 'wan22-i2v-a14b', 'wan22-t2v-a14b'])
  })

  it('the TI2V-5B t5xxl declaration IS the curated file, byte for byte', () => {
    // The dedup only engages on an EXACT sha match, so "already curated" has to
    // be a fact about the bytes, not a claim in a comment: same url, same sha,
    // same size as the row it reuses from.
    const ti2v = SD_VIDEO_MODELS.find(m => m.id === 'wan22-ti2v-5b')!.files.find(f => f.role === 't5xxl')!
    const curated = t2v().files.find(f => f.role === 't5xxl')!
    expect({ url: ti2v.url, sha256: ti2v.sha256, sizeMb: ti2v.sizeMb })
      .toEqual({ url: curated.url, sha256: curated.sha256, sizeMb: curated.sizeMb })
    // …and that identity is what the catalog reports to the download panel.
    expect(sdCatalogFiles({ id: 'wan22-ti2v-5b', files: SD_VIDEO_MODELS.find(m => m.id === 'wan22-ti2v-5b')!.files }, [])
      .find(f => f.role === 't5xxl')!.sharedWith.sort())
      .toEqual(['wan21-i2v-14b-480p', 'wan21-t2v-1.3b', 'wan22-i2v-a14b', 'wan22-t2v-a14b'])
  })

  it('is case-insensitive and answers nothing for an unknown sha', () => {
    const sha = flux().files.find(f => f.role === 'vae')!.sha256
    expect(sdFilesWithSha(sha.toUpperCase(), []).length).toBe(2)
    expect(sdFilesWithSha('f'.repeat(64), [])).toEqual([])
  })

  it('NEVER matches on a placeholder — an unverifiable sha is not an identity', () => {
    expect(sdFilesWithSha('__SHA_PLACEHOLDER_X__', [])).toEqual([])
  })
})

// ═══ 5. KLEIN-4B — data complete, deliberately NOT shipped ══════════════════

describe('FLUX.2 Klein 4B is gated, with the reason written down', () => {
  const klein = () => SD_BLOCKED_MODELS.find(m => m.id === 'flux2-klein-4b')!

  it('is NOT in the curated registry — a row whose components cannot be resolved is a dead Download button', () => {
    expect(SD_IMAGE_MODELS.find(m => m.id === 'flux2-klein-4b')).toBeUndefined()
    expect(klein()).toBeDefined()
  })

  it('the DiT it would use is fully pinned (verified, so the next lane re-verifies nothing)', () => {
    const dit = klein().files.find(f => f.role === 'diffusion')!
    expect(dit.url).toBe('https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_0.gguf')
    expect(dit.sha256).toBe('d1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4')
    expect(dit.sizeMb).toBe(2347)
    expect(isShaPlaceholder(dit.sha256)).toBe(false)
  })

  it('names BOTH unresolved components in `blocked`, and neither is invented as a file', () => {
    const why = klein().blocked
    expect(why).toMatch(/vae/i)
    expect(why).toMatch(/llm|encoder/i)
    expect(why).toContain('FLUX.2-dev')   // where upstream's VAE lives, and why it is a problem
    expect(why).toContain('Qwen3-4B')     // plain, NOT the Instruct-2507 Z-Image pins
    // the row must not pretend to have the files it is blocked on
    expect(klein().files.map(f => f.role)).toEqual(['diffusion'])
  })

  it('and it is not a text encoder the Z-Image row can lend it', () => {
    // Architecturally shared --llm, NOT byte-shared: Klein takes plain Qwen3-4B,
    // Z-Image takes Instruct-2507. Any code that "reuses the llm we already
    // have" would be handing Klein the wrong weights.
    expect(klein().blocked).toMatch(/not.*Instruct|Instruct.*not|different/i)
  })
})

// ═══ 6. NO PLACEHOLDERS, NO UNRUNNABLE SAMPLERS ═════════════════════════════

describe('the whole registry stays shippable', () => {
  it('every curated file carries a real sha256 (a placeholder is refused in a packaged build)', () => {
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      for (const f of m.files) {
        expect(isShaPlaceholder(f.sha256), `${m.id}/${f.role}`).toBe(false)
        expect(f.sha256, `${m.id}/${f.role}`).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })

  it('every curated sampler is one the PINNED binary accepts', () => {
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      expect(SD_SAMPLING_METHODS, m.id).toContain(m.samplingMethod)
    }
  })

  it('every curated URL is https and carries a file extension the placer understands', () => {
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS, ...SD_BLOCKED_MODELS]) {
      for (const f of m.files) {
        expect(f.url.startsWith('https://'), `${m.id}/${f.role}`).toBe(true)
        expect(f.url, `${m.id}/${f.role}`).toMatch(/\.(gguf|safetensors|sft)$/)
      }
    }
  })
})
