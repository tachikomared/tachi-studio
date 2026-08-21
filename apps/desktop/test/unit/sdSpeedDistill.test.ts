// apps/desktop/test/unit/sdSpeedDistill.test.ts
//
// THE SPEED PATH: 4-step distill LoRAs, and the preset that has to travel WITH
// them or they get blamed for looking broken.
//
// The owner's complaint is in the i2v row's own notes: "~44 min on a 12 GB
// card" for 33 frames. The fix is arithmetic, not optimism — 20 steps x 2
// forward passes (cond + uncond at guidance 6) = 40 passes becomes 4 steps x 1
// pass (sd.cpp encodes no unconditional branch at cfg 1) = 4 passes. What makes
// it a TRAP rather than a flag is that the pieces are worthless apart:
//
//   • 4 steps WITHOUT the LoRA tags        → noise;
//   • the LoRA WITHOUT `--scheduler simple` → sd.cpp's DISCRETE default emits
//     t = 999/666/333/0, not the 1000/750/500/250 the distill was trained on;
//   • `simple` WITHOUT the right flow shift → still off (see §2 — this is the
//     half the committed research got wrong, and this suite is where the
//     correction is pinned).
//
// So the preset is ONE object applied atomically, and the argv is the gate.
//
// EVERY NUMBER HERE IS SOURCE-CITED:
//  · the tag syntax and the flag names — upstream docs/wan.md at OUR PIN
//    (master-782-b290693), the "Wan2.2 T2V 14B with Lora" command that ships an
//    output video;
//  · the schedule — src/runtime/denoiser.hpp at that same commit (mirrored in
//    §2 below) crossed with lightx2v's published `denoising_step_list`;
//  · the licences and sha256s — the HuggingFace model + tree APIs, 2026-07-31.

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdspeed-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  SD_SPEED_ADAPTERS, SD_BLOCKED_SPEED_ADAPTERS, SD_VIDEO_MODELS,
  SPEED_SCHEDULER, SPEED_FLOW_SHIFT, LIGHTX2V_4STEP_TIMESTEPS,
  SPEED_ADAPTER_SOURCE_LICENSES,
  findSpeedAdapter, speedAdapterForModel, blockedSpeedAdapterFor,
  speedLoraSelections, speedAdapterCatalogFiles, isShaPlaceholder, findSdRow,
  type SdSpeedAdapter, type SdGenerationRow,
} from '../../electron/services/sd-cpp-models'
import { isValidAdapterSlug } from '../../electron/services/user-sd-models'
import {
  speedAdapterFilePath, isSpeedAdapterInstalled, installedSpeedAdapter,
  listSpeedAdapters, installedAdapterDirs, sdAdapterDir,
} from '../../electron/services/sd-cpp-installer'
import { buildSdVideoArgs, type SdVideoInput } from '../../electron/services/sd-cpp-client'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import { promptWithLoraTags, resolveLocalSpeedMode, LORA_HIGH_NOISE_PREFIX } from '../../src/pages/media/localGenParams'

const OUT = 'C:/out/clip.webm'
const A14B = 'wan22-i2v-a14b'
const I2V21 = 'wan21-i2v-14b-480p'
const T2V_A14B = 'wan22-t2v-a14b'

const pack = (id: string): SdSpeedAdapter => {
  const a = findSpeedAdapter(id)
  if (!a) throw new Error(`no speed pack ${id}`)
  return a
}
const videoRow = (id: string): SdGenerationRow => {
  const r = findSdRow(id, [])
  if (!r || r.kind !== 'video') throw new Error(`no video row ${id}`)
  return r
}
/** The value sd-cli is handed for `flag`, or undefined when it is not passed. */
const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const promptOf = (args: string[]): string => valueOf(args, '-p') ?? ''

