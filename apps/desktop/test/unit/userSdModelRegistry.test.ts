// apps/desktop/test/unit/userSdModelRegistry.test.ts
//
// A MODEL THE USER INSTALLED ACTUALLY EXISTS (spec risk R3).
//
// sd.cpp listed its models from two hardcoded consts. Anything the user
// installed from outside them — the whole point of the Civitai integration —
// was invisible to findSdModel, therefore to modelComponentPaths, therefore to
// isSdModelInstalled, therefore to sd-cpp:status and the MediaPage dropdown;
// and a generate call naming it threw "Unknown sd.cpp model id". The bytes were
// on disk and nothing could run them.
//
// This file pins the registry that fixes it, and the three rules it exists to
// enforce rather than document:
//
//   1. IDS ARE [a-z0-9-] (risk R10) — sdManagedIdPrefix builds a Stop sweep out
//      of `sd:<id>:` and matches on that trailing colon, so an id carrying a
//      colon would make one model's Stop pause another model's download.
//   2. A CREDENTIAL NEVER REACHES THE DISK — user-sd-models.json is plaintext
//      under userData while the key's home is the DPAPI-encrypted keychain.
//   3. A CORRUPT REGISTRY DEGRADES, IT DOES NOT THROW — the merge runs on the
//      same call that lists the CURATED models, so a bad row must cost one
//      model, never all of them.
//
// Real fs against a real temp file (the cost-ledger shape): the verdict turns
// on bytes that actually round-trip, not on a fake.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  UserSdModelStore, userSdModelFromCivitaiRow, normalizeUserSdModel, familyDefaults,
  civitaiModelId, isValidUserSdModelId, isRefusedWeightFormat, shaPlaceholderFor,
  listUserSdModels, addUserSdModel, removeUserSdModel, setUserSdModelStore, isUserSdModelId,
  USER_SD_MODELS_FILENAME,
  type CivitaiRowLike, type UserSdModel,
} from '../../electron/services/user-sd-models'
import {
  allSdModels, findSdModel, isShaPlaceholder, SD_IMAGE_MODELS, SD_VIDEO_MODELS, SD_PRESETS,
} from '../../electron/services/sd-cpp-models'

let dir: string
let store: UserSdModelStore
const dirs: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tachi-usermodels-'))
  dirs.push(dir)
  store = new UserSdModelStore(join(dir, USER_SD_MODELS_FILENAME))
  setUserSdModelStore(store)
})

afterAll(() => {
  setUserSdModelStore(null)
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* */ } }
})

/** A realistic row, shaped exactly like the shared CivitaiSearchRow contract. */
function row(over: Partial<CivitaiRowLike> = {}): CivitaiRowLike {
  return {
    id: 'civitai-812345',
    modelId: 133005, versionId: 812345,
    name: 'Juggernaut XL - v9',
    family: 'sdxl',
    baseModel: 'SDXL 1.0',
    sizeMb: 6617,
    sha256: '31E35C80FC4829D14F90153F4C74CD59C90B779F6AFE05A74CD6120B893F7E5B',
    downloadUrl: 'https://civitai.com/api/download/models/812345',
    fileName: 'juggernautXL_v9.safetensors',
    format: 'SafeTensor',
    fp: 'fp16',
    trainedWords: ['cinematic photo'],
    license: { commercial: ['Image', 'Sell'], noCredit: true, derivatives: true },
    ...over,
  }
}

// ═══ THE MAPPER — the cross-lane export contract ═════════════════════════════

