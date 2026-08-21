// apps/desktop/test/unit/sdModelExtensionTruth.test.ts
//
// A SAFETENSORS CHECKPOINT DOES NOT LAND ON DISK AS model.gguf (spec risk R2).
//
// fileExtFor decided a component's on-disk extension by `extname(url)`, with a
// role-keyed fallback: `model` / `diffusion` / `t5xxl` → `.gguf`, everything
// else → `.safetensors`. That was never wrong for the curated rows, because
// every curated URL ends in a real extension. Then Civitai:
//
//     https://civitai.com/api/download/models/812345
//
// No extension anywhere in the path. So a 6.5 GB SDXL SAFETENSORS checkpoint —
// role `model` — would have been written as `model.gguf`, and sd-cli would have
// refused a file whose bytes contradict its name. Nothing would have said why:
// the download succeeds, the sha verifies, and the model is simply broken.
//
// The fix reads the row's DECLARED format / fileName first, and refuses pickle
// containers outright at this layer as well as at the mapper (defense in depth:
// this is the last gate before a path is handed out or bytes are fetched).
//
// Real electron mock + real fs, matching sdCppArchiveReuse.test.ts in this dir.

import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// hoisted: vi.mock factories run before module-level consts, and storage-root
// reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdext-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { fileExtFor, modelComponentPaths, isSdModelInstalled, listInstalledSdModels } from '../../electron/services/sd-cpp-installer'
import {
  UserSdModelStore, userSdModelFromCivitaiRow, setUserSdModelStore, USER_SD_MODELS_FILENAME,
  type CivitaiRowLike,
} from '../../electron/services/user-sd-models'

afterAll(() => {
  setUserSdModelStore(null)
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* */ }
})

const CIVITAI_URL = 'https://civitai.com/api/download/models/812345'