// The two component shapes the rows below actually run with.
const C_A14B = {
  diffusion: 'C:/w/low.gguf', diffusion_high: 'C:/w/high.gguf',
  vae: 'C:/w/v.safetensors', t5xxl: 'C:/w/t5.gguf',
}
const C_2_1 = {
  diffusion: 'C:/w/d.gguf', vae: 'C:/w/v.safetensors',
  t5xxl: 'C:/w/t5.gguf', clip_vision: 'C:/w/cv.safetensors',
}
const LORA_DIR = 'C:/models/sd/loras'

// ═══ 1. THE REGISTRY: what we ship, and under whose licence ══════════════════

describe('curated speed packs — registry truth', () => {
  it('ships exactly the three rows a licence-clean distill exists for', () => {
    // wan22-t2v-a14b joined 2026-07-31 — the text-only twin of A14B, its own
    // pair of bytes in the SAME lightx2v/Wan2.2-Distill-Loras repo.
    expect(SD_SPEED_ADAPTERS.map(a => a.modelId).sort()).toEqual([I2V21, A14B, T2V_A14B].sort())
  })

  it('every pack names a REAL video row, and at most one pack per row', () => {
    const rows = new Set(SD_VIDEO_MODELS.map(m => m.id))
    const seen = new Set<string>()
    for (const a of SD_SPEED_ADAPTERS) {
      expect(rows.has(a.modelId)).toBe(true)
      expect(seen.has(a.modelId)).toBe(false)
      seen.add(a.modelId)
    }
  })

  // THE LICENCE LAW. Curated means WE fetch the bytes, so the SOURCE REPO has
  // to declare a licence that permits redistribution. Both packs come from
  // lightx2v's own repos, which declare apache-2.0 (HF cardData, 2026-07-31).
  // Kijai/WanVideo_comfy — where the Self-Forcing / CausVid extractions live —
  // declares NONE and must never appear on either side of this registry.
  it('every pack declares a redistributable licence and an https HuggingFace source', () => {
    for (const a of SD_SPEED_ADAPTERS) {
      expect(['apache-2.0', 'mit']).toContain(a.license)
      expect(new URL(a.source).host).toBe('huggingface.co')
      // The pack's own licence must be the one its source repo declares.
      expect(SPEED_ADAPTER_SOURCE_LICENSES[a.source]).toBe(a.license)
    }
  })

  // EVERY BYTE WE FETCH comes from a repo whose licence card was read. Asserted
  // per FILE and not per pack, because one file is legitimately served from a
  // different lightx2v repo than the pack referencing it (the shared 2.1 i2v
  // LoRA is the A14B pack's low-noise expert, byte for byte).
  it('every FILE comes from a repo whose declared licence is on record', () => {
    for (const a of SD_SPEED_ADAPTERS) {
      for (const f of a.files) {
        const url = new URL(f.url)
        expect(url.protocol).toBe('https:')
        expect(url.host).toBe('huggingface.co')
        const repo = Object.keys(SPEED_ADAPTER_SOURCE_LICENSES)
          .find(r => f.url.startsWith(`${r}/resolve/`))
        expect(repo).toBeDefined()
        expect(['apache-2.0', 'mit']).toContain(SPEED_ADAPTER_SOURCE_LICENSES[repo as string])
      }
    }
  })

  it('never sources a pack from a repo that declares no licence', () => {
    for (const a of SD_SPEED_ADAPTERS) {
      for (const f of a.files) {
        expect(f.url.toLowerCase()).not.toContain('/kijai/')
        expect(f.url.toLowerCase()).not.toContain('wanvideo_comfy')
      }
    }
  })

  it('every file carries a real sha256, a positive size and a tag-safe slug', () => {
    for (const a of SD_SPEED_ADAPTERS) {
      expect(a.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(a.files.length).toBeGreaterThan(0)
      for (const f of a.files) {
        expect(isShaPlaceholder(f.sha256)).toBe(false)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.sizeMb).toBeGreaterThan(0)
        // The slug lands on disk AND inside `<lora:slug:weight>` — the same law
        // the user-adapter registry enforces, so it is the same validator.
        expect(isValidAdapterSlug(f.slug)).toBe(true)
        expect(f.weight).toBeGreaterThan(0)
      }
    }
  })

  // A MoE row needs one LoRA per expert, and only a MoE row may carry a
  // `|high_noise|` tag: a single-DiT row has no second pass to aim it at.
  it('only the two-expert rows have a high-noise file, and exactly one of each', () => {
    for (const id of ['wan22-i2v-a14b-speed', 'wan22-t2v-a14b-speed']) {
      const p = pack(id)
      expect(p.files.filter(f => f.highNoise), id).toHaveLength(1)
      expect(p.files.filter(f => !f.highNoise), id).toHaveLength(1)
    }
    expect(pack('wan21-i2v-14b-480p-speed').files.every(f => !f.highNoise)).toBe(true)
  })

  // FILE IDENTITY VS THE I2V PACK: the report that named this pair (0f7df10)
  // could have been describing a rename of the same bytes. It is not — four
  // distinct sha256 values, so the two packs share NOTHING and the T2V pack's
  // `sharedWith` must be empty everywhere.
  it('the T2V A14B pack shares NO bytes with the I2V A14B pack', () => {
    const i2v = pack('wan22-i2v-a14b-speed')
    const t2v = pack('wan22-t2v-a14b-speed')
    const i2vShas = new Set(i2v.files.map(f => f.sha256))
    for (const f of t2v.files) expect(i2vShas.has(f.sha256)).toBe(false)
    for (const f of speedAdapterCatalogFiles(t2v)) expect(f.sharedWith).toEqual([])
  })

  // ONE FILE, TWO PACKS. lightx2v shipped the SAME 739,472,104 bytes as the
  // Wan 2.1 i2v distill and as the Wan 2.2 A14B LOW-noise distill (sha256
  // 8833bd4f…, HF LFS oid, both trees). Two slugs would mean two copies of
  // identical weights in one directory — and the tag names the FILE STEM, so
  // the sharing has to be expressed as one slug, not merely noted in prose.
  it('shares the byte-identical LoRA under ONE slug across both packs', () => {
    const bySha = new Map<string, Set<string>>()
    for (const a of SD_SPEED_ADAPTERS) {
      for (const f of a.files) {
        const set = bySha.get(f.sha256) ?? new Set<string>()
        set.add(f.slug)
        bySha.set(f.sha256, set)
      }
    }
    for (const [sha, slugs] of bySha) expect([sha, [...slugs]]).toEqual([sha, [...slugs].slice(0, 1)])
    // …and the catalog says so, so the second download quotes what is NEW.
    const shared = speedAdapterCatalogFiles(pack('wan22-i2v-a14b-speed'))
      .find(f => f.sharedWith.length > 0)
    expect(shared?.sharedWith).toEqual(['wan21-i2v-14b-480p-speed'])
  })

  it('lists the rows with NO pack, with a reason, and never both at once', () => {
    const rows = new Set(SD_VIDEO_MODELS.map(m => m.id))
    for (const b of SD_BLOCKED_SPEED_ADAPTERS) {
      expect(rows.has(b.modelId)).toBe(true)
      expect(speedAdapterForModel(b.modelId)).toBeUndefined()
      expect(b.blocked.length).toBeGreaterThan(80)   // a reason, not a shrug
    }
    // Every shipped video row is accounted for: it either HAS a pack or SAYS why not.
    for (const m of SD_VIDEO_MODELS) {
      const has = !!speedAdapterForModel(m.id)
      const said = !!blockedSpeedAdapterFor(m.id)
      expect(has || said).toBe(true)
    }
  })

  // The two honest NOs, pinned by the fact that made them NOs — so a later lane
  // that finds a licensed source knows exactly which claim to re-check.
  it('names the 1.3B and TI2V-5B verdicts by their licence reason', () => {
    expect(blockedSpeedAdapterFor('wan21-t2v-1.3b')?.blocked).toMatch(/licence|license/i)
    expect(blockedSpeedAdapterFor('wan22-ti2v-5b')?.blocked).toMatch(/licence|license/i)
  })

  it('orders the tags low-noise first, matching upstream\'s own command', () => {
    const sel = speedLoraSelections(pack('wan22-i2v-a14b-speed'))
    expect(sel.map(s => !!s.highNoise)).toEqual([false, true])
  })
})