describe('userSdModelFromCivitaiRow — a search row becomes a runnable registry row', () => {
  it('maps the contract fields onto the SdImageModel shape lane B installs', () => {
    const m = userSdModelFromCivitaiRow(row())
    expect(m.id).toBe('civitai-812345')
    expect(m.name).toBe('Juggernaut XL - v9')
    expect(m.family).toBe('sdxl')
    expect(m.baseSize).toBe(1024)
    expect(m.files).toHaveLength(1)
    expect(m.files[0]).toMatchObject({
      role: 'model',
      url: 'https://civitai.com/api/download/models/812345',
      sizeMb: 6617,
      fileName: 'juggernautXL_v9.safetensors',
      format: 'SafeTensor',
    })
  })

  it('LOWERCASES the sha256 — Civitai publishes it uppercase and every comparison here is lowercase', () => {
    expect(userSdModelFromCivitaiRow(row()).files[0].sha256)
      .toBe('31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b')
  })

  it('derives the id from the VERSION id, so a malformed row.id cannot smuggle one in', () => {
    expect(userSdModelFromCivitaiRow(row({ id: 'civitai:812345 evil' })).id).toBe('civitai-812345')
    expect(civitaiModelId(812345)).toBe('civitai-812345')
    expect(isValidUserSdModelId(civitaiModelId(812345))).toBe(true)
  })

  it('NEVER produces an id with a colon — sdManagedIdPrefix sweeps on `sd:<id>:`', () => {
    for (const v of [1, 999999, 812345]) expect(civitaiModelId(v)).not.toContain(':')
    expect(isValidUserSdModelId('civitai-812345:extra')).toBe(false)
    expect(isValidUserSdModelId('Civitai-812345')).toBe(false)   // uppercase is out too
    expect(isValidUserSdModelId('civitai 812345')).toBe(false)
    expect(isValidUserSdModelId('-leading-dash')).toBe(false)
    expect(isValidUserSdModelId('')).toBe(false)
    expect(isValidUserSdModelId('a'.repeat(65))).toBe(false)
  })

  it('REFUSES an unmapped family — a row we cannot pick a grid for is a fabricated capability', () => {
    expect(() => userSdModelFromCivitaiRow(row({ family: null, baseModel: 'Flux.2' })))
      .toThrow(/does not map to a family this engine runs/)
  })

  it('REFUSES a pickle container even though lane B already filtered it (defense in depth)', () => {
    expect(() => userSdModelFromCivitaiRow(row({ format: 'PickleTensor' }))).toThrow(/not supported/)
    expect(() => userSdModelFromCivitaiRow(row({ format: 'pickletensor' }))).toThrow(/not supported/)
    expect(() => userSdModelFromCivitaiRow(row({ format: 'Diffusers' }))).toThrow(/not supported/)
    expect(isRefusedWeightFormat('PickleTensor')).toBe(true)
    expect(isRefusedWeightFormat('SafeTensor')).toBe(false)
    expect(isRefusedWeightFormat('Other')).toBe(false)
    expect(isRefusedWeightFormat(null)).toBe(false)
  })

  it('a MISSING sha256 becomes the fail-closed placeholder, not a silent unverified download', () => {
    const m = userSdModelFromCivitaiRow(row({ sha256: null }))
    expect(isShaPlaceholder(m.files[0].sha256)).toBe(true)
    expect(m.files[0].sha256).toBe(shaPlaceholderFor('civitai-812345'))
    // …and the installer's packaged-build gate is keyed on exactly that predicate.
    expect(isShaPlaceholder('31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b')).toBe(false)
  })

  it('never UNDER-declares the size — the disk preflight is keyed on it', () => {
    expect(userSdModelFromCivitaiRow(row({ sizeMb: 6616.2 })).files[0].sizeMb).toBe(6617)
    expect(userSdModelFromCivitaiRow(row({ sizeMb: 0 })).files[0].sizeMb).toBe(1)
    expect(userSdModelFromCivitaiRow(row({ sizeMb: NaN })).files[0].sizeMb).toBe(1)
  })

  it('keeps the upstream baseModel VERBATIM next to our family verdict', () => {
    const m = userSdModelFromCivitaiRow(row({ baseModel: 'Pony', family: 'sdxl' }))
    expect(m.source).toMatchObject({ kind: 'civitai', modelId: 133005, versionId: 812345, baseModel: 'Pony' })
    expect(m.family).toBe('sdxl')
    expect(m.source?.trainedWords).toEqual(['cinematic photo'])
  })

  it('says so in the notes when the license restricts commerce or requires credit', () => {
    expect(userSdModelFromCivitaiRow(row({ license: { commercial: [], noCredit: false, derivatives: true } })).notes)
      .toBe('Civitai · SDXL 1.0 · no commercial use · credit required')
    expect(userSdModelFromCivitaiRow(row()).notes).toBe('Civitai · SDXL 1.0')
  })

  it('carries a credential only when one is handed in — the mapper has no keychain', () => {
    expect(userSdModelFromCivitaiRow(row()).headers).toBeUndefined()
    const authed = userSdModelFromCivitaiRow(row(), { headers: { Authorization: 'Bearer secret-token' } })
    expect(authed.headers).toEqual({ Authorization: 'Bearer secret-token' })
    expect(authed.requiresKey).toBe(true)
  })

  it('rejects a header map that could smuggle a second header (CRLF injection)', () => {
    const bad = userSdModelFromCivitaiRow(row(), { headers: { Authorization: 'Bearer x\r\nX-Evil: 1' } })
    expect(bad.headers).toBeUndefined()
    expect(userSdModelFromCivitaiRow(row(), { headers: { 'Bad Name': 'x' } }).headers).toBeUndefined()
  })
})

