// apps/desktop/test/unit/sdVideoRowTruth.test.ts
//
// THE VIDEO ARG BUILDER BECOMES A PURE FUNCTION, AND THE ROW BECOMES THE
// AUTHORITY ON FPS AND ON THE PIXEL GRID.
//
// Until this suite existed the `vid_gen` argv was asserted by READING THE
// SOURCE of generateVideo (sdCppAdapters.test.ts still does that for the LoRA
// tag). That was tolerable while every video row was Wan 2.1 and every number
// in the builder was a constant. Two rows break both assumptions at once:
//
//  • Wan 2.2 TI2V-5B is a 24 FPS model on a 32-PIXEL grid whose 720p pair is
//    1280x704 — explicitly NOT 1280x720 (VIDEO-MODELS-RESEARCH §1, "PARAM
//    TRAPS"). `--fps` was a module constant of 16 and the width was forwarded
//    verbatim, so this row would have muxed 24 fps content into a 16 fps
//    container (plays 1.5x SLOW) at a size the checkpoint was never trained on.
//
//  • Wan 2.2 I2V-A14B is the first row with TWO diffusion files. Both are
//    REQUIRED (a MoE pair: a high-noise expert and a low-noise one), and the
//    engine takes the second through `--high-noise-diffusion-model` plus its
//    own `--high-noise-steps` / `--high-noise-cfg-scale` /
//    `--high-noise-sampling-method`.
//
// EVERY FLAG NAME BELOW IS SOURCE-ASSERTED against `sd-cli --help` of the
// PINNED build (master-782-b290693) and against upstream's own docs/wan.md at
// that same commit — the file that ships a worked Wan2.2 I2V A14B command with
// an output video. Nothing here is inferred from a blog post.

import { describe, it, expect, vi } from 'vitest'

// hoisted: sd-cpp-client pulls storage-root, which reads app.getPath() at
// IMPORT time (the idiom the sibling sd-cpp suites in this dir use).
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdvideorow-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { buildSdVideoArgs, type SdVideoInput } from '../../electron/services/sd-cpp-client'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  SD_VIDEO_MODELS, findSdRow, WAN_DEFAULT_NEGATIVE,
  DEFAULT_VIDEO_FPS, DEFAULT_VIDEO_PIXEL_GRID, DEFAULT_VIDEO_FRAME_GRID,
  type SdGenerationRow, type SdVideoModel,
} from '../../electron/services/sd-cpp-models'

const OUT = 'C:/out/clip.webm'

const videoRow = (id: string): SdGenerationRow => {
  const row = findSdRow(id, [])
  if (!row || row.kind !== 'video') throw new Error(`no video row ${id}`)
  return row
}
const model = (id: string): SdVideoModel => {
  const m = SD_VIDEO_MODELS.find(x => x.id === id)
  if (!m) throw new Error(`no video model ${id}`)
  return m
}

/** The value sd-cli is handed for `flag`, or undefined when it is not passed. */
const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

const base = (over: Partial<SdVideoInput> = {}): SdVideoInput =>
  ({ modelId: 'wan21-t2v-1.3b', prompt: 'a lovely cat', ...over })

// ═══ 1. THE PURE BUILDER ═════════════════════════════════════════════════════

describe('buildSdVideoArgs is a pure function of (components, input, row)', () => {
  const C = { diffusion: 'C:/w/d.gguf', vae: 'C:/w/v.safetensors', t5xxl: 'C:/w/t5.gguf' }

  it('still opens with the vid_gen mode and closes with the output path', () => {
    const args = buildSdVideoArgs(C, base(), OUT, { row: videoRow('wan21-t2v-1.3b') })
    expect(args.slice(0, 2)).toEqual(['-M', 'vid_gen'])
    expect(args.slice(-2)).toEqual(['-o', OUT])
    // Wan is VRAM-heavy; upstream passes this in every one of its own examples.
    expect(args).toContain('--offload-to-cpu')
  })

  it('emits the components it was given and nothing it was not', () => {
    const args = buildSdVideoArgs(C, base(), OUT, { row: videoRow('wan21-t2v-1.3b') })
    expect(valueOf(args, '--diffusion-model')).toBe(C.diffusion)
    expect(valueOf(args, '--vae')).toBe(C.vae)
    expect(valueOf(args, '--t5xxl')).toBe(C.t5xxl)
    expect(args).not.toContain('--clip_vision')
    expect(args).not.toContain('--high-noise-diffusion-model')
    expect(args).not.toContain('--audio-vae')
    expect(args).not.toContain('--embeddings-connectors')
  })

  it('the 1.3B row is byte-identical to what it produced before this lane', () => {
    // The regression pin. Every new behaviour is row-DERIVED, so a row that
    // declares no fps / no grid / no high-noise expert must be untouched.
    const args = buildSdVideoArgs(C, base(), OUT, { row: videoRow('wan21-t2v-1.3b') })
    expect(valueOf(args, '--fps')).toBe(String(DEFAULT_VIDEO_FPS))
    expect(valueOf(args, '-W')).toBe('832')
    expect(valueOf(args, '-H')).toBe('480')
    expect(valueOf(args, '--video-frames')).toBe('33')
    expect(valueOf(args, '--cfg-scale')).toBe('6')
    expect(valueOf(args, '--steps')).toBe('20')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
  })
})

