// apps/desktop/test/unit/sdCppAdapters.test.ts
//
// A DOWNLOADED LoRA WAS INERT, AND NOTHING SAID SO.
//
// Spec §3's run-truth matrix, verbatim: "LORA / LoCon / LyCORIS — YES,
// --lora-model-dir + `<lora:name:weight>` IN PROMPT (no --lora flag exists) —
// buildSdArgs never emits it; a downloaded LoRA is inert." Same for
// TextualInversion (`--embd-dir`, never emitted) and for VAE, which could only
// ever reach the MULTI-component branch, so a single-file SDXL checkpoint could
// never swap one — the fp16 black-image trap with no way out.
//
// The failure mode is the one the whole ecosystem tolerates: the weights load,
// nothing is applied, the image is simply different from what the user asked
// for, and the only evidence is a console line (ComfyUI's own comfy/lora.py:93).
// So every assertion below is about the ARGV — the one artifact that decides
// whether the adapter ran.
//
// Also pinned here, because they share the arg builder:
//   • audit D4 — the arg builder reads the MERGED row (curated ∪ user). It used
//     to read SD_IMAGE_MODELS only, so an installed Civitai SDXL checkpoint ran
//     at 512x512 / 20 steps / cfg 7 / euler: the SD 1.5 recipe, on SDXL weights.
//   • VIDEO-MODELS-RESEARCH §2 — `--scheduler` / `--flow-shift` (the distill
//     trap), `--tae` (the decode peak that killed a 49-frame render) and
//     `--diffusion-fa`. All three are OMITTED unless something asks, so a run
//     that asks for none is byte-identical to before this change.

import { describe, it, expect, vi } from 'vitest'

// hoisted: sd-cpp-client pulls storage-root, which reads app.getPath() at
// IMPORT time (the idiom sdCppGenerateLifecycle.test.ts uses in this dir).
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdadapters-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { buildSdArgs, type SdArgEnv, type SdGenerateInput } from '../../electron/services/sd-cpp-client'
import {
  SD_IMAGE_MODELS, SD_VIDEO_MODELS, SD_ADAPTER_FLAG, SD_ADAPTER_DIR,
  isAdapterCompatible, adapterSlug, findSdRow, type SdGenerationRow,
} from '../../electron/services/sd-cpp-models'
import {
  userSdAdapterFromCivitaiRow, adapterKindForCivitaiType, normalizeTriggerWords,
  type CivitaiRowLike,
} from '../../electron/services/user-sd-models'
import { promptWithLoraTags, normalizeLoraWeight } from '../../src/pages/media/localGenParams'

const SINGLE = { model: 'C:/w/sd15/model.safetensors' }
const MULTI  = {
  diffusion: 'C:/w/flux/diffusion.gguf',
  vae:       'C:/w/flux/vae.safetensors',
  clip_l:    'C:/w/flux/clip_l.safetensors',
  t5xxl:     'C:/w/flux/t5xxl.gguf',
}
const LORA_DIR = 'C:/w/loras'
const EMBD_DIR = 'C:/w/embeddings'

const base = (over: Partial<SdGenerateInput> = {}): SdGenerateInput =>
  ({ modelId: 'sd15', prompt: 'a cat on a roof', ...over })

/** The value that follows `flag` in an argv, or undefined. */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