describe('familyDefaults — a user row starts where the shipped row of its family starts', () => {
  const curated = (id: string) => SD_IMAGE_MODELS.find(m => m.id === id)!

  it.each([
    ['sd15', 'sd15'],
    ['sdxl', 'sdxl-base-1.0'],
    ['flux', 'flux-schnell-q4'],
  ] as const)('%s defaults are RECOMPUTED from the %s row, not typed in twice', (family, rowId) => {
    const c = curated(rowId)
    expect(familyDefaults(family)).toEqual({
      baseSize:       c.baseSize,
      steps:          c.steps,
      cfgScale:       c.cfgScale,
      samplingMethod: c.samplingMethod,
    })
  })

  it('every family the mapper can emit has a preset column too (no preset lookup can miss)', () => {
    for (const family of ['sd15', 'sdxl', 'flux'] as const) {
      for (const p of SD_PRESETS) expect(p.params[family]).toBeDefined()
    }
  })

  it('the returned object is a COPY — a caller cannot mutate the table', () => {
    const d = familyDefaults('sdxl')
    d.steps = 1
    expect(familyDefaults('sdxl').steps).toBe(28)
  })
})

// ═══ THE STORE ═══════════════════════════════════════════════════════════════

describe('UserSdModelStore — persistence', () => {
  it('an absent registry is an empty list, not a throw', () => {
    expect(store.list()).toEqual([])
    expect(store.get('civitai-1')).toBeUndefined()
    expect(store.remove('civitai-1')).toBe(false)
  })

  it('round-trips a mapped row through the file', () => {
    const added = store.add(userSdModelFromCivitaiRow(row()))
    expect(added.id).toBe('civitai-812345')
    const fresh = new UserSdModelStore(store.path())
    expect(fresh.list()).toHaveLength(1)
    expect(fresh.list()[0]).toMatchObject({ id: 'civitai-812345', name: 'Juggernaut XL - v9', family: 'sdxl', baseSize: 1024 })
    expect(fresh.list()[0].files[0].sha256).toBe('31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b')
  })

  it('REPLACES by id instead of accumulating duplicates (a re-install is not a second model)', () => {
    store.add(userSdModelFromCivitaiRow(row()))
    store.add(userSdModelFromCivitaiRow(row({ name: 'Juggernaut XL - v9 (repinned)' })))
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Juggernaut XL - v9 (repinned)')
  })

  it('keeps insertion order across several models', () => {
    for (const v of [1001, 1002, 1003]) store.add(userSdModelFromCivitaiRow(row({ versionId: v, name: `M${v}` })))
    expect(store.list().map(m => m.id)).toEqual(['civitai-1001', 'civitai-1002', 'civitai-1003'])
    store.remove('civitai-1002')
    expect(store.list().map(m => m.id)).toEqual(['civitai-1001', 'civitai-1003'])
  })

  it('WRITES ATOMICALLY — a temp sibling is renamed, never left behind', () => {
    store.add(userSdModelFromCivitaiRow(row()))
    const names = readdirSync(dir)
    expect(names).toContain(USER_SD_MODELS_FILENAME)
    expect(names.filter(n => n.includes('.tmp'))).toEqual([])
    // the file on disk is COMPLETE json at every observable moment
    expect(() => JSON.parse(readFileSync(join(dir, USER_SD_MODELS_FILENAME), 'utf8'))).not.toThrow()
    expect(JSON.parse(readFileSync(join(dir, USER_SD_MODELS_FILENAME), 'utf8')).version).toBe(1)
  })

  it('creates the parent directory rather than failing the first install', () => {
    const nested = new UserSdModelStore(join(dir, 'deep', 'deeper', USER_SD_MODELS_FILENAME))
    nested.add(userSdModelFromCivitaiRow(row()))
    expect(nested.list()).toHaveLength(1)
  })

  it('re-reads after an EXTERNAL write (the cache is keyed on mtime+size, not on trust)', () => {
    store.add(userSdModelFromCivitaiRow(row()))
    expect(store.list()).toHaveLength(1)
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), JSON.stringify({ version: 1, models: [] }), 'utf8')
    store.invalidate()
    expect(store.list()).toEqual([])
  })

  it('hands back COPIES — mutating a listed row cannot corrupt the cache', () => {
    store.add(userSdModelFromCivitaiRow(row()))
    const first = store.list()[0]
    first.name = 'mutated'
    first.files[0].sizeMb = 1
    expect(store.list()[0].name).toBe('Juggernaut XL - v9')
  })
})