// ═══ 2. FPS IS ROW TRUTH ═════════════════════════════════════════════════════
//
// `sd-cli --help` at the pinned build: `--fps <int>  fps (default: 24)`. Wan
// 2.1 generates 16 fps clips, so the client has always had to pass 16 or the
// file plays 1.5x fast. Wan 2.2 TI2V-5B generates at 24 — the SAME constant is
// now wrong in the OTHER direction, which is why it had to move onto the row.

describe('--fps comes off the row, not off a module constant', () => {
  it('the 2.1 rows are 16 fps and say so', () => {
    for (const id of ['wan21-t2v-1.3b', 'wan21-i2v-14b-480p']) {
      expect(model(id).fps ?? DEFAULT_VIDEO_FPS, id).toBe(16)
    }
  })

  it('TI2V-5B declares 24 — the trap the research pre-caught', () => {
    expect(model('wan22-ti2v-5b').fps).toBe(24)
  })

  it('…and 24 is what reaches sd-cli for that row', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ modelId: 'wan22-ti2v-5b' }),
      OUT,
      { row: videoRow('wan22-ti2v-5b') },
    )
    expect(valueOf(args, '--fps')).toBe('24')
  })

  it('a row-less run keeps the 16 fps default rather than sd-cli\'s 24', () => {
    // No row at all (an unknown id) must not silently inherit the CLI default:
    // every checkpoint we can install today is a 16 fps Wan except the one that
    // declares otherwise.
    const args = buildSdVideoArgs({ diffusion: 'd' }, base({ modelId: 'nope' }), OUT, {})
    expect(valueOf(args, '--fps')).toBe(String(DEFAULT_VIDEO_FPS))
  })
})

// ═══ 3. THE PIXEL GRID ═══════════════════════════════════════════════════════
//
// Wan 2.1's VAE compresses 8x spatially and the DiT patchifies 2x2 → multiples
// of 16. Wan 2.2 TI2V-5B's VAE compresses 16x and patchifies on top → multiples
// of 32, and its 720p pair is 1280x704. The composer's resolution picker speaks
// in LABELS ('720p'), and the label resolves through a Wan 2.1 table, so 1280
// x720 is exactly what this row would have been handed.

describe('-W/-H are snapped onto the ROW\'s pixel grid', () => {
  it('the 2.1 rows are grid 16 and the 2.2 5B row is grid 32', () => {
    expect(model('wan21-t2v-1.3b').pixelGrid ?? DEFAULT_VIDEO_PIXEL_GRID).toBe(16)
    expect(model('wan22-ti2v-5b').pixelGrid).toBe(32)
  })

  it('1280x720 becomes 1280x704 on the 5B row — never 1280x720, never 736', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ modelId: 'wan22-ti2v-5b', width: 1280, height: 720 }),
      OUT,
      { row: videoRow('wan22-ti2v-5b') },
    )
    // FLOOR, not nearest: 720/32 = 22.5, and Math.round would give 736 — a size
    // that is neither what was asked for nor one the checkpoint was trained on,
    // and one that costs MORE memory than the request.
    expect(valueOf(args, '-W')).toBe('1280')
    expect(valueOf(args, '-H')).toBe('704')
  })

  it('the portrait pair snaps the same way', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ modelId: 'wan22-ti2v-5b', width: 720, height: 1280 }),
      OUT,
      { row: videoRow('wan22-ti2v-5b') },
    )
    expect(valueOf(args, '-W')).toBe('704')
    expect(valueOf(args, '-H')).toBe('1280')
  })

  it('480p is already on BOTH grids, so it is passed through untouched', () => {
    // 480 = 15x32 and 832 = 26x32, which is why the low tier needs no special
    // case and why this trap only ever showed up at 720p.
    for (const id of ['wan21-t2v-1.3b', 'wan22-ti2v-5b']) {
      const args = buildSdVideoArgs(
        { diffusion: 'd', vae: 'v', t5xxl: 't' },
        base({ modelId: id, width: 832, height: 480 }),
        OUT,
        { row: videoRow(id) },
      )
      expect(valueOf(args, '-W'), id).toBe('832')
      expect(valueOf(args, '-H'), id).toBe('480')
    }
  })

  it('every curated video row\'s OWN native pair sits on its OWN grid', () => {
    for (const m of SD_VIDEO_MODELS) {
      const grid = m.pixelGrid ?? DEFAULT_VIDEO_PIXEL_GRID
      expect(m.width  % grid, `${m.id} width`).toBe(0)
      expect(m.height % grid, `${m.id} height`).toBe(0)
    }
  })
})