// ═══ 2. THE SCHEDULE — WHY flow-shift 1 AND NOT 5 ════════════════════════════
//
// THIS IS THE CORRECTION. VIDEO-MODELS-RESEARCH §2 states that
// "`--scheduler simple --steps 4 --flow-shift 5` reproduces the official
// schedule bit-for-bit". Half of that is right. Below is upstream's own
// arithmetic at our pin, and it puts three of the four timesteps in the wrong
// place at shift 5 — the scheduler trap in a second costume, where the flags
// LOOK like the documented fix and the output is still off-distribution.
//
// Mirrored from src/runtime/denoiser.hpp (master-782-b290693):
//
//   SimpleScheduler::get_sigmas(n): step_factor = 1000 / n;
//     for i in 0..n:  timestep_index = 999 - floor(i * step_factor)
//   time_snr_shift(a, t)              = a == 1 ? t : a*t / (1 + (a - 1)*t)
//   DiscreteFlowDenoiser::t_to_sigma  = time_snr_shift(shift, (t + 1)/1000)
//   DiscreteFlowDenoiser::sigma_to_t  = sigma * 1000   ← what the MODEL sees

const TIMESTEPS = 1000

function simpleTimestepIndices(n: number): number[] {
  const stepFactor = TIMESTEPS / n
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.max(0, TIMESTEPS - 1 - Math.trunc(i * stepFactor)))
  return out
}
function timeSnrShift(alpha: number, t: number): number {
  return alpha === 1 ? t : (alpha * t) / (1 + (alpha - 1) * t)
}
/** The timesteps the model is actually conditioned on, for `--scheduler simple`. */
function modelTimesteps(steps: number, flowShift: number): number[] {
  return simpleTimestepIndices(steps)
    .map(t => timeSnrShift(flowShift, (t + 1) / TIMESTEPS))
    .map(sigma => Math.round(sigma * TIMESTEPS))
}