describe('UserSdModelStore — a credential never reaches the disk', () => {
  it('add() STRIPS headers and records only the FACT that a key was needed', () => {
    store.add(userSdModelFromCivitaiRow(row(), { headers: { Authorization: 'Bearer super-secret-token' } }))
    const raw = readFileSync(join(dir, USER_SD_MODELS_FILENAME), 'utf8')
    expect(raw).not.toContain('super-secret-token')
    expect(raw).not.toContain('Authorization')
    expect(store.list()[0].headers).toBeUndefined()
    expect(store.list()[0].requiresKey).toBe(true)
  })

  it('a credential hand-written into the file is ignored on the way OUT too', () => {
    const doc = {
      version: 1,
      models: [{
        ...userSdModelFromCivitaiRow(row()),
        headers: { Authorization: 'Bearer leaked' },
      }],
    }
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), JSON.stringify(doc), 'utf8')
    store.invalidate()
    expect(store.list()[0].headers).toBeUndefined()
    expect(store.list()[0].requiresKey).toBe(true)
  })
})

describe('UserSdModelStore — validation refuses what would poison the registry', () => {
  const good = (): UserSdModel => userSdModelFromCivitaiRow(row())

  it.each([
    ['a colon in the id (breaks the Stop sweep)', { id: 'civitai:812345' }],
    ['an uppercase id',                           { id: 'Civitai-812345' }],
    ['an empty name',                             { name: '   ' }],
    ['an unknown family',                         { family: 'pony' as unknown as 'sdxl' }],
    ['an off-grid baseSize',                      { baseSize: 768 as unknown as 1024 }],
    ['zero steps',                                { steps: 0 }],
    ['no files',                                  { files: [] }],
  ])('refuses %s', (_label, over) => {
    expect(() => store.add({ ...good(), ...over } as UserSdModel)).toThrow(/Refusing to register/)
    expect(store.list()).toEqual([])
  })

  it.each([
    ['an http url',            { url: 'http://civitai.com/api/download/models/1' }],
    ['a non-hex sha',          { sha256: 'not-a-hash' }],
    ['a zero size',            { sizeMb: 0 }],
    ['an unknown role',        { role: 'lora' as unknown as 'model' }],
    ['a refused container',    { format: 'PickleTensor' }],
  ])('refuses a component file with %s', (_label, over) => {
    const m = good()
    m.files = [{ ...m.files[0], ...over }]
    expect(() => store.add(m)).toThrow(/Refusing to register/)
  })

  it('refuses two files claiming the same role — their on-disk paths would collide', () => {
    const m = good()
    m.files = [m.files[0], { ...m.files[0] }]
    expect(() => store.add(m)).toThrow(/Refusing to register/)
  })

  it('accepts a legitimate MULTI-COMPONENT row (the flux shape is not user-model-only theory)', () => {
    const m = good()
    m.family = 'flux'
    m.files = [
      { role: 'diffusion', url: 'https://example.org/a.gguf',        sha256: 'a'.repeat(64), sizeMb: 6470 },
      { role: 'vae',       url: 'https://example.org/ae.safetensors', sha256: 'b'.repeat(64), sizeMb: 320 },
    ]
    expect(store.add(m).files).toHaveLength(2)
  })
})