// ═══ 4. FRAMES STAY 4n+1 ═════════════════════════════════════════════════════

describe('--video-frames is held to Wan\'s 4n+1 law at the engine boundary', () => {
  it('every curated video row declares an on-grid frame count', () => {
    // 4 is WAN'S number, not a law of video — the LTX-2.3 row compresses time
    // 8x and declares frameGrid 8 (see sdLtx2Row.test.ts). Reading the grid off
    // the row is what keeps this assertion honest for a row whose count happens
    // to satisfy both (49 is 4x12+1 AND 8x6+1, so a hard-coded 4 would have
    // passed here while the engine silently re-snapped everything else).
    for (const m of SD_VIDEO_MODELS) {
      const grid = m.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID
      expect((m.frames - 1) % grid, m.id).toBe(0)
    }
  })

  it('a raw request that is not 4n+1 is floored onto the law', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ frames: 50 }),
      OUT,
      { row: videoRow('wan21-t2v-1.3b') },
    )
    // FLOOR again: 49 renders, 53 would be a longer clip than was asked for.
    expect(valueOf(args, '--video-frames')).toBe('49')
  })

  it('a single frame is legal — it is 4x0+1, and it is how upstream renders a still', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ frames: 1 }),
      OUT,
      { row: videoRow('wan21-t2v-1.3b') },
    )
    expect(valueOf(args, '--video-frames')).toBe('1')
  })
})

// ═══ 5. THE TWO-DIFFUSION-FILE SCHEMA ════════════════════════════════════════
//
// Upstream docs/wan.md at master-782-b290693, "Wan2.2 I2V A14B", verbatim:
//   --diffusion-model  ...LowNoise-Q8_0.gguf
//   --high-noise-diffusion-model  ...HighNoise-Q8_0.gguf
//   --cfg-scale 3.5 --sampling-method euler --steps 10
//   --high-noise-cfg-scale 3.5 --high-noise-sampling-method euler --high-noise-steps 8
// and NO --clip_vision (that is a Wan 2.1 i2v requirement only).