describe('the distill schedule, derived from upstream\'s own denoiser', () => {
  it('SIMPLE at 4 steps + flow-shift 1 IS lightx2v\'s published denoising_step_list', () => {
    expect(modelTimesteps(4, 1)).toEqual([...LIGHTX2V_4STEP_TIMESTEPS])
    expect([...LIGHTX2V_4STEP_TIMESTEPS]).toEqual([1000, 750, 500, 250])
  })

  it('flow-shift 5 lands three of the four steps OFF the trained schedule', () => {
    // 1000, 937, 833, 625 — the numbers behind the correction, spelled out so a
    // future "fix" back to 5 fails here with the evidence rather than silently.
    expect(modelTimesteps(4, 5)).toEqual([1000, 938, 833, 625])
    expect(modelTimesteps(4, 5)).not.toEqual([...LIGHTX2V_4STEP_TIMESTEPS])
  })

  it('sd.cpp\'s DISCRETE default is the trap the research named', () => {
    // NOT our scheduler — on record so the alternative is legible. The discrete
    // ladder walks sigma_max→0 across the n steps, so at n=4 the model sees
    // 1000 / 667 / 333 / 0: two timesteps the distill never trained on, and a
    // final pass at t=0 that does nothing at all.
    const discrete = [0, 1, 2, 3].map(i => Math.round((1 - i / 3) * TIMESTEPS))
    expect(discrete).toEqual([1000, 667, 333, 0])
    expect(discrete).not.toEqual([...LIGHTX2V_4STEP_TIMESTEPS])
    expect(discrete[3]).toBe(0)
  })

  it('every shipped pack uses those two flags', () => {
    expect(SPEED_SCHEDULER).toBe('simple')
    expect(SPEED_FLOW_SHIFT).toBe(1)
    for (const a of SD_SPEED_ADAPTERS) {
      expect(a.preset.scheduler).toBe('simple')
      expect(a.preset.flowShift).toBe(1)
      expect(a.preset.steps).toBe(4)
      // CFG-DISTILLED: guidance 1 is what skips the unconditional pass, which is
      // the second half of the ~10x. The lightx2v Wan 2.1 line is literally
      // named "StepDistill-CfgDistill".
      expect(a.preset.cfgScale).toBe(1)
    }
  })
})