describe('UserSdModelStore — a corrupt registry degrades, it never throws', () => {
  it('unparseable json reads as empty', () => {
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), '{ not json', 'utf8')
    store.invalidate()
    expect(store.list()).toEqual([])
  })

  it('a bad ROW is dropped and the good ones survive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = {
      version: 1,
      models: [
        userSdModelFromCivitaiRow(row({ versionId: 1, name: 'good one' })),
        { id: 'civitai:evil', name: 'colon id', family: 'sdxl', baseSize: 1024, steps: 1, cfgScale: 1, samplingMethod: 'euler', files: [] },
        null,
        'a string',
        userSdModelFromCivitaiRow(row({ versionId: 2, name: 'good two' })),
      ],
    }
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), JSON.stringify(doc), 'utf8')
    store.invalidate()
    expect(store.list().map(m => m.name)).toEqual(['good one', 'good two'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a DUPLICATE id keeps the first row rather than shadowing itself', () => {
    const doc = { version: 1, models: [
      userSdModelFromCivitaiRow(row({ name: 'first' })),
      userSdModelFromCivitaiRow(row({ name: 'second' })),
    ] }
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), JSON.stringify(doc), 'utf8')
    store.invalidate()
    expect(store.list().map(m => m.name)).toEqual(['first'])
  })

  it('a models key that is not an array is empty, not a crash', () => {
    writeFileSync(join(dir, USER_SD_MODELS_FILENAME), JSON.stringify({ version: 1, models: 'nope' }), 'utf8')
    store.invalidate()
    expect(store.list()).toEqual([])
  })

  it('normalizeUserSdModel is the single gate both paths run through', () => {
    expect(normalizeUserSdModel(null)).toBeNull()
    expect(normalizeUserSdModel({ id: 'ok' })).toBeNull()
    expect(normalizeUserSdModel(userSdModelFromCivitaiRow(row()))?.id).toBe('civitai-812345')
  })
})

// ═══ THE MERGE — what makes the model VISIBLE ════════════════════════════════

describe('sd-cpp-models merges curated ∪ user, and curated always wins', () => {
  const user = (over: Partial<CivitaiRowLike> = {}) => userSdModelFromCivitaiRow(row(over))

  it('findSdModel resolves a user id that no curated row declares', () => {
    expect(findSdModel('civitai-812345', [])).toBeUndefined()
    expect(findSdModel('civitai-812345', [user()])?.name).toBe('Juggernaut XL - v9')
  })

  it('findSdModel still resolves every curated id with user rows present', () => {
    for (const id of ['sd-turbo', 'sd15', 'sdxl-base-1.0', 'flux-schnell-q4', 'wan21-t2v-1.3b']) {
      expect(findSdModel(id, [user()])?.id).toBe(id)
    }
  })

  it('CURATED WINS a collision — a user row can never shadow a pinned sha/url/size', () => {
    const impostor = { ...user(), id: 'sd15', name: 'not the real sd15' }
    expect(findSdModel('sd15', [impostor])?.name).toBe('Stable Diffusion 1.5')
    expect(allSdModels([impostor]).filter(m => m.id === 'sd15')).toHaveLength(1)
    expect(allSdModels([impostor]).find(m => m.id === 'sd15')!.name).toBe('Stable Diffusion 1.5')
  })

  it('allSdModels appends user rows as IMAGE models carrying name + declared family', () => {
    const merged = allSdModels([user()])
    const mine = merged.find(m => m.id === 'civitai-812345')!
    expect(mine).toMatchObject({ kind: 'image', name: 'Juggernaut XL - v9', family: 'sdxl' })
    expect(mine.files).toHaveLength(1)
    // …and every curated row now reports its family too (the renderer reads it)
    expect(merged.find(m => m.id === 'sdxl-base-1.0')!.family).toBe('sdxl')
    expect(merged.find(m => m.id === 'wan21-t2v-1.3b')!.family).toBe('wan')
  })

  it('an EMPTY user registry leaves the curated listing byte-identical', () => {
    expect(allSdModels([]).map(m => m.id)).toEqual(
      [...SD_IMAGE_MODELS.map(m => m.id), ...SD_VIDEO_MODELS.map(m => m.id)],
    )
  })

  it('the LIVE default reads the singleton store — the merge is not test-only plumbing', () => {
    expect(findSdModel('civitai-812345')).toBeUndefined()
    addUserSdModel(userSdModelFromCivitaiRow(row()))
    expect(listUserSdModels().map(m => m.id)).toEqual(['civitai-812345'])
    expect(findSdModel('civitai-812345')?.name).toBe('Juggernaut XL - v9')
    expect(allSdModels().some(m => m.id === 'civitai-812345')).toBe(true)
    expect(isUserSdModelId('civitai-812345')).toBe(true)
    expect(isUserSdModelId('sd15')).toBe(false)
    expect(removeUserSdModel('civitai-812345')).toBe(true)
    expect(findSdModel('civitai-812345')).toBeUndefined()
  })

  it('an unreachable registry costs the USER models only — the curated three still list', () => {
    // The soft-fail that matters: this same call lists the shipped models.
    setUserSdModelStore(new UserSdModelStore(join(dir, 'nope', 'missing.json')))
    expect(listUserSdModels()).toEqual([])
    expect(allSdModels().map(m => m.id)).toContain('sdxl-base-1.0')
    expect(allSdModels().length).toBe(SD_IMAGE_MODELS.length + SD_VIDEO_MODELS.length)
  })
})