describe('LoRA: the tag goes in the PROMPT and the directory flag goes beside it', () => {
  it('emits NOTHING when no LoRA was selected — the untouched path stays untouched', () => {
    const args = buildSdArgs(SINGLE, base(), 'C:/out.png', { adapterDirs: { lora: LORA_DIR } })
    expect(args).not.toContain('--lora-model-dir')
    expect(valueOf(args, '-p')).toBe('a cat on a roof')
  })

  it('writes `<lora:slug:weight>` into -p AND passes --lora-model-dir', () => {
    const args = buildSdArgs(
      SINGLE,
      base({ loras: [{ slug: 'add-detail-9f3c1a2b', weight: 0.8 }] }),
      'C:/out.png',
      { adapterDirs: { lora: LORA_DIR } },
    )
    expect(valueOf(args, '-p')).toBe('a cat on a roof <lora:add-detail-9f3c1a2b:0.8>')
    expect(valueOf(args, '--lora-model-dir')).toBe(LORA_DIR)
    // …and it is the flag the registry names, not one we invented.
    expect(SD_ADAPTER_FLAG.lora).toBe('--lora-model-dir')
  })

  it('BOTH HALVES OR NEITHER: no directory ⇒ no tag either', () => {
    // A tag the engine cannot resolve is the silent no-op this feature exists
    // to prevent — it would look applied in the prompt and do nothing.
    const args = buildSdArgs(SINGLE, base({ loras: [{ slug: 'x-1a2b3c4d', weight: 1 }] }), 'C:/out.png')
    expect(args).not.toContain('--lora-model-dir')
    expect(valueOf(args, '-p')).toBe('a cat on a roof')
  })

  it('stacks several LoRAs in selection order', () => {
    const args = buildSdArgs(
      SINGLE,
      base({ loras: [{ slug: 'a-11111111', weight: 1 }, { slug: 'b-22222222', weight: 0.35 }] }),
      'C:/out.png',
      { adapterDirs: { lora: LORA_DIR } },
    )
    expect(valueOf(args, '-p')).toBe('a cat on a roof <lora:a-11111111:1> <lora:b-22222222:0.35>')
    expect((args.filter(a => a === '--lora-model-dir')).length).toBe(1)
  })

  it('a weight of 0 is DROPPED (it is the engine\'s own no-op) and out-of-band weights clamp', () => {
    expect(promptWithLoraTags('p', [{ slug: 'z-00000000', weight: 0 }])).toBe('p')
    expect(normalizeLoraWeight(9)).toBe(2)
    expect(normalizeLoraWeight(-9)).toBe(-2)
    // A slider can produce 0.7500000000000001; the tag is parsed by the engine.
    expect(normalizeLoraWeight(0.7500000000000001)).toBe(0.75)
    expect(promptWithLoraTags('p', [{ slug: 'z-00000000' }])).toBe('p <lora:z-00000000:1>')
  })

  it('the VIDEO path gets the same treatment (the speed-distill LoRAs are the point)', () => {
    // 20 steps → 4 is the whole reason the video path needs LoRAs at all
    // (VIDEO-MODELS-RESEARCH §2 lever 2), so a tag that never reached vid_gen
    // would be the same inert download one modality over.
    // The vid_gen argv moved out of generateVideo into the PURE
    // buildSdVideoArgs (the two Wan 2.2 rows gave it row-derived arithmetic
    // that source-reading cannot check) — so this reads the builder, and
    // sdVideoRowTruth.test.ts asserts the rest by CALLING it.
    const src = readClient()
    const vid = between(src, 'export function buildSdVideoArgs', 'export function generateVideo')
    // The prompt is the picker's tags appended to the TYPED tags already
    // resolved (resolveTypedLoraTags), and the directory now follows the
    // FINISHED prompt rather than the selection count — a tag can also arrive
    // typed, and with no directory the engine conditions on its literal text.
    expect(vid).toContain('const vPrompt = promptWithLoraTags(vTyped.prompt, vLoras)')
    expect(vid).toContain("args.push('-p', vPrompt)")
    expect(vid).toContain("if (vLoraDir && hasLoraTag(vPrompt)) args.push('--lora-model-dir', vLoraDir)")
    // …and generateVideo builds its argv from it rather than keeping a copy.
    expect(src).toContain('const args = buildSdVideoArgs(c, input, outPath, env)')
  })
})

