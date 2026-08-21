// apps/desktop/test/unit/sdIpAdapter.test.ts
//
// A PICTURE AS PART OF THE PROMPT — the flags that arrived with the engine bump
// and sat unwired.
//
// `--ip-adapter`, `--ip-adapter-image` and `--ip-adapter-strength` came with
// `master-810-db99efd`; the bump's own note said they were the new capability and
// nothing emitted them. What they do is what people mean by "in THIS style": the
// reference is encoded by a CLIP-Vision tower and injected as extra tokens, so it
// steers subject and appearance WITHOUT ever rendering the reference's pixels.
//
// THE INVARIANT UNDER TEST IS ALL-THREE-OR-NONE, and it is the engine's, not
// ours: `--ip-adapter`'s own help reads "requires --clip_vision", and the weights
// with no picture to encode steer nothing. Every partial combination is a spawn
// the engine rejects or a control that does nothing, so each one is pinned here.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-ipadapter-'))
})

afterAll(() => {
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  SD_IP_ADAPTERS, findIpAdapter, ipAdapterForFamily, ipAdapterCatalogFiles, ipAdapterBlockedFor,
  SD_VIDEO_MODELS, isShaPlaceholder,
} from '../../electron/services/sd-cpp-models'
import { buildSdArgs, effectiveImageParams, type SdArgEnv } from '../../electron/services/sd-cpp-client'
import {
  resolveLocalIpAdapter, schemaOffersIpAdapter, normalizeIpAdapterStrength,
  stampLocalEngineParams,
  SD_IP_ADAPTER_STRENGTH_DEFAULT, SD_IP_ADAPTER_STRENGTH_MIN, SD_IP_ADAPTER_STRENGTH_MAX,
  SD_CLI_IP_ADAPTER_STRENGTH_DEFAULT,
} from '../../src/pages/media/localGenParams'

// ── The registry ─────────────────────────────────────────────────────────────

describe('the curated rows', () => {
  it('covers exactly the families upstream supports, one row each', () => {
    // docs/ip_adapter.md at our pin: "image-prompt conditioning for SD 1.5 and
    // SDXL". A row for any other family would be a download that cannot run.
    expect(SD_IP_ADAPTERS.map(a => a.family).sort()).toEqual(['sd15', 'sdxl'])
    expect(new Set(SD_IP_ADAPTERS.map(a => a.id)).size).toBe(SD_IP_ADAPTERS.length)
  })

  it('every row declares BOTH files the engine requires', () => {
    for (const a of SD_IP_ADAPTERS) {
      const roles = a.files.map(f => f.role).sort()
      expect(roles, a.id).toEqual(['clip_vision', 'model'])
    }
  })

  it('no placeholder shas — these are real download targets', () => {
    for (const a of SD_IP_ADAPTERS) {
      for (const f of a.files) expect(isShaPlaceholder(f.sha256), `${a.id}/${f.slug}`).toBe(false)
    }
  })

  it('slugs are typeable and unique per row', () => {
    for (const a of SD_IP_ADAPTERS) {
      for (const f of a.files) expect(f.slug).toMatch(/^[a-z0-9-]+$/)
      expect(new Set(a.files.map(f => f.slug)).size).toBe(a.files.length)
    }
  })

  it('THE ENCODER IS THE WAN i2v COMPONENT, byte for byte — the whole reuse argument', () => {
    // Not "an equivalent mirror": findReusableComponent matches on sha256, so a
    // different-but-equivalent URL would silently cost a 1.2 GB download to land
    // bytes the disk already holds.
    const wan  = SD_VIDEO_MODELS.find(m => m.id === 'wan21-i2v-14b-480p')
    const wanCv = wan?.files.find(f => f.role === 'clip_vision')
    expect(wanCv).toBeDefined()
    for (const a of SD_IP_ADAPTERS) {
      const cv = a.files.find(f => f.role === 'clip_vision')!
      expect(cv.sha256, a.id).toBe(wanCv!.sha256)
      expect(cv.url,    a.id).toBe(wanCv!.url)
      expect(cv.sizeMb, a.id).toBe(wanCv!.sizeMb)
    }
  })

  it('the two rows share the encoder with each other, so the second is cheap', () => {
    const [a, b] = SD_IP_ADAPTERS
    const cvA = a.files.find(f => f.role === 'clip_vision')!
    const cvB = b.files.find(f => f.role === 'clip_vision')!
    expect(cvA.sha256).toBe(cvB.sha256)
    expect(cvA.slug).toBe(cvB.slug)   // one file on disk, one name
  })

  it('sharedWith names the encoder\'s twins — including the MODEL row', () => {
    for (const a of SD_IP_ADAPTERS) {
      const files = ipAdapterCatalogFiles(a)
      const cv = files.find(f => f.slug === 'clip-vision-h')!
      expect(cv.sharedWith).toContain('wan21-i2v-14b-480p')
      // …and the sibling adapter row.
      expect(cv.sharedWith.some(id => id !== a.id && SD_IP_ADAPTERS.some(o => o.id === id))).toBe(true)
      // The adapter weights themselves are shared with nothing.
      const model = files.find(f => f.slug !== 'clip-vision-h')!
      expect(model.sharedWith).toEqual([])
    }
  })

  it('SD-TURBO IS REFUSED BY ID — it is declared sd15 and is really SD 2.x', () => {
    // MEASURED 2026-08-05: `--ip-adapter ip-adapter_sd15.safetensors` against
    // this checkpoint dies in a flood of `CLIP vision tensor
    // 'cond_stage_model.transformer.vision_model…'` errors with no image written,
    // because stabilityai/sd-turbo is a distilled SD 2.1. The registry's
    // `family: 'sd15'` on that row is a PRE-EXISTING defect (it also mis-offers
    // SD 1.5 LoRAs); what this pins is that the new feature does not inherit it.
    expect(ipAdapterForFamily('sd15')).toBeDefined()                 // the family has a row…
    expect(ipAdapterForFamily('sd15', 'sd-turbo')).toBeUndefined()   // …and this checkpoint may not have it
    expect(ipAdapterBlockedFor('sd-turbo')).toMatch(/2\.1|2\.x/)
    // A row that is genuinely SD 1.5 is untouched.
    expect(ipAdapterForFamily('sd15', 'sd15')).toBeDefined()
    expect(ipAdapterBlockedFor('sd15')).toBeUndefined()
  })

  it('lookups answer by id and by family, and refuse anything else', () => {
    expect(findIpAdapter('ip-adapter-sd15')?.family).toBe('sd15')
    expect(findIpAdapter('nope')).toBeUndefined()
    expect(ipAdapterForFamily('sdxl')?.id).toBe('ip-adapter-sdxl-vit-h')
    // A family with no row answers undefined rather than the first row — the gate
    // that keeps the control off Z-Image and Wan.
    expect(ipAdapterForFamily('zimage')).toBeUndefined()
    expect(ipAdapterForFamily('wan')).toBeUndefined()
    expect(ipAdapterForFamily('')).toBeUndefined()
  })
})

// ── The strength ─────────────────────────────────────────────────────────────

describe('the strength control', () => {
  it('defaults inside upstream\'s recommended range, NOT at the engine default', () => {
    // docs/ip_adapter.md: "0.6 to 0.8 is a good starting range"; the engine's own
    // default is 1.0 — full injection, which on a busy prompt reads as "it
    // ignored what I wrote".
    expect(SD_IP_ADAPTER_STRENGTH_DEFAULT).toBeGreaterThanOrEqual(0.6)
    expect(SD_IP_ADAPTER_STRENGTH_DEFAULT).toBeLessThanOrEqual(0.8)
    expect(SD_CLI_IP_ADAPTER_STRENGTH_DEFAULT).toBe(1.0)
    expect(SD_IP_ADAPTER_STRENGTH_DEFAULT).not.toBe(SD_CLI_IP_ADAPTER_STRENGTH_DEFAULT)
  })

  it('clamps to the band and rounds to what the flag may carry', () => {
    expect(normalizeIpAdapterStrength(99)).toBe(SD_IP_ADAPTER_STRENGTH_MAX)
    expect(normalizeIpAdapterStrength(-5)).toBe(SD_IP_ADAPTER_STRENGTH_MIN)
    // A slider can produce this; the flag is parsed by the engine.
    expect(normalizeIpAdapterStrength(0.7500000000000001)).toBe(0.75)
    expect(normalizeIpAdapterStrength('0.4')).toBe(0.4)
    expect(normalizeIpAdapterStrength('x')).toBe(SD_IP_ADAPTER_STRENGTH_DEFAULT)
    expect(normalizeIpAdapterStrength(undefined)).toBe(SD_IP_ADAPTER_STRENGTH_DEFAULT)
  })
})

// ── The composer resolver ────────────────────────────────────────────────────

describe('resolveLocalIpAdapter', () => {
  it('sends nothing when there is no reference', () => {
    expect(resolveLocalIpAdapter({})).toEqual({})
    expect(resolveLocalIpAdapter({ ip_adapter_image: '' })).toEqual({})
    expect(resolveLocalIpAdapter({ ip_adapter_image: '   ' })).toEqual({})
    // A STRENGTH ALONE STEERS NOTHING — it must not put a flag on the argv.
    expect(resolveLocalIpAdapter({ ip_adapter_strength: 0.9 })).toEqual({})
  })

  it('sends the reference under the IPC name, with a resolved strength', () => {
    expect(resolveLocalIpAdapter({ ip_adapter_image: 'data:image/png;base64,AAA', ip_adapter_strength: 0.5 }))
      .toEqual({ ipAdapterImage: 'data:image/png;base64,AAA', ipAdapterStrength: 0.5 })
  })

  it('fills the ONE default when the bag has a reference and no number', () => {
    expect(resolveLocalIpAdapter({ ip_adapter_image: 'C:/ref.png' }))
      .toEqual({ ipAdapterImage: 'C:/ref.png', ipAdapterStrength: SD_IP_ADAPTER_STRENGTH_DEFAULT })
  })

  it('THE OUT-VOTE: a path left in the bag cannot ride onto a row with no control', () => {
    const bag = { ip_adapter_image: 'C:/ref.png' }
    expect(resolveLocalIpAdapter(bag, true)).not.toEqual({})
    expect(resolveLocalIpAdapter(bag, false)).toEqual({})
  })

  it('schemaOffersIpAdapter reads the schema\'s own param name', () => {
    expect(schemaOffersIpAdapter([{ name: 'ip_adapter_image', label: 'x', kind: 'image' }])).toBe(true)
    expect(schemaOffersIpAdapter([{ name: 'image_url', label: 'x', kind: 'image' }])).toBe(false)
    expect(schemaOffersIpAdapter([])).toBe(false)
  })
})

// ── The argv: all three flags or none ────────────────────────────────────────

const SINGLE = { model: 'C:/m.safetensors' }
const IP: SdArgEnv['ipAdapter'] = {
  id: 'ip-adapter-sd15',
  adapter: 'C:/ip/ip-adapter-sd15.safetensors',
  clipVision: 'C:/ip/clip-vision-h.safetensors',
}
const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

describe('buildSdArgs and the reference image', () => {
  it('emits all three flags together, and --clip_vision with them', () => {
    const args = buildSdArgs(
      SINGLE,
      { modelId: 'sd15', prompt: 'a girl', ipAdapterImagePath: 'C:/ref.png', ipAdapterStrength: 0.5 },
      'C:/out.png',
      { ipAdapter: IP },
    )
    expect(valueOf(args, '--ip-adapter')).toBe(IP!.adapter)
    expect(valueOf(args, '--clip_vision')).toBe(IP!.clipVision)
    expect(valueOf(args, '--ip-adapter-image')).toBe('C:/ref.png')
    expect(valueOf(args, '--ip-adapter-strength')).toBe('0.5')
  })

  it('emits the app\'s default strength rather than leaving it to the engine', () => {
    const args = buildSdArgs(
      SINGLE, { modelId: 'sd15', prompt: 'p', ipAdapterImagePath: 'C:/ref.png' }, 'C:/out.png',
      { ipAdapter: IP },
    )
    expect(valueOf(args, '--ip-adapter-strength')).toBe(String(SD_IP_ADAPTER_STRENGTH_DEFAULT))
  })

  it('NO WEIGHTS ⇒ no flags at all, even with a picture attached', () => {
    // The engine would reject `--ip-adapter-image` with no adapter; more to the
    // point, there is nothing to inject with.
    const args = buildSdArgs(
      SINGLE, { modelId: 'sd15', prompt: 'p', ipAdapterImagePath: 'C:/ref.png' }, 'C:/out.png', {},
    )
    expect(args).not.toContain('--ip-adapter')
    expect(args).not.toContain('--ip-adapter-image')
    expect(args).not.toContain('--ip-adapter-strength')
    expect(args).not.toContain('--clip_vision')
  })

  it('NO PICTURE ⇒ no flags either, even with the weights installed', () => {
    const args = buildSdArgs(SINGLE, { modelId: 'sd15', prompt: 'p' }, 'C:/out.png', { ipAdapter: IP })
    expect(args).not.toContain('--ip-adapter')
    expect(args).not.toContain('--clip_vision')
    expect(args).not.toContain('--ip-adapter-strength')
  })

  it('a reference and an init frame are INDEPENDENT — both may ride', () => {
    const args = buildSdArgs(
      SINGLE,
      { modelId: 'sd15', prompt: 'p', initImagePath: 'C:/init.png', strength: 0.4, ipAdapterImagePath: 'C:/ref.png' },
      'C:/out.png',
      { ipAdapter: IP },
    )
    expect(valueOf(args, '-i')).toBe('C:/init.png')
    expect(valueOf(args, '--strength')).toBe('0.4')
    expect(valueOf(args, '--ip-adapter-image')).toBe('C:/ref.png')
    // …and the two strengths are different numbers under different flags.
    expect(valueOf(args, '--ip-adapter-strength')).not.toBe(valueOf(args, '--strength'))
  })

  it('a run with no reference is BYTE-IDENTICAL to one before the feature existed', () => {
    const before = buildSdArgs(SINGLE, { modelId: 'sd15', prompt: 'p' }, 'C:/out.png', {})
    const after  = buildSdArgs(SINGLE, { modelId: 'sd15', prompt: 'p' }, 'C:/out.png', { ipAdapter: IP })
    expect(after).toEqual(before)
  })
})

// ── Provenance ───────────────────────────────────────────────────────────────

describe('what the run RECORDS', () => {
  it('records the mode and the strength, never the temp path', () => {
    const eff = effectiveImageParams(
      { modelId: 'sd15', prompt: 'p', ipAdapterImagePath: 'C:/tmp/sd-init-1-ab.png', ipAdapterStrength: 0.6 },
      { ipAdapter: IP },
    )
    // A BOOLEAN: the path is a temp this process deletes when the run ends.
    expect(eff.ipAdapterImage).toBe(true)
    expect(eff.ipAdapterStrength).toBe(0.6)
  })

  it('records NOTHING when the weights were absent — the argv carried no flags', () => {
    const eff = effectiveImageParams(
      { modelId: 'sd15', prompt: 'p', ipAdapterImagePath: 'C:/ref.png', ipAdapterStrength: 0.6 },
      {},
    )
    expect(eff.ipAdapterImage).toBeUndefined()
    expect(eff.ipAdapterStrength).toBeUndefined()
  })

  it('records nothing on a text-only run', () => {
    const eff = effectiveImageParams({ modelId: 'sd15', prompt: 'p' }, { ipAdapter: IP })
    expect(eff.ipAdapterImage).toBeUndefined()
    expect(eff.ipAdapterStrength).toBeUndefined()
  })

  it('the gallery stamp uses a key no gateway can misread as an image', () => {
    const out = stampLocalEngineParams(
      {},
      { steps: 20, cfgScale: 7, samplingMethod: 'euler', ipAdapterImage: true, ipAdapterStrength: 0.75 },
    )
    // `reference_image: true` — writing a boolean under `ip_adapter_image` would
    // hand the next provider `true` where it expects a picture.
    expect(out.reference_image).toBe(true)
    expect(out.ip_adapter_image).toBeUndefined()
    // …and the strength restores into the visible slider under its own spec name.
    expect(out.ip_adapter_strength).toBe(0.75)
  })

  it('stamps nothing for a run that had no reference', () => {
    const out = stampLocalEngineParams({}, { steps: 20, cfgScale: 7, samplingMethod: 'euler' })
    expect(out.reference_image).toBeUndefined()
    expect(out.ip_adapter_strength).toBeUndefined()
  })
})