describe('fileExtFor — the declared format decides, not the URL', () => {
  it('THE REGRESSION: a Civitai safetensors checkpoint is .safetensors, not .gguf', () => {
    // Same input, old rule: extname('') → '' → role 'model' → '.gguf'.
    expect(fileExtFor({ url: CIVITAI_URL, format: 'SafeTensor', fileName: 'juggernautXL_v9.safetensors' }, 'model'))
      .toBe('.safetensors')
  })

  it('the format wins even when the FILENAME disagrees (upstream knows its own container)', () => {
    expect(fileExtFor({ url: CIVITAI_URL, format: 'SafeTensor', fileName: 'model.gguf' }, 'model')).toBe('.safetensors')
    expect(fileExtFor({ url: CIVITAI_URL, format: 'GGUF', fileName: 'model.safetensors' }, 'model')).toBe('.gguf')
  })

  it('accepts the spellings upstream actually uses', () => {
    for (const f of ['SafeTensor', 'safetensor', ' SafeTensors ', 'SAFETENSORS']) {
      expect(fileExtFor({ url: CIVITAI_URL, format: f }, 'model')).toBe('.safetensors')
    }
    for (const f of ['GGUF', 'gguf', ' Gguf ']) {
      expect(fileExtFor({ url: CIVITAI_URL, format: f }, 'model')).toBe('.gguf')
    }
  })

  it('"Other" declares NOTHING — Civitai reports GGUF that way, so it must fall through', () => {
    // filename decides…
    expect(fileExtFor({ url: CIVITAI_URL, format: 'Other', fileName: 'flux1-schnell-Q4_K_S.gguf' }, 'diffusion')).toBe('.gguf')
    expect(fileExtFor({ url: CIVITAI_URL, format: 'Other', fileName: 'x.safetensors' }, 'model')).toBe('.safetensors')
    // …and with neither, the legacy role guess still stands
    expect(fileExtFor({ url: CIVITAI_URL, format: 'Other' }, 'model')).toBe('.gguf')
  })

  it('REFUSES a pickle container — null means "never write this to disk"', () => {
    for (const f of ['PickleTensor', 'pickletensor', 'Pickle', 'ckpt', 'Diffusers']) {
      expect(fileExtFor({ url: CIVITAI_URL, format: f }, 'model')).toBeNull()
    }
    for (const n of ['weights.ckpt', 'weights.pt', 'weights.pth', 'weights.bin', 'weights.pickle']) {
      expect(fileExtFor({ url: CIVITAI_URL, fileName: n }, 'model')).toBeNull()
    }
    expect(fileExtFor({ url: 'https://example.org/model.ckpt' }, 'model')).toBeNull()
  })

  it('EVERY CURATED URL still derives exactly what it derived before (no silent re-layout)', () => {
    // If this table changed, an already-installed model would stop being found
    // (isSdModelInstalled checks a path built from this very function).
    const table: Array<[string, string, string]> = [
      ['https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors', 'model', '.safetensors'],
      ['https://huggingface.co/x/y/resolve/main/v1-5-pruned-emaonly.safetensors',       'model', '.safetensors'],
      ['https://huggingface.co/x/y/resolve/main/sd_xl_base_1.0.safetensors',            'model', '.safetensors'],
      ['https://huggingface.co/x/y/resolve/main/flux1-schnell-Q4_K_S.gguf',        'diffusion', '.gguf'],
      ['https://huggingface.co/x/y/resolve/main/ae.safetensors',                        'vae', '.safetensors'],
      ['https://huggingface.co/x/y/resolve/main/clip_l.safetensors',                 'clip_l', '.safetensors'],
      ['https://huggingface.co/x/y/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf',      't5xxl', '.gguf'],
    ]
    for (const [url, role, ext] of table) expect(fileExtFor({ url }, role), url).toBe(ext)
  })

  it('the legacy role fallback is unchanged for a URL that declares nothing', () => {
    for (const role of ['model', 'diffusion', 't5xxl']) {
      expect(fileExtFor({ url: CIVITAI_URL }, role)).toBe('.gguf')
    }
    for (const role of ['vae', 'clip_l', 'clip_g', 'clip_vision']) {
      expect(fileExtFor({ url: CIVITAI_URL }, role)).toBe('.safetensors')
    }
  })

  it('survives a malformed url instead of throwing on `new URL`', () => {
    expect(fileExtFor({ url: 'not a url', format: 'SafeTensor' }, 'model')).toBe('.safetensors')
    expect(fileExtFor({ url: 'not a url' }, 'model')).toBe('.gguf')
  })

  it('a query string does not become the extension', () => {
    expect(fileExtFor({ url: 'https://civitai.com/api/download/models/1?type=Model&format=SafeTensor' }, 'model'))
      .toBe('.gguf')      // the PATH has no extension; only `format`/`fileName` may say otherwise
    expect(fileExtFor({ url: 'https://civitai.com/api/download/models/1?format=SafeTensor', format: 'SafeTensor' }, 'model'))
      .toBe('.safetensors')
  })
})

// ═══ MUTATION CHECK on the extension table ═══════════════════════════════════

describe('mutation check — a wrong extension rule is caught', () => {
  it('MUTANT "url extname only" (the shipped bug): the Civitai checkpoint becomes .gguf', () => {
    const buggy = (url: string, role: string) => {
      let e = ''
      try { e = new URL(url).pathname.replace(/^.*(\.[^./]+)$/, '$1') } catch { /* */ }
      if (e.startsWith('.')) return e
      return (role === 'model' || role === 'diffusion' || role === 't5xxl') ? '.gguf' : '.safetensors'
    }
    expect(buggy(CIVITAI_URL, 'model')).toBe('.gguf')
    expect(fileExtFor({ url: CIVITAI_URL, format: 'SafeTensor' }, 'model')).toBe('.safetensors')
  })

  it('MUTANT "filename before format": a mislabelled name would win over upstream truth', () => {
    expect(fileExtFor({ url: CIVITAI_URL, format: 'SafeTensor', fileName: 'model.gguf' }, 'model')).not.toBe('.gguf')
  })

  it('MUTANT "pickle allowed": the refusal must be a null, not a .ckpt path', () => {
    expect(fileExtFor({ url: CIVITAI_URL, format: 'PickleTensor' }, 'model')).not.toBe('.ckpt')
    expect(fileExtFor({ url: CIVITAI_URL, format: 'PickleTensor' }, 'model')).toBeNull()
  })

  it('MUTANT "format always wins, even unknown": "Other" must NOT map to safetensors', () => {
    expect(fileExtFor({ url: CIVITAI_URL, format: 'Other', fileName: 'a.gguf' }, 'diffusion')).toBe('.gguf')
  })
})