describe('Textual inversion: the directory IS the mechanism', () => {
  it('--embd-dir is passed whenever one embedding is installed, LoRAs or not', () => {
    // The engine matches the FILE STEM against words in the prompt, so there is
    // nothing to select and nothing to tag — only a directory to scan.
    const args = buildSdArgs(SINGLE, base(), 'C:/out.png', { adapterDirs: { embedding: EMBD_DIR } })
    expect(valueOf(args, '--embd-dir')).toBe(EMBD_DIR)
    expect(SD_ADAPTER_FLAG.embedding).toBe('--embd-dir')
  })

  it('…and NOT when nothing is installed (a flag that scans nothing is noise)', () => {
    expect(buildSdArgs(SINGLE, base(), 'C:/out.png', {})).not.toContain('--embd-dir')
  })
})

describe('VAE: reachable on the SINGLE-FILE branch for the first time', () => {
  it('a selected VAE adapter reaches `-m` runs (the fp16 black-image trap)', () => {
    const args = buildSdArgs(SINGLE, base(), 'C:/out.png', { vaePath: 'C:/w/vae/fix-1a2b3c4d.safetensors' })
    expect(args).toContain('-m')
    expect(valueOf(args, '--vae')).toBe('C:/w/vae/fix-1a2b3c4d.safetensors')
  })

  it('nothing selected ⇒ no --vae on a row that ships none', () => {
    expect(buildSdArgs(SINGLE, base(), 'C:/out.png', {})).not.toContain('--vae')
  })

  it('on the multi-component branch the SELECTION out-votes the row\'s own vae', () => {
    const args = buildSdArgs(MULTI, base({ modelId: 'flux-schnell-q4' }), 'C:/out.png',
      { vaePath: 'C:/w/vae/user-99887766.safetensors' })
    expect(valueOf(args, '--vae')).toBe('C:/w/vae/user-99887766.safetensors')
    expect(args).not.toContain(MULTI.vae)
  })

  it('…and falls back to the row\'s own vae when nothing is selected', () => {
    const args = buildSdArgs(MULTI, base({ modelId: 'flux-schnell-q4' }), 'C:/out.png', {})
    expect(valueOf(args, '--vae')).toBe(MULTI.vae)
  })
})