describe('the A14B row is the first with TWO diffusion files', () => {
  const A14B = {
    diffusion:      'C:/w/a14b/diffusion.gguf',
    diffusion_high: 'C:/w/a14b/diffusion_high.gguf',
    vae:            'C:/w/a14b/vae.safetensors',
    t5xxl:          'C:/w/a14b/t5xxl.gguf',
  }
  const row = () => videoRow('wan22-i2v-a14b')

  it('declares both files, both REQUIRED, in the roles the engine names', () => {
    const m = model('wan22-i2v-a14b')
    const roles = m.files.map(f => f.role).sort()
    expect(roles).toEqual(['diffusion', 'diffusion_high', 't5xxl', 'vae'])
    // clip_vision is a 2.1 i2v requirement. Declaring one here would be 1.2 GB
    // of download for a file the 2.2 pair does not take.
    expect(roles).not.toContain('clip_vision')
  })

  it('the LOW-noise expert is the plain --diffusion-model (upstream\'s own ordering)', () => {
    const args = buildSdVideoArgs(A14B, base({ modelId: 'wan22-i2v-a14b' }), OUT, { row: row() })
    expect(valueOf(args, '--diffusion-model')).toBe(A14B.diffusion)
    expect(valueOf(args, '--high-noise-diffusion-model')).toBe(A14B.diffusion_high)
  })

  it('emits the SPLIT sampler / guidance / steps, each from the row', () => {
    const args = buildSdVideoArgs(A14B, base({ modelId: 'wan22-i2v-a14b' }), OUT, { row: row() })
    expect(valueOf(args, '--steps')).toBe('10')
    expect(valueOf(args, '--high-noise-steps')).toBe('8')
    expect(valueOf(args, '--cfg-scale')).toBe('3.5')
    expect(valueOf(args, '--high-noise-cfg-scale')).toBe('3.5')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
    expect(valueOf(args, '--high-noise-sampling-method')).toBe('euler')
  })

  it('the high-noise flags are emitted ONLY when a high-noise file is present', () => {
    // Passing --high-noise-steps to a single-expert model configures a pass that
    // does not exist. Every one of them is gated on the component, not the row.
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      base({ modelId: 'wan22-i2v-a14b' }),
      OUT,
      { row: row() },
    )
    for (const f of ['--high-noise-diffusion-model', '--high-noise-steps', '--high-noise-cfg-scale', '--high-noise-sampling-method']) {
      expect(args, f).not.toContain(f)
    }
  })

  it('a composer override moves the LOW pass and leaves the high-noise expert alone', () => {
    // There is no high-noise control in the composer, and the research is
    // explicit about where extra steps belong: "low-noise expert owns facial
    // identity, give it the steps". So an override is the LOW pass, and the
    // row's own high-noise recipe stands.
    const args = buildSdVideoArgs(
      A14B,
      base({ modelId: 'wan22-i2v-a14b', steps: 20, cfgScale: 5, samplingMethod: 'heun' }),
      OUT,
      { row: row() },
    )
    expect(valueOf(args, '--steps')).toBe('20')
    expect(valueOf(args, '--high-noise-steps')).toBe('8')
    expect(valueOf(args, '--cfg-scale')).toBe('5')
    expect(valueOf(args, '--high-noise-cfg-scale')).toBe('3.5')
    expect(valueOf(args, '--sampling-method')).toBe('heun')
    expect(valueOf(args, '--high-noise-sampling-method')).toBe('euler')
  })
})

// ═══ 6. THE TI2V-5B ROW DOES BOTH t2v AND i2v ════════════════════════════════
//
// `i2v: true` is what brings the INIT FRAME control back (surplus-media-service
// drops the spec for a row that declares false). The question this row forces:
// does the flag mean "CAN start from an image" or "MUST"? Upstream ships TWO
// commands for this checkpoint — a T2V one and an I2V one that differs by a
// single `-i` — so it has to mean CAN.

describe('TI2V-5B offers an init frame without requiring one', () => {
  const C = { diffusion: 'd', vae: 'v', t5xxl: 't' }

  it('declares i2v true and ships NO clip_vision (it is not a 2.1 i2v model)', () => {
    const m = model('wan22-ti2v-5b')
    expect(m.i2v).toBe(true)
    expect(m.files.map(f => f.role).sort()).toEqual(['diffusion', 't5xxl', 'vae'])
  })

  it('renders text→video when no frame is attached', () => {
    const args = buildSdVideoArgs(C, base({ modelId: 'wan22-ti2v-5b' }), OUT, { row: videoRow('wan22-ti2v-5b') })
    expect(args).not.toContain('-i')
  })

  it('…and image→video when one is', () => {
    const args = buildSdVideoArgs(
      C, base({ modelId: 'wan22-ti2v-5b', initImagePath: 'C:/in/frame.png' }), OUT,
      { row: videoRow('wan22-ti2v-5b') },
    )
    expect(valueOf(args, '-i')).toBe('C:/in/frame.png')
  })

  it('the SCHEMA never marks the init frame required, on any row', () => {
    // The other half of the same claim: `image_url` is an OPTIONAL control that
    // an i2v row keeps and a t2v row loses. If it were `required` the composer
    // would refuse to run a text→video prompt on this checkpoint.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    const svc = readFileSync(resolve(__dirname, '..', '..', 'electron/services/surplus-media-service.ts'), 'utf8')
    const spec = svc.slice(svc.indexOf("{ name: 'image_url',       label: 'Init frame'"))
    expect(spec.slice(0, 200)).not.toContain('required: true')
    // …and the row that CANNOT do it is the one that loses the control.
    expect(svc).toContain('if (localVid && !localVid.i2v) continue')
  })
})

// ═══ 6b. THE SCHEMA THE ROW WIDENS ═══════════════════════════════════════════
//
// localVideoOptionsFor derives every bound from the row, which is what let the
// two new rows land as data. Two of those derivations had to change to stay
// honest, and both are the kind that fail silently:
//   • the resolution LADDER compared a rung's nominal short side against the
//     row's native one, so a 720p-native checkpoint whose pair is 1280x704
//     would have been offered 480p only — installable, with its whole point
//     unreachable;
//   • the seconds bound and default divided by a hard-coded 16.

