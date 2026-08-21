// apps/desktop/test/unit/sdModelSizes.test.ts
//
// THE MANIFEST USED TO LIE ABOUT DOWNLOAD SIZES.
//
// sd-cpp-models.ts declared sd-turbo at sizeMb 2500 while the file is
// 5_214_561_328 bytes (~5.0 GiB) — a 2× under-declaration. Those numbers are
// not cosmetic: sd-cpp-installer feeds `Math.round(sizeMb * 1_048_576)` to the
// download manager as `approxTotalBytes`, which is what the DISK PREFLIGHT
// reserves against. Under-declaring means starting a multi-GB download onto a
// volume that cannot hold it — the exact failure the preflight exists to stop.
//
// MEASURED 2026-07-27 by HEAD + redirect on every URL in the registry: the
// numbers below are the `Content-Length` of the 200 response (the 302's
// `X-Linked-Size` agreed on all nine, and every `X-Linked-ETag` equalled the
// sha256 pinned in the registry — so these URLs still serve the pinned bytes).
//
// Re-measure whenever a URL is repointed; a moved file changes both the size
// AND the sha, so this test failing next to a sha change is expected.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SD_IMAGE_MODELS, SD_VIDEO_MODELS, SD_PRESETS, SD_SAMPLING_METHODS, isShaPlaceholder,
  presetsForRow, isDistilledRow, sdCatalogFiles, sdFilesWithSha, type SdModelFile,
} from '../../electron/services/sd-cpp-models'

const MiB = 1_048_576