describe('the zero-risk engine levers (VIDEO-MODELS-RESEARCH §2)', () => {
  it('--tae is passed only when a decoder file was found', () => {
    expect(buildSdArgs(SINGLE, base(), 'C:/out.png', {})).not.toContain('--tae')
    const args = buildSdArgs(SINGLE, base(), 'C:/out.png', { taePath: 'C:/w/sd15/taesd.safetensors' })
    expect(valueOf(args, '--tae')).toBe('C:/w/sd15/taesd.safetensors')
  })

  it('--diffusion-fa is CUDA-only (it is a CUDA kernel, not a preference)', () => {
    expect(buildSdArgs(SINGLE, base(), 'C:/out.png', {})).not.toContain('--diffusion-fa')
    expect(buildSdArgs(SINGLE, base(), 'C:/out.png', { cuda: true })).toContain('--diffusion-fa')
  })

  it('--scheduler / --flow-shift are ABSENT unless upstream itself passes one', () => {
    // sd-cli's default is model-specific and correct for a normal run; passing
    // one where none is needed changes output for no reason. So a row may only
    // declare one when UPSTREAM'S OWN example command for that model does —
    // which today is three rows, all three from docs/wan.md at the pinned
    // commit, and all three carrying `--flow-shift 3.0` and nothing else: the
    // Wan 2.1 i2v command, the Wan 2.2 TI2V-5B pair of commands, and the Wan 2.2
    // I2V A14B one. (The 1.3B t2v example passes it too, but that row predates
    // this rule and changing its output is not this lane's business.) The T2V
    // A14B row joined 2026-07-31 — upstream's own "Wan2.2 T2V A14B" command
    // (docs/wan.md, same pin) also carries `--flow-shift 3.0`, read verbatim
    // rather than assumed from its i2v sibling.
    const DECLARED: Record<string, { scheduler?: string; flowShift?: number }> = {
      'wan21-i2v-14b-480p': { flowShift: 3 },
      'wan22-ti2v-5b':      { flowShift: 3 },
      'wan22-i2v-a14b':     { flowShift: 3 },
      'wan22-t2v-a14b':     { flowShift: 3 },
    }
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      const want = DECLARED[m.id] ?? {}
      expect(m.scheduler, m.id).toBe(want.scheduler)
      expect(m.flowShift, m.id).toBe(want.flowShift)
    }
    // NO curated row declares a scheduler: `simple` is the DISTILL lever, and
    // nothing we ship is a distill that needs it (research §2, the trap).
    expect([...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS].every(m => m.scheduler === undefined)).toBe(true)
    const args = buildSdArgs(SINGLE, base(), 'C:/out.png', { row: imageRow('sd15') })
    expect(args).not.toContain('--scheduler')
    expect(args).not.toContain('--flow-shift')
  })

  it('a DISTILL row carries them, and an explicit input still wins', () => {
    // THE SCHEDULER TRAP: sd.cpp's Wan default is DISCRETE, which at 4 steps
    // emits t=999/666/333/0 — not the timesteps a distill was trained on — so
    // the output looks bad and the LoRA gets blamed.
    const row: SdGenerationRow = { ...imageRow('sd15'), scheduler: 'simple', flowShift: 5 }
    const fromRow = buildSdArgs(SINGLE, base(), 'C:/out.png', { row })
    expect(valueOf(fromRow, '--scheduler')).toBe('simple')
    expect(valueOf(fromRow, '--flow-shift')).toBe('5')
    const overridden = buildSdArgs(SINGLE, base({ scheduler: 'karras', flowShift: 3 }), 'C:/out.png', { row })
    expect(valueOf(overridden, '--scheduler')).toBe('karras')
    expect(valueOf(overridden, '--flow-shift')).toBe('3')
  })

  it('a run that asks for none of it is byte-identical to the pre-change argv', () => {
    const args = buildSdArgs(SINGLE, base({ steps: 20, cfgScale: 7, samplingMethod: 'euler_a', seed: 5 }), 'C:/out.png',
      { row: imageRow('sd15') })
    expect(args).toEqual([
      '-m', SINGLE.model,
      '-p', 'a cat on a roof',
      '-W', '512', '-H', '512',
      '--steps', '20', '--cfg-scale', '7', '--sampling-method', 'euler_a',
      '--seed', '5',
      '-o', 'C:/out.png',
    ])
  })
})

describe('audit D4 — the arg builder reads the MERGED row, not the curated const', () => {
  it('a USER row\'s own grid and recipe reach sd-cli', () => {
    // user-sd-models stamps sdxl → 1024 / 28 / 5 / dpm++2m per family; the
    // curated-only lookup this replaced produced 512 / 20 / 7 / euler for it.
    const userRow: SdGenerationRow = {
      kind: 'image', id: 'civitai-812345', name: 'Juggernaut X', family: 'sdxl',
      baseSize: 1024, steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m',
      files: [{ role: 'model', url: 'https://x/y', sha256: 'a'.repeat(64), sizeMb: 6617 }],
    }
    const args = buildSdArgs(SINGLE, base({ modelId: 'civitai-812345' }), 'C:/out.png', { row: userRow })
    expect(valueOf(args, '-W')).toBe('1024')
    expect(valueOf(args, '-H')).toBe('1024')
    expect(valueOf(args, '--steps')).toBe('28')
    expect(valueOf(args, '--cfg-scale')).toBe('5')
    expect(valueOf(args, '--sampling-method')).toBe('dpm++2m')
  })

  it('an UNKNOWN id still falls back to the old 512/20/7/euler defaults, not to NaN', () => {
    const args = buildSdArgs(SINGLE, base({ modelId: 'nope-not-a-model' }), 'C:/out.png', {})
    expect(valueOf(args, '-W')).toBe('512')
    expect(valueOf(args, '--steps')).toBe('20')
    expect(valueOf(args, '--cfg-scale')).toBe('7')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
  })

  it('findSdRow answers for a curated image row AND a curated video row', () => {
    const img = findSdRow('sd15', [])
    expect(img?.kind).toBe('image')
    expect(img && img.kind === 'image' ? img.baseSize : null).toBe(512)
    const vid = findSdRow('wan21-t2v-1.3b', [])
    expect(vid?.kind).toBe('video')
    expect(vid && vid.kind === 'video' ? vid.frames : null).toBe(33)
  })

  it('the tachi-gen chunk records the prompt AS RUN, LoRA tags included', () => {
    // Provenance that omits the tags cannot reproduce its own image.
    // The chunk is written PER IMAGE now (a `--batch-count` run stamps N files),
    // so the embed lives in collectSdImages — and the row still arrives from the
    // caller as `env.row` rather than being looked up a second time.
    const embed = between(readClient(), 'export function collectSdImages', 'const withMeta')
    // Read out of the argv when the caller has one (`promptSent`), because a
    // TYPED tag is rewritten to an on-disk slug or dropped before the run — so
    // recomputing from `input.prompt` would stamp a prompt that never ran. The
    // recomputation stays as the fallback for callers with no argv.
    expect(embed).toContain('ctx.promptSent ?? promptWithLoraTags(input.prompt, input.loras)')
    // …from the SAME row the arg builder used, or the provenance repeats the
    // curated fallback rather than the row that ran (audit D4).
    expect(embed).toContain('const rowSize  = row && row.kind === \'image\' ? row.baseSize : undefined')
    expect(readClient()).toContain('input, effective, engineLog, row: env.row,')
    expect(readClient()).toContain('...(pAt >= 0 ? { promptSent: args[pAt + 1] } : {}),')
  })
})