// ═══ END TO END: a user model resolves to a real path and reports installed ══

describe('a user-installed model resolves through the SAME paths a curated one does', () => {
  const row: CivitaiRowLike = {
    id: 'civitai-812345', modelId: 133005, versionId: 812345,
    name: 'Juggernaut XL - v9', family: 'sdxl', baseModel: 'SDXL 1.0',
    sizeMb: 6617, sha256: 'a'.repeat(64),
    downloadUrl: CIVITAI_URL, fileName: 'juggernautXL_v9.safetensors', format: 'SafeTensor',
  }

  it('modelComponentPaths names the file .safetensors (the .gguf trap, one layer up)', () => {
    const store = new UserSdModelStore(join(USERDATA, USER_SD_MODELS_FILENAME))
    setUserSdModelStore(store)
    store.add(userSdModelFromCivitaiRow(row))

    const paths = modelComponentPaths('civitai-812345')
    expect(paths).not.toBeNull()
    expect(paths!.model.endsWith('model.safetensors')).toBe(true)
    expect(paths!.model).toContain('civitai-812345')
  })

  it('isSdModelInstalled / listInstalledSdModels see it once the bytes are there', () => {
    const store = new UserSdModelStore(join(USERDATA, USER_SD_MODELS_FILENAME))
    setUserSdModelStore(store)
    store.add(userSdModelFromCivitaiRow(row))

    expect(isSdModelInstalled('civitai-812345')).toBe(false)
    const p = modelComponentPaths('civitai-812345')!.model
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, 'weights')

    expect(isSdModelInstalled('civitai-812345')).toBe(true)
    const listed = listInstalledSdModels().find(m => m.id === 'civitai-812345')
    // THE R3 BUG, closed: name + declared family travel with it, so the dropdown
    // shows 'Juggernaut XL - v9' rather than 'civitai-812345' and the composer
    // gets the SDXL grid instead of the sd15 one — and the row's OWN recipe
    // rides along (audit D2/D4/D5), which is what stops the sliders showing
    // SD 1.5 numbers on SDXL weights.
    expect(listed).toEqual({
      id: 'civitai-812345', name: 'Juggernaut XL - v9', kind: 'image', family: 'sdxl',
      steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m',
    })
  })

  it('a REFUSED container yields no paths at all — nothing can be placed or probed', () => {
    const store = new UserSdModelStore(join(USERDATA, 'refused.json'))
    setUserSdModelStore(store)
    // The mapper refuses pickle, so a poisoned row can only arrive by hand —
    // write one straight into the registry and prove the layer below still holds.
    const poisoned = { ...userSdModelFromCivitaiRow({ ...row, versionId: 999 }) }
    poisoned.files = [{ ...poisoned.files[0], format: 'PickleTensor' }]
    expect(() => store.add(poisoned)).toThrow(/Refusing to register/)
    // …and even if it HAD landed, modelComponentPaths refuses to build a path.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setUserSdModelStore(new UserSdModelStore(join(USERDATA, 'hand-edited.json')))
    writeFileSync(join(USERDATA, 'hand-edited.json'), JSON.stringify({ version: 1, models: [poisoned] }), 'utf8')
    expect(modelComponentPaths('civitai-999')).toBeNull()
    expect(isSdModelInstalled('civitai-999')).toBe(false)
    warn.mockRestore()
  })
})