/** modelId → role → measured Content-Length in bytes. */
const MEASURED: Record<string, Record<string, number>> = {
  'sd-turbo':        { model:     5_214_561_328 },
  'sd15':            { model:     4_265_146_304 },
  // Added 2026-07-28 with the SDXL row — same method, same day's probe:
  // HEAD https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/
  //      resolve/main/sd_xl_base_1.0.safetensors
  //   302 X-Linked-Size: 6938078334   (200 content-length agrees exactly)
  //   302 X-Linked-ETag: "31e35c80…"  (= the sha256 pinned in the registry)
  'sdxl-base-1.0':   { model:     6_938_078_334 },
  'flux-schnell-q4': {
    diffusion: 6_783_943_712,
    vae:         335_304_388,
    clip_l:      246_144_152,
    t5xxl:     2_896_123_072,
  },
  'wan21-t2v-1.3b': {
    diffusion: 1_535_768_800,
    vae:         253_815_318,
    t5xxl:     6_043_068_256,
  },
  // Added 2026-07-28 NIGHT-2 with the `llm` role and the two rows it unlocked.
  // Same method (HEAD + 302), and on these the `X-Linked-ETag` was the ONLY
  // source used for the sha pinned in the registry — so a size mismatch here and
  // a sha mismatch are the same failure and would show up together.
  //
  //   z-image-turbo / diffusion   X-Linked-Size 3864250304  ETag 14b375ab…
  //   z-image-turbo / llm         X-Linked-Size 2497281120  ETag 3605803b…
  //   wan i2v       / diffusion   X-Linked-Size 11341184384 ETag d91f7139…
  //   wan i2v       / clip_vision X-Linked-Size 1264219396  ETag 64a7ef76…
  //
  // The SHARED files are listed at the SAME byte count under both rows on
  // purpose: they are one file with two declarations (see the reuse suite), and
  // a divergence here would mean the registry had quietly forked them.
  'z-image-turbo': {
    diffusion: 3_864_250_304,
    vae:         335_304_388,   // ≡ flux-schnell-q4/vae
    llm:       2_497_281_120,
  },
  'wan21-i2v-14b-480p': {
    diffusion:  11_341_184_384,
    vae:           253_815_318, // ≡ wan21-t2v-1.3b/vae
    t5xxl:       6_043_068_256, // ≡ wan21-t2v-1.3b/t5xxl
    clip_vision: 1_264_219_396,
  },
  // Added 2026-07-31 with the two Wan 2.2 rows. Method unchanged (HF tree API
  // `lfs.size` + `lfs.oid`, cross-checked against a HEAD whose `X-Linked-Size`
  // and `X-Linked-ETag` agreed on all four new files).
  //
  //   ti2v-5b  / diffusion       X-Linked-Size 5400179040 ETag 57bece98…
  //   ti2v-5b  / vae             X-Linked-Size 1409400960 ETag e40321bd…
  //   a14b     / diffusion       X-Linked-Size 6515012096 ETag 3352289b…  (LowNoise)
  //   a14b     / diffusion_high  X-Linked-Size 6515012096 ETag 2708962c…  (HighNoise)
  //
  // The two A14B experts are the same SIZE and different BYTES, which is the
  // whole reason the sha is the identity and the size is only the preflight: a
  // size-keyed check could not tell the high-noise file from the low-noise one.
  'wan22-ti2v-5b': {
    diffusion: 5_400_179_040,
    // NOT the 2.1 vae. Upstream: "wan_2.1_vae (for all the wan model except
    // Wan2.2 TI2V 5B)" — a different autoencoder, 5.5x larger.
    vae:       1_409_400_960,
    t5xxl:     6_043_068_256, // ≡ wan21-t2v-1.3b/t5xxl
  },
  'wan22-i2v-a14b': {
    diffusion:      6_515_012_096, // LowNoise
    diffusion_high: 6_515_012_096, // HighNoise
    vae:              253_815_318, // ≡ wan21-t2v-1.3b/vae
    t5xxl:          6_043_068_256, // ≡ wan21-t2v-1.3b/t5xxl
  },
  // Added 2026-07-31 with the T2V A14B row (the text-only twin of the i2v pair
  // above). Method unchanged: HF tree API `lfs.size` + `lfs.oid` on
  // QuantStack/Wan2.2-T2V-A14B-GGUF.
  //
  //   diffusion (LowNoise Q3_K_S)   lfs.size 6513373696  oid 1d97051a…
  //   diffusion_high (HighNoise)    lfs.size 6513373696  oid f10a599a…
  //   vae (VAE/Wan2.1_VAE.safetensors in THIS repo)  oid 2fc39d31…  ≡ wan21-t2v-1.3b/vae
  //
  // The repo ships no t5xxl at all (only VAE + the two diffusion halves), so
  // the row declares the SAME already-pinned umt5 file every other Wan row
  // does rather than a fifth copy — sha dedup, not a fresh measurement.
  'wan22-t2v-a14b': {
    diffusion:      6_513_373_696, // LowNoise — a DIFFERENT size from i2v's pair
    diffusion_high: 6_513_373_696, // HighNoise
    vae:              253_815_318, // ≡ wan21-t2v-1.3b/vae
    t5xxl:          6_043_068_256, // ≡ wan21-t2v-1.3b/t5xxl
  },
  // Added 2026-07-31 with the LTX-2.3 unlock. b56c3d7 pinned these five from
  // the HF tree API while the row was BLOCKED; RE-VERIFIED against the same
  // API on the day it shipped, and every `lfs.size` and `lfs.oid` came back
  // byte-for-byte identical — which is the whole point of pinning research
  // rather than re-deriving it.
  //
  //   diffusion             lfs.size 10770199584  oid 388614a1…
  //   vae                   lfs.size  1452256522  oid e68d6d8f…
  //   audio_vae             lfs.size   364853140  oid 3cd6a6eb…
  //   embeddings_connectors lfs.size  2312144712  oid c61cbb39…
  //   llm                   lfs.size  7432229248  oid da98f81c…
  //
  // NOTHING HERE IS SHARED. The dev and distilled VAE / connector files in the
  // same repo are byte-identical in SIZE and differ only in sha — which is the
  // reason this table can never be the identity check, only the preflight.
  'ltx-2-3-22b-distilled': {
    diffusion:             10_770_199_584,
    vae:                    1_452_256_522,
    audio_vae:                364_853_140,
    embeddings_connectors:  2_312_144_712,
    llm:                    7_432_229_248,
  },
}