describe('COMPAT AT GENERATE — the feature InvokeAI users name first (spec §5-6)', () => {
  it('an adapter runs only on its own family', () => {
    expect(isAdapterCompatible({ family: 'sd15' }, 'sd15')).toBe(true)
    expect(isAdapterCompatible({ family: 'sd15' }, 'sdxl')).toBe(false)
    expect(isAdapterCompatible({ family: 'sdxl' }, 'sd15')).toBe(false)
    // …including the video family, which no adapter declares today.
    expect(isAdapterCompatible({ family: 'sdxl' }, 'wan')).toBe(false)
  })

  it('the composer filters by the ACTIVE checkpoint and drops a stale selection', () => {
    const page = readPage()
    // THIS USED TO PIN A BARE `a.family === activeLocalRow.family`. The filter is
    // still family-based and still hides a KNOWN mismatch — that half was right —
    // but the equality also deleted every adapter whose family is UNRECORDED,
    // which is the app rendering its own missing metadata as a verdict about the
    // weights (see mediaHelpers' adapterFamilyVerdict). The rule now lives in one
    // pure function that has all three answers; the page calls it.
    const memo = between(page, 'const adapterPartition = useMemo', 'const compatibleLoras')
    expect(memo).toContain('partitionAdaptersByFamily(localAdapters, activeLocalRow.family)')
    // switching checkpoint prunes: a tag that survives the switch is the silent
    // shape-mismatch no-op with extra steps.
    const prune = between(page, 'const ok = new Set(compatibleAdapters.map(a => a.id))', 'const activeLoras')
    expect(prune).toContain('setSelectedLoras')
    expect(prune).toContain('setSelectedVae')
  })
})

describe('the app owns the on-disk slug (10.7% of real LoRA names contain spaces)', () => {
  it('a name with spaces and punctuation becomes a [a-z0-9-] token', () => {
    const slug = adapterSlug('Add More Details! (v2)', 'ab12cd34ef56')
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    expect(slug).toBe('add-more-details-v2-ab12cd34')
  })

  it('the SAME BYTES always produce the same slug, and two same-named LoRAs do not collide', () => {
    const a = adapterSlug('detail tweaker', 'a'.repeat(64))
    const b = adapterSlug('detail tweaker', 'b'.repeat(64))
    expect(adapterSlug('detail tweaker', 'a'.repeat(64))).toBe(a)   // re-install overwrites
    expect(a).not.toBe(b)                                            // 54 collisions in the top 600
  })

  it('a name with nothing usable in it still yields a legal slug', () => {
    expect(adapterSlug('★★★', 'deadbeef')).toBe('adapter-deadbeef')
    expect(adapterSlug('', '12345678')).toBe('adapter-12345678')
  })

  it('every kind lands in its own directory, because the flags take a DIRECTORY', () => {
    expect(SD_ADAPTER_DIR).toEqual({ lora: 'loras', embedding: 'embeddings', vae: 'vae' })
  })
})