// ═══ 3. THE ARGV — the preset is atomic or it is nothing ═════════════════════

describe('buildSdVideoArgs applies the speed preset as one unit', () => {
  const speedEnv = (id: string, modelId: string) => ({
    row: videoRow(modelId), speed: pack(id), adapterDirs: { lora: LORA_DIR },
  })

  it('A14B: both tags, the |high_noise| prefix, 4 steps, cfg 1, simple, shift 1', () => {
    const args = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a lovely cat' }, OUT,
      speedEnv('wan22-i2v-a14b-speed', A14B))

    const p = promptOf(args)
    expect(p).toContain('<lora:lightx2v-wan-i2v-14b-4step:1>')
    expect(p).toContain(`<lora:${LORA_HIGH_NOISE_PREFIX}lightx2v-wan22-a14b-4step-high:1>`)
    // …and the low-noise tag comes FIRST, as upstream writes it.
    expect(p.indexOf('<lora:lightx2v-wan-i2v-14b-4step:1>'))
      .toBeLessThan(p.indexOf(LORA_HIGH_NOISE_PREFIX))

    expect(valueOf(args, '--lora-model-dir')).toBe(LORA_DIR)
    expect(valueOf(args, '--steps')).toBe('4')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--high-noise-steps')).toBe('2')
    expect(valueOf(args, '--high-noise-cfg-scale')).toBe('1')
    expect(valueOf(args, '--high-noise-sampling-method')).toBe('euler')
    expect(valueOf(args, '--scheduler')).toBe('simple')
    expect(valueOf(args, '--flow-shift')).toBe('1')
  })

  it('T2V A14B: its OWN tags (not the i2v pack\'s), 4/2 split, cfg 1, simple, shift 1', () => {
    const C_T2V = {
      diffusion: 'C:/w/t2v-low.gguf', diffusion_high: 'C:/w/t2v-high.gguf',
      vae: 'C:/w/v.safetensors', t5xxl: 'C:/w/t5.gguf',
    }
    const args = buildSdVideoArgs(C_T2V, { modelId: T2V_A14B, prompt: 'a lovely cat' }, OUT,
      speedEnv('wan22-t2v-a14b-speed', T2V_A14B))

    const p = promptOf(args)
    expect(p).toContain('<lora:lightx2v-wan22-t2v-a14b-4step-low:1>')
    expect(p).toContain(`<lora:${LORA_HIGH_NOISE_PREFIX}lightx2v-wan22-t2v-a14b-4step-high:1>`)
    // NOT the i2v pack's slugs — a different pair of bytes, a different tag.
    expect(p).not.toContain('lightx2v-wan-i2v-14b-4step')
    expect(p).not.toContain('lightx2v-wan22-a14b-4step-high')
    expect(p.indexOf('lightx2v-wan22-t2v-a14b-4step-low'))
      .toBeLessThan(p.indexOf('lightx2v-wan22-t2v-a14b-4step-high'))

    expect(valueOf(args, '--lora-model-dir')).toBe(LORA_DIR)
    expect(valueOf(args, '--steps')).toBe('4')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--high-noise-steps')).toBe('2')
    expect(valueOf(args, '--high-noise-cfg-scale')).toBe('1')
    expect(valueOf(args, '--scheduler')).toBe('simple')
    expect(valueOf(args, '--flow-shift')).toBe('1')
  })

  it('2.1 i2v: ONE plain tag and no high-noise flags at all', () => {
    const args = buildSdVideoArgs(C_2_1, { modelId: I2V21, prompt: 'a cat' }, OUT,
      speedEnv('wan21-i2v-14b-480p-speed', I2V21))

    expect(promptOf(args)).toContain('<lora:lightx2v-wan-i2v-14b-4step:1>')
    expect(promptOf(args)).not.toContain(LORA_HIGH_NOISE_PREFIX)
    expect(valueOf(args, '--steps')).toBe('4')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--scheduler')).toBe('simple')
    expect(valueOf(args, '--flow-shift')).toBe('1')
    // A single-DiT row has no second pass to configure — passing these would
    // describe a model that is not loaded.
    expect(args).not.toContain('--high-noise-steps')
    expect(args).not.toContain('--high-noise-diffusion-model')
  })

  // THE POINT OF THE WHOLE DESIGN. A preset that half-applies is worse than one
  // that does not apply: 4 steps with no LoRA is a fast render of noise.
  it('ATOMIC: with no lora directory, NOTHING of the preset is applied', () => {
    const withDir = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a cat' }, OUT,
      speedEnv('wan22-i2v-a14b-speed', A14B))
    const noDir = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a cat' }, OUT,
      { row: videoRow(A14B), speed: pack('wan22-i2v-a14b-speed') })
    const vanilla = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a cat' }, OUT,
      { row: videoRow(A14B) })

    expect(noDir).toEqual(vanilla)                    // byte-identical to no speed pack
    expect(noDir).not.toEqual(withDir)
    expect(valueOf(noDir, '--steps')).toBe('10')      // the row's own recipe
    expect(valueOf(noDir, '--cfg-scale')).toBe('3.5')
    expect(valueOf(noDir, '--scheduler')).toBeUndefined()
    expect(promptOf(noDir)).toBe('a cat')
  })

  it('an ordinary run is untouched — no pack, no preset, no new flags', () => {
    const before = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a cat' }, OUT, { row: videoRow(A14B) })
    expect(valueOf(before, '--steps')).toBe('10')
    expect(valueOf(before, '--high-noise-steps')).toBe('8')
    expect(before).not.toContain('--scheduler')
    // …and an empty lora dir with no pack still emits no --lora-model-dir.
    const withDirNoPack = buildSdVideoArgs(C_A14B, { modelId: A14B, prompt: 'a cat' }, OUT,
      { row: videoRow(A14B), adapterDirs: { lora: LORA_DIR } })
    expect(withDirNoPack).not.toContain('--lora-model-dir')
    expect(promptOf(withDirNoPack)).toBe('a cat')
  })

  // The visible Steps / Guidance controls describe the VANILLA recipe. Letting
  // a stale 10 through would run a 4-step distill at 10 steps, which is the
  // misuse the preset exists to prevent — and the toggle's own description says
  // this happens.
  it('the preset OUT-VOTES the composer\'s steps / cfg / sampler', () => {
    const args = buildSdVideoArgs(C_A14B,
      { modelId: A14B, prompt: 'a cat', steps: 30, cfgScale: 7, samplingMethod: 'heun' }, OUT,
      speedEnv('wan22-i2v-a14b-speed', A14B))
    expect(valueOf(args, '--steps')).toBe('4')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
  })

  it('a user\'s own LoRA still rides along, after the pack\'s tags', () => {
    const args = buildSdVideoArgs(C_2_1,
      { modelId: I2V21, prompt: 'a cat', loras: [{ slug: 'my-style-1a2b3c4d', weight: 0.8 }] }, OUT,
      speedEnv('wan21-i2v-14b-480p-speed', I2V21))
    const p = promptOf(args)
    expect(p).toContain('<lora:my-style-1a2b3c4d:0.8>')
    expect(p.indexOf('lightx2v')).toBeLessThan(p.indexOf('my-style'))
  })

  // The other row-owned facts must survive a speed run untouched: this is a
  // speed lever, not a different model.
  it('leaves fps / size / frames / negative / offload exactly as they were', () => {
    const input: SdVideoInput = { modelId: I2V21, prompt: 'a cat', negative: 'blurry' }
    const fast = buildSdVideoArgs(C_2_1, input, OUT, speedEnv('wan21-i2v-14b-480p-speed', I2V21))
    const slow = buildSdVideoArgs(C_2_1, input, OUT, { row: videoRow(I2V21) })
    for (const flag of ['--fps', '-W', '-H', '--video-frames', '-n']) {
      expect(valueOf(fast, flag)).toBe(valueOf(slow, flag))
    }
    expect(fast).toContain('--offload-to-cpu')
  })
})