const ALL = [
  ...SD_IMAGE_MODELS.map(m => ({ id: m.id, files: m.files })),
  ...SD_VIDEO_MODELS.map(m => ({ id: m.id, files: m.files })),
]

/** What the installer actually hands the download manager for preflight. */
const approxBytes = (f: SdModelFile) => Math.round(f.sizeMb * MiB)

describe('sd-cpp-models — declared sizes match the measured Content-Length', () => {
  it('covers every model and every component file (no unmeasured row)', () => {
    for (const m of ALL) {
      expect(MEASURED[m.id], `no measurement for model ${m.id}`).toBeDefined()
      for (const f of m.files) {
        expect(MEASURED[m.id][f.role], `no measurement for ${m.id}/${f.role}`).toBeGreaterThan(0)
      }
    }
  })

  it.each(ALL.flatMap(m => m.files.map(f => [m.id, f] as const)))(
    '%s/%s declares ceil(bytes / 1 MiB)',
    (id, f) => {
      expect(f.sizeMb).toBe(Math.ceil(MEASURED[id][f.role] / MiB))
    },
  )

  it('NEVER under-declares — the disk preflight must not reserve too little', () => {
    for (const m of ALL) {
      for (const f of m.files) {
        expect(
          approxBytes(f),
          `${m.id}/${f.role} under-declares: ${approxBytes(f)} < ${MEASURED[m.id][f.role]}`,
        ).toBeGreaterThanOrEqual(MEASURED[m.id][f.role])
      }
    }
  })

  it('never over-declares by more than 1 MiB either (rounding, not guessing)', () => {
    for (const m of ALL) {
      for (const f of m.files) {
        expect(approxBytes(f) - MEASURED[m.id][f.role]).toBeLessThan(MiB)
      }
    }
  })

  it('sd-turbo is no longer the 2× lie the driver hit', () => {
    const turbo = SD_IMAGE_MODELS.find(m => m.id === 'sd-turbo')!
    expect(turbo.files[0].sizeMb).toBe(4973)          // was 2500 for a 5.2 GB file
    expect(turbo.notes).not.toContain('2.5 GB')       // the card said so too
  })

  it('per-model totals are what the catalog card shows in GB', () => {
    const totalGb = (id: string) => {
      const m = ALL.find(x => x.id === id)!
      return m.files.reduce((a, f) => a + f.sizeMb, 0) / 1024
    }
    expect(totalGb('sd-turbo')).toBeCloseTo(4.86, 1)
    expect(totalGb('sd15')).toBeCloseTo(3.97, 1)
    expect(totalGb('sdxl-base-1.0')).toBeCloseTo(6.46, 1)
    expect(totalGb('flux-schnell-q4')).toBeCloseTo(9.56, 1)
    expect(totalGb('wan21-t2v-1.3b')).toBeCloseTo(7.30, 1)
    expect(totalGb('z-image-turbo')).toBeCloseTo(6.24, 1)
    expect(totalGb('wan21-i2v-14b-480p')).toBeCloseTo(17.61, 1)
    expect(totalGb('wan22-ti2v-5b')).toBeCloseTo(11.97, 1)
    expect(totalGb('wan22-i2v-a14b')).toBeCloseTo(18.00, 1)
    // Text-only twin of the row above — same shape, one MiB lighter per expert.
    expect(totalGb('wan22-t2v-a14b')).toBeCloseTo(18.00, 1)
    // The largest row we offer, and the only one whose price is entirely new
    // however many models you already have.
    expect(totalGb('ltx-2-3-22b-distilled')).toBeCloseTo(20.80, 1)
  })

  it('the INCREMENTAL cost of each new Wan row is what its card claims', () => {
    // The number on the button for someone who already owns a Wan model. It is
    // the row's total MINUS every file whose sha is declared by another row, and
    // it is the whole reason the sha-keyed reuse exists — the i2v row's button
    // once read 17.6 GB while its tooltip said 11.7, and the pessimistic number
    // was the visible one.
    const files = (id: string) => ALL.find(m => m.id === id)!.files
    const shared = (id: string) => new Set(
      sdCatalogFiles({ id, files: files(id) }, [])
        .filter(f => f.sharedWith.length > 0)
        .map(f => f.role),
    )
    const incrementalMb = (id: string) => {
      const s = shared(id)
      return files(id).filter(f => !s.has(f.role)).reduce((a, f) => a + f.sizeMb, 0)
    }
    // TI2V-5B shares ONLY the 5.6 GB text encoder — its VAE is the 2.2 one.
    expect([...shared('wan22-ti2v-5b')].sort()).toEqual(['t5xxl'])
    expect(incrementalMb('wan22-ti2v-5b')).toBe(5151 + 1345)   // 6,496 MiB ≈ 6.3 GB
    // A14B shares the 2.1 vae AND the encoder — everything but the expert pair.
    expect([...shared('wan22-i2v-a14b')].sort()).toEqual(['t5xxl', 'vae'])
    expect(incrementalMb('wan22-i2v-a14b')).toBe(6214 * 2)     // 12,428 MiB ≈ 12.1 GB
    // The T2V twin shares the same two files — only its own expert pair is new.
    expect([...shared('wan22-t2v-a14b')].sort()).toEqual(['t5xxl', 'vae'])
    expect(incrementalMb('wan22-t2v-a14b')).toBe(6212 * 2)     // 12,424 MiB ≈ 12.1 GB
  })

  it('the A14B experts are the same SIZE and different BYTES', () => {
    // Which is exactly why sha256 is the identity and sizeMb is only the disk
    // preflight: a size-keyed reuse would happily place the high-noise file
    // where the low-noise one belongs and the render would simply be wrong.
    for (const id of ['wan22-i2v-a14b', 'wan22-t2v-a14b']) {
      const a14b = ALL.find(m => m.id === id)!
      const low  = a14b.files.find(f => f.role === 'diffusion')!
      const high = a14b.files.find(f => f.role === 'diffusion_high')!
      expect(high.sizeMb, id).toBe(low.sizeMb)
      expect(high.sha256, id).not.toBe(low.sha256)
      expect(low.url, id).toContain('LowNoise')
      expect(high.url, id).toContain('HighNoise')
    }
    // …and the two PAIRS (i2v vs t2v) are not each other either — four distinct
    // diffusion files behind two rows that happen to share a shape.
    const i2v = ALL.find(m => m.id === 'wan22-i2v-a14b')!
    const t2v = ALL.find(m => m.id === 'wan22-t2v-a14b')!
    for (const role of ['diffusion', 'diffusion_high'] as const) {
      expect(t2v.files.find(f => f.role === role)!.sha256)
        .not.toBe(i2v.files.find(f => f.role === role)!.sha256)
    }
  })

  it('the SHARED files are declared identically by both rows that claim them', () => {
    // A shared file is ONE file with two declarations, and the installer's
    // sha-keyed reuse is what turns that into a download it does not make. Let
    // the url or the size drift and the reuse silently stops engaging while
    // every other test in this file still passes.
    const file = (id: string, role: string) =>
      ALL.find(m => m.id === id)!.files.find(f => f.role === role)!
    const same = (a: SdModelFile, b: SdModelFile) =>
      expect({ url: a.url, sha256: a.sha256, sizeMb: a.sizeMb })
        .toEqual({ url: b.url, sha256: b.sha256, sizeMb: b.sizeMb })

    same(file('z-image-turbo', 'vae'),        file('flux-schnell-q4', 'vae'))
    same(file('wan21-i2v-14b-480p', 'vae'),   file('wan21-t2v-1.3b', 'vae'))
    same(file('wan21-i2v-14b-480p', 't5xxl'), file('wan21-t2v-1.3b', 't5xxl'))
    // The umt5 encoder is now declared by FOUR rows — the dedup that makes the
    // 2.2 rows cheap for an existing Wan owner is this identity and nothing else.
    same(file('wan22-ti2v-5b', 't5xxl'),      file('wan21-t2v-1.3b', 't5xxl'))
    same(file('wan22-i2v-a14b', 't5xxl'),     file('wan21-t2v-1.3b', 't5xxl'))
    same(file('wan22-i2v-a14b', 'vae'),       file('wan21-t2v-1.3b', 'vae'))
    same(file('wan22-t2v-a14b', 't5xxl'),     file('wan21-t2v-1.3b', 't5xxl'))
    same(file('wan22-t2v-a14b', 'vae'),       file('wan21-t2v-1.3b', 'vae'))
  })

  it('the 2.2 TI2V VAE is NOT the 2.1 one — the reuse that must NOT happen', () => {
    // The single most plausible mistake on this row, and it would be silent:
    // upstream says in one line that wan_2.1_vae is "for all the wan model
    // except Wan2.2 TI2V 5B". Different sha ⇒ findReusableComponent cannot
    // cross-place them, and sdCatalogFiles reports no sharing.
    const file = (id: string, role: string) =>
      ALL.find(m => m.id === id)!.files.find(f => f.role === role)!
    const v22 = file('wan22-ti2v-5b', 'vae')
    const v21 = file('wan21-t2v-1.3b', 'vae')
    expect(v22.sha256).not.toBe(v21.sha256)
    expect(v22.url).not.toBe(v21.url)
    const shared = sdCatalogFiles({ id: 'wan22-ti2v-5b', files: ALL.find(m => m.id === 'wan22-ti2v-5b')!.files }, [])
    expect(shared.find(f => f.role === 'vae')!.sharedWith).toEqual([])
  })

  it('every declaration of the umt5 encoder resolves to the SAME set of rows', () => {
    // sdFilesWithSha is what findReusableComponent walks, so this is the exact
    // question the installer asks before it opens a socket. Five rows now,
    // with the T2V A14B twin joining the other four on 2026-07-31.
    const t5 = ALL.find(m => m.id === 'wan22-ti2v-5b')!.files.find(f => f.role === 't5xxl')!
    expect(sdFilesWithSha(t5.sha256, []).map(r => r.modelId).sort()).toEqual([
      'wan21-i2v-14b-480p', 'wan21-t2v-1.3b', 'wan22-i2v-a14b', 'wan22-t2v-a14b', 'wan22-ti2v-5b',
    ])
    for (const r of sdFilesWithSha(t5.sha256, [])) expect(r.role).toBe('t5xxl')
  })
})