describe('the Civitai → adapter mapper fails CLOSED', () => {
  const row = (over: Partial<CivitaiRowLike & { type?: string }> = {}): CivitaiRowLike & { type?: string } => ({
    id: 'civitai-1', modelId: 1, versionId: 812345, name: 'Detail Tweaker',
    family: 'sd15', baseModel: 'SD 1.5', sizeMb: 144, sha256: 'c'.repeat(64),
    downloadUrl: 'https://civitai.com/api/download/models/812345',
    fileName: 'detail tweaker.safetensors', format: 'SafeTensor',
    type: 'LORA', trainedWords: ['detailed, 1girl, <lora:theirs:1>, '],
    ...over,
  })

  it('maps LORA / LoCon / LyCORIS to `lora` and refuses DoRA outright', () => {
    expect(adapterKindForCivitaiType('LORA')).toBe('lora')
    expect(adapterKindForCivitaiType('LoCon')).toBe('lora')
    expect(adapterKindForCivitaiType('LyCORIS')).toBe('lora')
    expect(adapterKindForCivitaiType('TextualInversion')).toBe('embedding')
    expect(adapterKindForCivitaiType('VAE')).toBe('vae')
    // The binary has no dora_scale handling: it would load, silently drop the
    // magnitude vector, and render something that is quietly not the weights.
    expect(adapterKindForCivitaiType('DoRA')).toBeNull()
    expect(adapterKindForCivitaiType('Hypernetwork')).toBeNull()
  })

  it('a mapped row carries a legal slug, the family gate, and normalized triggers', () => {
    const a = userSdAdapterFromCivitaiRow(row())
    expect(a.kind).toBe('lora')
    expect(a.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    expect(a.slug).not.toContain(' ')
    expect(a.family).toBe('sd15')
    expect(a.defaultWeight).toBe(1)
    // One comma-joined string with trailing junk is the real shape; the pasted
    // <lora:…> tag names a file that is not on this disk, so it is dropped.
    expect(a.triggerWords).toEqual(['detailed', '1girl'])
  })

  it('refuses an unmappable base, a refused container, and a type we do not apply', () => {
    expect(() => userSdAdapterFromCivitaiRow(row({ family: null }))).toThrow(/base model/i)
    expect(() => userSdAdapterFromCivitaiRow(row({ format: 'PickleTensor' }))).toThrow(/pickle/i)
    expect(() => userSdAdapterFromCivitaiRow(row({ type: 'DoRA' }))).toThrow(/not something this engine applies/i)
  })

  it('normalizeTriggerWords de-duplicates case-insensitively and caps the list', () => {
    expect(normalizeTriggerWords('a, A, b')).toEqual(['a', 'b'])
    expect(normalizeTriggerWords(Array.from({ length: 40 }, (_, i) => `w${i}`)).length).toBe(20)
    expect(normalizeTriggerWords(undefined)).toEqual([])
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function readClient(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolve } = require('node:path') as typeof import('node:path')
  return readFileSync(resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8')
}

function readPage(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolve } = require('node:path') as typeof import('node:path')
  return readFileSync(resolve(__dirname, '..', '..', 'src/pages/media/MediaPage.tsx'), 'utf8')
}

/** Non-vacuous slice between two anchors (civitaiCatalogTab's `between`). */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(100)
  return body
}

function imageRow(id: string): SdGenerationRow {
  const m = SD_IMAGE_MODELS.find(x => x.id === id)!
  return { kind: 'image', ...m }
}

// `SdArgEnv` is imported for its type only; this keeps the import honest.
const _envShape: SdArgEnv = {}
void _envShape