describe('the composer options a row widens', () => {
  it('TI2V-5B is offered its own 720p tier, and it is the default', () => {
    const res = modelParamSchema('video', 'wan22-ti2v-5b').find(s => s.name === 'resolution')!
    expect(res.enum).toEqual(['480p', '720p'])
    expect(res.default).toBe('720p')
    // …and the description names the real pair, so "720p" is not a lie on screen.
    expect(res.description).toContain('1280x704')
    // 1080p stays out: 1056 (1080 on this row's grid) is above its native 704.
    expect(res.enum).not.toContain('1080p')
  })

  it('the 2.1 rows are unchanged — 480p only, exactly as before', () => {
    for (const id of ['wan21-t2v-1.3b', 'wan21-i2v-14b-480p', 'wan22-i2v-a14b']) {
      const res = modelParamSchema('video', id).find(s => s.name === 'resolution')!
      expect(res.enum, id).toEqual(['480p'])
    }
  })

  it('the duration slider is bounded and defaulted at the ROW\'s frame rate', () => {
    const dur = (id: string) => modelParamSchema('video', id).find(s => s.name === 'duration')!
    // 81 frames is a COUNT: ~5 s at 16 fps, ~3 s at 24.
    expect(dur('wan21-t2v-1.3b')).toMatchObject({ min: 1, max: 5, default: 2, fps: 16 })
    expect(dur('wan22-i2v-a14b')).toMatchObject({ min: 1, max: 5, default: 2, fps: 16 })
    expect(dur('wan22-ti2v-5b')).toMatchObject({ min: 1, max: 3, default: 2, fps: 24 })
    // The default is the row's own clip length in ITS rate — both rows default
    // to the same ~2 s of video, which is the point of choosing 49 frames.
    expect(dur('wan22-ti2v-5b').description).toContain('24 fps')
  })

  it('a CLOUD video model keeps the superset and carries NO fps', () => {
    const cloud = modelParamSchema('video', 'some-cloud-video-model')
    expect(cloud.find(s => s.name === 'resolution')!.enum).toEqual(['480p', '720p', '1080p'])
    const dur = cloud.find(s => s.name === 'duration')!
    expect(dur.max).toBe(30)
    // `fps` is a LOCAL derivation. A cloud duration is a wire value and no frame
    // count is computed from it, so claiming a rate would be inventing one.
    expect(dur.fps).toBeUndefined()
  })

  it('the init frame is offered on both new rows and on neither is it required', () => {
    for (const id of ['wan22-ti2v-5b', 'wan22-i2v-a14b']) {
      const img = modelParamSchema('video', id).find(s => s.name === 'image_url')
      expect(img, id).toBeDefined()
      expect(img!.required, id).toBeFalsy()
      expect(img!.label, id).toBe('Init frame (image→video)')
    }
    // …and the t2v row still loses it entirely.
    expect(modelParamSchema('video', 'wan21-t2v-1.3b').some(s => s.name === 'image_url')).toBe(false)
  })

  it('the negative prompt is pre-filled and LIVE on both new rows', () => {
    for (const id of ['wan22-ti2v-5b', 'wan22-i2v-a14b']) {
      const neg = modelParamSchema('video', id).find(s => s.name === 'negative_prompt')!
      expect(neg.default, id).toBe(WAN_DEFAULT_NEGATIVE)
      // The "does nothing here" copy belongs to guidance-1 rows only.
      expect(neg.description, id).not.toContain('has no effect')
    }
  })
})

// ═══ 7. THE NEGATIVE PROMPT ══════════════════════════════════════════════════

describe('both new Wan rows carry Wan\'s official negative', () => {
  it('every Wan row declares it verbatim', () => {
    for (const m of SD_VIDEO_MODELS.filter(x => x.family === 'wan')) {
      expect(m.negativePrompt, m.id).toBe(WAN_DEFAULT_NEGATIVE)
    }
  })

  it('…and it is LIVE on both, because neither renders at guidance 1', () => {
    // sd.cpp only encodes the unconditional pass when cfg != 1, so a row at
    // guidance 1 would make this string inert (the z-image case).
    for (const id of ['wan22-ti2v-5b', 'wan22-i2v-a14b']) {
      expect(model(id).cfgScale, id).toBeGreaterThan(1)
    }
    // The A14B pair runs BOTH passes above 1 too — a high-noise expert at
    // guidance 1 would silently drop the negative on half the render.
    expect(model('wan22-i2v-a14b').highNoiseCfgScale).toBeGreaterThan(1)
  })
})