// ═══ 4. THE TAG BUILDER ══════════════════════════════════════════════════════

describe('promptWithLoraTags — the high-noise form', () => {
  it('prefixes ONLY the selections that ask for it', () => {
    expect(promptWithLoraTags('cat', [{ slug: 'a-00000000' }, { slug: 'b-00000000', highNoise: true }]))
      .toBe('cat <lora:a-00000000:1> <lora:|high_noise|b-00000000:1>')
  })
  it('is byte-identical for every existing (plain) caller', () => {
    expect(promptWithLoraTags('cat', [{ slug: 'a-00000000', weight: 0.5 }]))
      .toBe('cat <lora:a-00000000:0.5>')
    expect(promptWithLoraTags('cat', undefined)).toBe('cat')
    expect(promptWithLoraTags('cat', [])).toBe('cat')
  })
})

// ═══ 5. INSTALL STATE — a pack is ALL its files or it is not installed ═══════

describe('speed-pack install state on disk', () => {
  const paths = (id: string): string[] =>
    pack(id).files.map(f => {
      const p = speedAdapterFilePath(f)
      if (!p) throw new Error('no path')
      return p
    })

  const clean = (): void => {
    for (const a of SD_SPEED_ADAPTERS) for (const p of paths(a.id)) rmSync(p, { force: true })
  }
  const land = (p: string): void => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'pretend these are distill weights')
  }

  beforeEach(clean)
  afterAll(() => { try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* */ } })

  it('lands each file in the shared loras directory as <slug>.safetensors', () => {
    for (const p of paths('wan22-i2v-a14b-speed')) {
      expect(dirname(p)).toBe(sdAdapterDir('lora'))
      expect(p.endsWith('.safetensors')).toBe(true)
    }
  })

  // PARTIAL IS NOT INSTALLED. A two-expert row with one LoRA applied renders at
  // 4 steps with half the model un-adapted — which looks exactly like "the
  // distill is broken", and is the misdiagnosis this whole lane is about.
  it('is NOT installed while any one file is missing', () => {
    const ps = paths('wan22-i2v-a14b-speed')
    land(ps[0])
    expect(isSpeedAdapterInstalled('wan22-i2v-a14b-speed')).toBe(false)
    expect(installedSpeedAdapter(A14B)).toBeUndefined()
    land(ps[1])
    expect(isSpeedAdapterInstalled('wan22-i2v-a14b-speed')).toBe(true)
    expect(installedSpeedAdapter(A14B)?.id).toBe('wan22-i2v-a14b-speed')
  })

  it('the shared file makes the 2.1 pack install itself alongside the A14B one', () => {
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    // No second download: the 2.1 pack's ONLY file is the A14B pack's low-noise
    // one, same slug, already on disk.
    expect(isSpeedAdapterInstalled('wan21-i2v-14b-480p-speed')).toBe(true)
    // The T2V A14B pack shares NO bytes with this one (different sha256s — see
    // the file-identity test above), so it stays NOT installed here — the
    // negative half of the same claim.
    expect(isSpeedAdapterInstalled('wan22-t2v-a14b-speed')).toBe(false)
    const byId = new Map(listSpeedAdapters().map(a => [a.id, a.installed]))
    expect(byId.get('wan22-i2v-a14b-speed')).toBe(true)
    expect(byId.get('wan21-i2v-14b-480p-speed')).toBe(true)
    expect(byId.get('wan22-t2v-a14b-speed')).toBe(false)
  })

  it('a row with no pack never reports one', () => {
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    expect(installedSpeedAdapter('wan21-t2v-1.3b')).toBeUndefined()
    expect(installedSpeedAdapter('wan22-ti2v-5b')).toBeUndefined()
  })

  // WITHOUT THIS LINE THE WHOLE FEATURE IS SILENTLY DEAD on a machine whose only
  // LoRAs are speed packs: no --lora-model-dir means both-halves-or-neither
  // drops the preset, and the render goes back to the slow path with no error.
  it('reports the lora directory when the ONLY loras are speed packs', () => {
    expect(installedAdapterDirs().lora).toBeUndefined()
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    expect(installedAdapterDirs().lora).toBe(sdAdapterDir('lora'))
  })

  it('the composer surface appears only once the weights are really there', () => {
    const speedSpec = (): unknown => modelParamSchema('video', A14B).find(s => s.name === 'speed_mode')
    expect(speedSpec()).toBeUndefined()
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    const spec = modelParamSchema('video', A14B).find(s => s.name === 'speed_mode')
    expect(spec).toBeDefined()
    expect(spec?.kind).toBe('boolean')
    // DEFAULT ON: someone who downloaded a speed pack asked for the fast path.
    expect(spec?.default).toBe(true)
    // …and it says what it costs, in the three places a user can otherwise only
    // discover by comparing renders.
    expect(spec?.description ?? '').toMatch(/4 steps at guidance 1/)
    expect(spec?.description ?? '').toMatch(/negative prompt has no effect/)
    expect(spec?.description ?? '').toMatch(/motion range and fine detail/)
  })

  // At guidance 1 sd.cpp encodes no unconditional pass, so the negative prompt
  // is inert — on a row whose OWN recipe is cfg 3.5 that fact now depends on a
  // toggle, and the field the user types into has to say so.
  it('the negative-prompt field admits it goes inert while speed is on', () => {
    const negDesc = (): string =>
      String(modelParamSchema('video', A14B).find(s => s.name === 'negative_prompt')?.description ?? '')
    expect(negDesc()).not.toMatch(/Speed \(distilled\)/)
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    expect(negDesc()).toMatch(/While Speed \(distilled\) is on, guidance is 1 and this prompt does nothing/)
  })

  it('a row we ship no pack for never grows the toggle', () => {
    for (const p of paths('wan22-i2v-a14b-speed')) land(p)
    expect(modelParamSchema('video', 'wan21-t2v-1.3b').find(s => s.name === 'speed_mode')).toBeUndefined()
  })
})

// ═══ 6. THE COMPOSER → IPC HOP ══════════════════════════════════════════════

describe('resolveLocalSpeedMode — absent is not the same as false', () => {
  it('sends nothing when the bag never held the control', () => {
    // Main reads an absent flag as "use the pack if it is installed", so a saved
    // canvas flow from before this control existed still gets the fast path.
    expect(resolveLocalSpeedMode({})).toEqual({})
    expect(resolveLocalSpeedMode({ speed_mode: 'yes' })).toEqual({})
  })
  it('forwards an explicit choice, in both directions', () => {
    expect(resolveLocalSpeedMode({ speed_mode: true })).toEqual({ speed: true })
    expect(resolveLocalSpeedMode({ speed_mode: false })).toEqual({ speed: false })
  })
})