// ═══ THE SDXL ROW — the 39% → 85% lever ═════════════════════════════════════
//
// The engine has run SDXL since it shipped (the family union lists 'sdxl', the
// preset table has an sdxl column) but no ROW existed, so the single biggest
// slice of Civitai — SDXL / Pony / Illustrious / NoobAI checkpoints — mapped to
// a family we could not actually offer. One row moves the addressable share of
// top checkpoints from ~39% to ~85% (spec §0).
//
// Everything asserted below is a PROPERTY of the row, checked against sources
// that live elsewhere in the repo — so this cannot pass by being copied.

describe('the SDXL base row is per-family TRUE, not just present', () => {
  const sdxl = SD_IMAGE_MODELS.find(m => m.id === 'sdxl-base-1.0')!

  it('exists, single-file, from the official Stability repo', () => {
    expect(sdxl).toBeDefined()
    expect(sdxl.files).toHaveLength(1)
    expect(sdxl.files[0].role).toBe('model')
    expect(sdxl.files[0].url).toBe(
      'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    )
  })

  it('declares family sdxl and the 1024 GRID — 512 is the SD 1.5 answer, and it is wrong here', () => {
    expect(sdxl.family).toBe('sdxl')
    expect(sdxl.baseSize).toBe(1024)
    // sd-cpp-client falls back to `model.baseSize` for -W/-H, so this number IS
    // the render size whenever the composer sends none.
    expect(SD_IMAGE_MODELS.filter(m => m.family === 'sd15').every(m => m.baseSize === 512)).toBe(true)
  })

  it('its sampler is one the PINNED engine build actually accepts', () => {
    // THE LIST IS IMPORTED, NOT COPIED. This held its own hardcoded eleven
    // entries "read off src/stable-diffusion.cpp of master-782-b290693" — the
    // very transcription that was wrong at that tag (the binary printed
    // nineteen) and that a later bump would have left stale a second time. A
    // test with its own copy of the thing under test guards the copy.
    expect(SD_SAMPLING_METHODS).toContain(sdxl.samplingMethod)
    for (const m of SD_IMAGE_MODELS) expect(SD_SAMPLING_METHODS, m.id).toContain(m.samplingMethod)
  })

  it('its defaults ARE the sdxl preset tier — one family, one story', () => {
    const quality = SD_PRESETS.find(p => p.id === 'quality')!.params.sdxl
    expect({ steps: sdxl.steps, cfgScale: sdxl.cfgScale, samplingMethod: sdxl.samplingMethod })
      .toEqual({ steps: quality.steps, cfgScale: quality.cfgScale, samplingMethod: quality.samplingMethod })
  })

  it('carries a REAL sha256, not a placeholder — a 6.5 GB unverified download is not shippable', () => {
    expect(isShaPlaceholder(sdxl.files[0].sha256)).toBe(false)
    expect(sdxl.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    // The whole registry holds to this today; a placeholder is refused outright
    // in a packaged build, so a new one would ship as a dead Download button.
    for (const m of ALL) for (const f of m.files) expect(isShaPlaceholder(f.sha256)).toBe(false)
  })

  it('does NOT ship a vae component — the pinned build handles SDXL fp16 itself', () => {
    // The row needs no VAE: src/stable-diffusion.cpp (master-782-b290693)
    // applies a 1/32 Conv2D scale when the model is SDXL and no --vae was
    // given — upstream's own answer to the fp16 overflow that turns SDXL
    // renders black.
    expect(sdxl.files.map(f => f.role)).toEqual(['model'])
    // …so the single-file branch emits no --vae for it: the only sources are a
    // selected VAE ADAPTER and the row's own `vae` component, and this row has
    // neither. (The branch CAN emit one now — that is the phase-2 swap that
    // closes the fp16 black-image trap — but only when something asks. The argv
    // proof for both directions lives in sdCppAdapters.test.ts, which mocks
    // electron; this file stays a pure registry test.)
    const client = readFileSync(resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8')
    const at = client.indexOf('if (components.model) {')
    const single = client.slice(at, client.indexOf('} else {', at))
    expect(single).toContain("args.push('-m', components.model)")
    expect(single).toContain('const vae = env.vaePath ?? components.vae')
    expect(single).toContain("if (vae) args.push('--vae', vae)")
  })

  it('every image row is offered tiers it can run — from a column or from itself', () => {
    // The preset TABLE describes three families; a row of any other family
    // (z-image today) is offered tiers DERIVED FROM ITS OWN RECIPE instead, and
    // a distilled row is offered none at all. What must never happen is a row
    // falling through to another family's ladder, so assert the branch each row
    // actually takes rather than that the table has a column for it.
    for (const m of SD_IMAGE_MODELS) {
      expect([512, 1024]).toContain(m.baseSize)
      const offers = presetsForRow(m)
      if (isDistilledRow(m)) { expect(offers, m.id).toEqual([]); continue }
      if (m.family === 'sd15' || m.family === 'sdxl' || m.family === 'flux') {
        for (const p of SD_PRESETS) expect(p.params[m.family], `${m.id}/${p.id}`).toBeDefined()
        expect(offers.map(o => o.id), m.id).toEqual(SD_PRESETS.map(p => p.id))
      } else {
        // Derived: the row's own guidance and sampler in every tier, and no
        // invented 1-step "lightning" for weights that cannot run one.
        expect(offers.map(o => o.id), m.id).toEqual(['speed', 'quality'])
        expect(offers.every(o => o.params.cfgScale === m.cfgScale), m.id).toBe(true)
        expect(offers.every(o => o.params.samplingMethod === m.samplingMethod), m.id).toBe(true)
      }
    }
  })
})