// ═══ MUTATION CHECK on the merge ═════════════════════════════════════════════
//
// Each block below is a plausible WRONG merge. Every one must break at least
// one assertion above — pinned here so the suite proves it discriminates.

describe('mutation check — a wrong merge is caught', () => {
  const user = userSdModelFromCivitaiRow(row())
  const curated = allSdModels([])

  it('MUTANT "user wins the collision": the curated name would be lost', () => {
    const impostor = { ...user, id: 'sd15', name: 'not the real sd15' }
    const wrong = [...curated.filter(m => m.id !== 'sd15'), { id: 'sd15', name: impostor.name, kind: 'image' as const, family: 'sdxl', files: impostor.files }]
    expect(wrong.find(m => m.id === 'sd15')!.name).not.toBe(findSdModel('sd15', [impostor])!.name)
  })

  it('MUTANT "curated only": the user row would be invisible again (the whole R3 bug)', () => {
    const wrong = curated
    expect(wrong.some(m => m.id === 'civitai-812345')).toBe(false)
    expect(allSdModels([user]).some(m => m.id === 'civitai-812345')).toBe(true)
  })

  it('MUTANT "no de-dup": a colliding id would list twice and the dropdown would show two', () => {
    const impostor = { ...user, id: 'sd15' }
    const wrong = [...curated, { id: impostor.id, name: impostor.name, kind: 'image' as const, family: impostor.family, files: impostor.files }]
    expect(wrong.filter(m => m.id === 'sd15')).toHaveLength(2)
    expect(allSdModels([impostor]).filter(m => m.id === 'sd15')).toHaveLength(1)
  })

  it('MUTANT "family dropped from the listing": the composer would be back to guessing', () => {
    const wrong = allSdModels([user]).map(({ id, name, kind, files }) => ({ id, name, kind, files }))
    expect('family' in wrong[0]).toBe(false)
    expect(allSdModels([user]).every(m => typeof m.family === 'string' && m.family.length > 0)).toBe(true)
  })
})

// A directory the registry never had to exist in — proves list() does not
// create anything as a side effect (a read must not touch the disk layout).
describe('reading never creates the file', () => {
  it('list() on a fresh path leaves the directory empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'tachi-usermodels-ro-'))
    dirs.push(d)
    mkdirSync(join(d, 'sub'))
    const s = new UserSdModelStore(join(d, 'sub', USER_SD_MODELS_FILENAME))
    expect(s.list()).toEqual([])
    expect(readdirSync(join(d, 'sub'))).toEqual([])
  })
})

// ── sd-cpp:remove-model drops BOTH halves ────────────────────────────────────
//
// The adapter sibling always removed weights AND registry row (its comment:
// leaving the row keeps a dead picker entry). The MODEL handler removed only
// weights until 2026-07-31 — a removed Civitai checkpoint left a phantom
// recipe row offering a re-install the user just declined. This is a
// source-text pin on the handler, the same style the wiring suites use: the
// call pair must survive refactors or fail loudly here.
describe('sd-cpp:remove-model removes the registry row too', () => {
  it('the handler calls removeSdModel AND removeUserSdModel', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'electron', 'ipc', 'sd-cpp.ipc.ts'), 'utf8')
    const handler = src.slice(src.indexOf("'sd-cpp:remove-model'"))
    const body = handler.slice(0, handler.indexOf('ipcMain.handle', 10))
    expect(body).toContain('removeSdModel(')
    expect(body).toContain('removeUserSdModel(')
  })

  it('removeUserSdModel is a safe no-op for curated ids (no registry row)', () => {
    expect(removeUserSdModel('sd-turbo')).toBe(false)
    expect(removeUserSdModel('wan22-ti2v-5b')).toBe(false)
  })
})
