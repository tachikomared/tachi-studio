// apps/desktop/test/unit/mediaFirstRunFunnel.test.ts
//
// THE FIRST MEDIA SCREEN WAS A PAYWALL WITH A FREE ENGINE ONE CHIP AWAY.
//
// On a profile with no keys, the Media tab's model picker reads "No models — add
// a Surplus key and fund USDC." The LOCAL chip one inch above runs sd.cpp on the
// user's own GPU for nothing, and nothing on the screen said so. The same class
// of sentence arrives from MAIN when a cloud GENERATE fails (requireKey /
// toFriendlyError in surplus-media-service). Four findings, one funnel:
//
//  1. THE DEAD END HAD NO DOOR. Neither the empty catalog nor a key/funding
//     failure offered the free route.
//  2. THE FREE ROUTE WAS THREE UNDISCOVERABLE BUTTONS. Install an engine nobody
//     has heard of, choose one of eight checkpoints and pay ~5 GB for it, then
//     find out the composer wants a prompt. Each button only appears once the
//     previous one has been pressed.
//  3. THE ENGINE BUTTON QUOTED NO PRICE. "Install sd.cpp (one-time)" is 883 MB
//     on a Windows machine with an NVIDIA card (the CUDA build plus its separate
//     cudart archive) and 23 MB on the same machine without one. RIFE's button
//     has said its 431 MB since it shipped; these two never did.
//  4. THE COPY POINTED THE WRONG WAY. "Install sd.cpp below, then download a
//     model" — the install control is ABOVE the model picker that renders the
//     sentence (and has been since the panel moved), in all eight languages.
//  + THE FAST PATH WAS NEVER MENTIONED WHEN IT MATTERED. A 27-minute local video
//     render on a row whose 4-step pack is not installed spends 10x the sampling
//     passes it needs to; the pack row is in a panel the user is not looking at.
//
// Everything here is a pure function or a data pin — no DOM, no electron.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  canOfferLocalSwitch, isCloudKeyOrFundingFailure, shouldOfferLocalSwitchOnFailure,
  FIRST_IMAGE_STARTER_ID, firstImagePlan, shouldOfferFirstImage, firstImageSeedPrompt,
  firstImageReadyToGenerate,
  ENGINE_ARCHIVE_BYTES, engineDownloadQuoteMb,
  SPEED_PACK_STEPS, shouldPitchSpeedPack, speedPackPitch,
  type FirstImageStep,
} from '../../src/pages/media/MediaPage'
import { SD_CPP_RELEASES } from '../../electron/services/sd-cpp-models'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const media = (l: string) => JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as {
  local:  Record<string, string> & { sdCpp: Record<string, string>; piper: Record<string, string> }
  models: { error: Record<string, string> }
  firstRun: Record<string, string> & { step: Record<string, string>; error: Record<string, string> }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DOOR OUT OF THE DEAD END
// ─────────────────────────────────────────────────────────────────────────────

describe('finding 1 — a key/funding dead end offers the free local route', () => {
  it('offers the switch only from a cloud provider, and only where local can serve', () => {
    // sd.cpp covers image/video, piper+kokoro cover tts. Music and STT have no
    // local engine at all, so a button promising one there would be a lie.
    expect(canOfferLocalSwitch('surplus', 'image')).toBe(true)
    expect(canOfferLocalSwitch('surplus', 'video')).toBe(true)
    expect(canOfferLocalSwitch('surplus', 'tts')).toBe(true)
    expect(canOfferLocalSwitch('surplus', 'music')).toBe(false)
    expect(canOfferLocalSwitch('surplus', 'stt')).toBe(false)
    expect(canOfferLocalSwitch('venice', 'image')).toBe(true)
    expect(canOfferLocalSwitch('imgnai', 'video')).toBe(true)
    // Already there — nothing to switch to.
    expect(canOfferLocalSwitch('local', 'image')).toBe(false)
  })

  it('THE REPRO: main\'s own key/funding sentences are recognised', () => {
    // Read from the source rather than retyped, so a reword fails HERE instead
    // of silently removing the button from the failure row.
    const svc = read('electron/services/surplus-media-service.ts')
    const noKey = 'No Surplus key configured. Add a key and fund USDC in Settings → Surplus (link: /buy).'
    expect(svc).toContain(noKey)
    expect(svc).toContain('Payment required (402) — insufficient funds.')
    expect(svc).toContain('Fund USDC on Surplus to continue.')
    expect(svc).toMatch(/Surplus auth failed \(\$\{res\.status\}\)\. Check your key\./)

    expect(isCloudKeyOrFundingFailure(noKey)).toBe(true)
    expect(isCloudKeyOrFundingFailure('Payment required (402) — insufficient funds. Fund USDC on Surplus to continue.')).toBe(true)
    expect(isCloudKeyOrFundingFailure('Surplus auth failed (401). Check your key. bad token')).toBe(true)

    // …and Venice's equivalent, from its own service.
    const venice = read('electron/services/venice-media-service.ts')
    const noVenice = 'No Venice key configured — add one in Settings → Venice.'
    expect(venice).toContain(noVenice)
    expect(isCloudKeyOrFundingFailure(noVenice)).toBe(true)
  })

  it('stays quiet for failures switching provider would not fix', () => {
    expect(isCloudKeyOrFundingFailure('Surplus media HTTP 500: upstream exploded')).toBe(false)
    expect(isCloudKeyOrFundingFailure('sd-cli exited with code 3 (out of memory)')).toBe(false)
    expect(isCloudKeyOrFundingFailure('sd-cli was stopped before it finished.')).toBe(false)
    expect(isCloudKeyOrFundingFailure('Timed out after 5 min — generate again to re-poll.')).toBe(false)
    expect(isCloudKeyOrFundingFailure('')).toBe(false)
    expect(isCloudKeyOrFundingFailure(null)).toBe(false)
    expect(isCloudKeyOrFundingFailure(undefined)).toBe(false)
  })

  it('both halves must agree before the run-failure button renders', () => {
    const message = 'No Surplus key configured. Add a key and fund USDC in Settings → Surplus (link: /buy).'
    expect(shouldOfferLocalSwitchOnFailure({ provider: 'surplus', modality: 'image', message })).toBe(true)
    // Right message, no local engine for the modality.
    expect(shouldOfferLocalSwitchOnFailure({ provider: 'surplus', modality: 'music', message })).toBe(false)
    // Right modality, a failure that has nothing to do with money.
    expect(shouldOfferLocalSwitchOnFailure({ provider: 'surplus', modality: 'image', message: 'HTTP 500' })).toBe(false)
    // No settled failure at all.
    expect(shouldOfferLocalSwitchOnFailure({ provider: 'surplus', modality: 'image', message: null })).toBe(false)
  })

  it('is wired at BOTH surfaces — the empty picker and the settled failure row', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    // The empty-catalog door is decided STRUCTURALLY. Matching the picker's
    // sentence would work in English and fail in the other seven languages,
    // because that sentence is one of our own translations.
    expect(page).toMatch(/offerLocalSwitchForCatalog\s*=\s*canOfferLocalSwitch\(mediaProvider, modality\)/)
    expect(page).toMatch(/offerLocalSwitchForRun\s*=\s*shouldOfferLocalSwitchOnFailure\(/)
    expect(page).toMatch(/\{offerLocalSwitchForCatalog && \(/)
    expect(page).toMatch(/\{offerLocalSwitchForRun && \(/)
    // Switching drops the stale cloud failure with it: a red row about a Surplus
    // key under a LOCAL composer is the staleness the route echo exists to stop.
    expect(page).toMatch(/const switchToLocal = useCallback\(\(\) => \{\s*\n\s*setMediaProvider\('local'\)\s*\n\s*clearRunError\(\)/)
  })

  it('ships the door\'s label in every locale, and never as the English string', () => {
    const en = media('en')
    expect(en.local.switchToLocal).toBeTruthy()
    for (const l of LOCALES) {
      const j = media(l)
      expect(j.local.switchToLocal, `${l} local.switchToLocal`).toBeTruthy()
      expect(j.local.switchToLocalTitle, `${l} local.switchToLocalTitle`).toBeTruthy()
      expect(j.local.switchedToast, `${l} local.switchedToast`).toBeTruthy()
      if (l !== 'en') {
        expect(j.local.switchToLocal, `${l} is still English`).not.toBe(en.local.switchToLocal)
        expect(j.local.switchToLocalTitle, `${l} is still English`).not.toBe(en.local.switchToLocalTitle)
      }
    }
  })

  it('the picker\'s own no-key sentence now names the free alternative', () => {
    // The English one is asserted verbatim; every locale must at least have
    // grown (the old sentence stopped at "fund USDC").
    expect(media('en').models.error.noSurplus).toMatch(/local engine/i)
    for (const l of LOCALES) {
      expect(media(l).models.error.noSurplus.length, `${l} noSurplus`).toBeGreaterThan(45)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ZERO-CONFIG CHAIN
// ─────────────────────────────────────────────────────────────────────────────

describe('finding 2 — one click from nothing installed to a first image', () => {
  const base = {
    provider: 'local' as const,
    modality: 'image' as const,
    sdInstalled: false,
    installedImageModelCount: 0,
    loadingModels: false,
    busy: false,
    chainInPlay: false,
  }

  it('THE VISIBILITY MATRIX', () => {
    // The two states that ARE the dead end.
    expect(shouldOfferFirstImage(base)).toBe(true)                                       // no engine
    expect(shouldOfferFirstImage({ ...base, sdInstalled: true })).toBe(true)             // engine, no weights

    // Nothing left to offer: engine + at least one image checkpoint on disk.
    expect(shouldOfferFirstImage({ ...base, sdInstalled: true, installedImageModelCount: 1 })).toBe(false)

    // Wrong route / wrong modality — the button promises an IMAGE, so it lives
    // where Generate makes one.
    expect(shouldOfferFirstImage({ ...base, provider: 'surplus' })).toBe(false)
    expect(shouldOfferFirstImage({ ...base, provider: 'venice' })).toBe(false)
    expect(shouldOfferFirstImage({ ...base, modality: 'video' })).toBe(false)
    expect(shouldOfferFirstImage({ ...base, modality: 'tts' })).toBe(false)

    // Never beside work in flight, and never while the model list — the very
    // evidence this reads — is still loading.
    expect(shouldOfferFirstImage({ ...base, busy: true })).toBe(false)
    expect(shouldOfferFirstImage({ ...base, loadingModels: true })).toBe(false)
    // A chain in play owns this surface — running OR stopped with a resume on
    // screen. Otherwise the failure row and the CTA offer the same journey side
    // by side, and the CTA's price is the wrong one after a part-download.
    expect(shouldOfferFirstImage({ ...base, chainInPlay: true })).toBe(false)
  })

  it('plans the whole journey on a virgin machine', () => {
    expect(firstImagePlan({ sdInstalled: false, starterInstalled: false }))
      .toEqual<FirstImageStep[]>(['engine', 'weights', 'generate'])
  })

  it('THE RESUME: a plan re-derived after a failure skips what already landed', () => {
    // The engine install succeeded and the 5 GB download died. The next click
    // reads DISK, so it must not offer to install the engine again — and the
    // download itself resumes from the `.part` bytes main already has.
    expect(firstImagePlan({ sdInstalled: true, starterInstalled: false }))
      .toEqual<FirstImageStep[]>(['weights', 'generate'])
    // Both legs landed, only the render is owed (the 'notReady' retry path).
    expect(firstImagePlan({ sdInstalled: true, starterInstalled: true }))
      .toEqual<FirstImageStep[]>(['generate'])
    // Weights present without the engine is a real state (a Catalog-tab
    // download, or a removed binary) and it must not re-download 5 GB.
    expect(firstImagePlan({ sdInstalled: false, starterInstalled: true }))
      .toEqual<FirstImageStep[]>(['engine', 'generate'])
  })

  it('the plan is DERIVED FROM DISK at every click, never stored', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    // sd-cpp:status is the source — this is what makes a failure resumable at
    // no cost and a mid-chain tab switch free.
    expect(page).toMatch(/const s = await window\.tachi\.sdCpp\.status\(\)\s*\n\s*plan = firstImagePlan\(\{/)
    expect(page).toMatch(/starterInstalled: s\.models\.some\(m => m\.id === FIRST_IMAGE_STARTER_ID\)/)
    // Each leg reuses the SAME function its own button uses, so the inline error
    // row, the toast and the row's RESUME state are what a manual click gives.
    expect(page).toMatch(/const res = await installEngine\('sdcpp'\)/)
    expect(page).toMatch(/const res = await downloadSdRow\(FIRST_IMAGE_STARTER_ID/)
    // …which means both of those must hand back a verdict rather than swallow it.
    expect(page).toMatch(/const installEngine = useCallback\(async \(engine: 'sdcpp' \| 'piper'\): Promise<\{ ok: boolean; error\?: string \}>/)
    expect(page).toMatch(/const downloadSdRow = useCallback\(async \([^)]*\): Promise<\{ ok: boolean; error\?: string \}>/)
  })

  it('every leg\'s failure is rendered with a resume, not swallowed', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/failAt\(plan, step, res\.error \?\? ''\)/)
    expect(page).toMatch(/\{chain\?\.failed && chainPosition && \(/)
    expect(page).toMatch(/firstRun\.failedTitle/)
    expect(page).toMatch(/onClick=\{\(\) => \{ void runFirstImage\(\) \}\}[\s\S]{0,120}firstRun\.resume/)
    // Even the plan step itself — a status IPC that throws is a first leg that
    // failed, not a click that did nothing.
    expect(page).toMatch(/failAt\(\['engine', 'weights', 'generate'\], 'engine'/)
  })

  it('the starter row really is the curated "first try", by id', () => {
    const rows = read('electron/services/sd-cpp-models.ts')
    expect(FIRST_IMAGE_STARTER_ID).toBe('sd-turbo')
    expect(rows).toMatch(/id: 'sd-turbo', name: 'SD-Turbo \(fast — recommended first try\)'/)
    // 1 step is why this row can be handed to someone who has set nothing up.
    expect(rows).toMatch(/id: 'sd-turbo'[\s\S]{0,200}?steps: 1,/)
  })

  it('never overwrites a prompt the user already typed', () => {
    expect(firstImageSeedPrompt('a cat on a bike', 'PRESET')).toBe('a cat on a bike')
    expect(firstImageSeedPrompt('   spaced   ', 'PRESET')).toBe('spaced')
    expect(firstImageSeedPrompt('', 'PRESET')).toBe('PRESET')
    expect(firstImageSeedPrompt('   ', 'PRESET')).toBe('PRESET')
    expect(firstImageSeedPrompt(undefined, 'PRESET')).toBe('PRESET')
    expect(firstImageSeedPrompt(42, 'PRESET')).toBe('PRESET')
  })

  it('the last leg WAITS for the composer instead of guessing a delay', () => {
    const ready = {
      provider: 'local' as const,
      model: FIRST_IMAGE_STARTER_ID, starterId: FIRST_IMAGE_STARTER_ID,
      schemaCount: 6, promptKey: 'prompt', busy: false,
    }
    expect(firstImageReadyToGenerate(ready)).toBe(true)
    // The weights landing does not make it ready: the list reloads, the model is
    // re-pointed, and the param schema arrives last.
    expect(firstImageReadyToGenerate({ ...ready, model: '' })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, model: 'sd15' })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, schemaCount: 0 })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, promptKey: null })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, busy: true })).toBe(false)
  })

  it('NEVER fires the handoff on a cloud route', () => {
    // The hazard: the chain keeps running while a 5 GB download finishes, the
    // user clicks the SURPLUS chip, and the handoff spends money on a route they
    // never asked for. Leaving `local` abandons the last leg instead.
    const ready = {
      model: FIRST_IMAGE_STARTER_ID, starterId: FIRST_IMAGE_STARTER_ID,
      schemaCount: 6, promptKey: 'prompt', busy: false,
    }
    expect(firstImageReadyToGenerate({ ...ready, provider: 'surplus' })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, provider: 'venice' })).toBe(false)
    expect(firstImageReadyToGenerate({ ...ready, provider: 'imgnai' })).toBe(false)
    // …and the effect really does read the live chip.
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/firstImageReadyToGenerate\(\{\s*\n\s*provider: mediaProvider,/)
  })

  it('ONE progress line for the whole journey, in the row that already existed', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    // The step counter frames the engine's own words; it does not replace them.
    expect(page).toMatch(/t\('firstRun\.progress', \{[\s\S]{0,200}line:\s*sdProgress \?\? progress \?\? t\('progress\.starting'\)/)
    // …and it renders where sdProgress always did (no new widget).
    expect(page).toMatch(/\{localProgressLine && <span/)
    expect(page).not.toMatch(/\{sdProgress && <span[^\n]*\n[\s\S]{0,40}<\/div>\s*\n\s*\)\}\s*\n\s*\n\s*\{\/\* Model picker/)
  })

  it('ships the CTA + every step label in all eight locales', () => {
    const en = media('en')
    for (const l of LOCALES) {
      const j = media(l)
      expect(j.firstRun.cta, `${l} firstRun.cta`).toContain('{{size}}')
      expect(j.firstRun.ctaNoSize, `${l} firstRun.ctaNoSize`).toBeTruthy()
      expect(j.firstRun.ctaHint, `${l} firstRun.ctaHint`).toBeTruthy()
      expect(j.firstRun.ctaTitle, `${l} firstRun.ctaTitle`).toContain('{{name}}')
      expect(j.firstRun.ctaTitle, `${l} firstRun.ctaTitle`).toContain('{{engine}}')
      for (const step of ['engine', 'weights', 'generate'] as const) {
        expect(j.firstRun.step[step], `${l} firstRun.step.${step}`).toBeTruthy()
      }
      for (const token of ['{{step}}', '{{total}}', '{{label}}', '{{line}}']) {
        expect(j.firstRun.progress, `${l} firstRun.progress ${token}`).toContain(token)
      }
      for (const token of ['{{step}}', '{{total}}', '{{label}}']) {
        expect(j.firstRun.failedTitle, `${l} firstRun.failedTitle ${token}`).toContain(token)
      }
      expect(j.firstRun.resume, `${l} firstRun.resume`).toBeTruthy()
      expect(j.firstRun.error.notReady, `${l} firstRun.error.notReady`).toBeTruthy()
      if (l !== 'en') {
        expect(j.firstRun.ctaHint, `${l} is still English`).not.toBe(en.firstRun.ctaHint)
        expect(j.firstRun.step.engine, `${l} is still English`).not.toBe(en.firstRun.step.engine)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE PRICE ON THE ENGINE BUTTON
// ─────────────────────────────────────────────────────────────────────────────

describe('finding 3 — the engine install quotes what it will transfer', () => {
  // The rows as main ships them on `sd-cpp:catalog` / `piper:catalog`.
  // DERIVED from the shipped registry, not transcribed from it. These filenames
  // carry the engine tag's short hash, so every one of them changes on every
  // SD_CPP_VERSION bump — and the failure they guard against is SILENT (the
  // quote loop skips a row whose archive is unmeasured, so a stale name removes
  // the price from the button instead of breaking it). Copying the names here
  // meant a bump had to remember three places; deriving them means two, and the
  // cross-check below still proves the remaining two agree.
  const sdRow = (platform: string) => {
    const r = SD_CPP_RELEASES.find(x => x.platform === platform)
    if (!r) throw new Error(`no shipped release row for ${platform}`)
    return {
      platform,
      filename: r.filename,
      ...(r.cudartFilename ? { cudartFilename: r.cudartFilename } : {}),
    }
  }
  const SD_ROWS = [sdRow('win-cuda'), sdRow('win-cpu'), sdRow('mac-arm64')]
  const PIPER_ROWS = [
    { platform: 'win',       filename: 'piper_windows_amd64.zip' },
    { platform: 'mac-arm64', filename: 'piper_macos_aarch64.tar.gz' },
    { platform: 'mac-x64',   filename: 'piper_macos_x64.tar.gz' },
  ]

  it('THE REPRO: 23 MB and 883 MB wore the same label on Windows', () => {
    const q = engineDownloadQuoteMb(SD_ROWS, false)
    expect(q).not.toBeNull()
    // CPU build alone vs the CUDA build PLUS its separate cudart archive.
    expect(q!.minMb).toBe(23)
    expect(q!.maxMb).toBe(883)
  })

  it('collapses to one number where the platform has one build', () => {
    const q = engineDownloadQuoteMb(SD_ROWS, true)
    expect(q).toEqual({ minMb: 47, maxMb: 47 })
    // Both mac piper archives are the same size to within 30 bytes.
    expect(engineDownloadQuoteMb(PIPER_ROWS, true)).toEqual({ minMb: 18, maxMb: 18 })
    expect(engineDownloadQuoteMb(PIPER_ROWS, false)).toEqual({ minMb: 21, maxMb: 21 })
  })

  it('a pin bump silently drops the quote rather than lying', () => {
    // The whole reason the table is keyed by FILENAME: a bumped asset has never
    // been measured, so it contributes nothing and the button keeps its plain
    // label (the render falls back to local.sdCpp.install).
    expect(engineDownloadQuoteMb([{ platform: 'win-cpu', filename: 'sd-master-FUTURE-bin-win-cpu-x64.zip' }], false)).toBeNull()
    // …and half a price is a wrong price: a CUDA row whose companion archive is
    // unmeasured is skipped whole, never quoted at the main archive alone.
    const q = engineDownloadQuoteMb([
      { platform: 'win-cuda', filename: sdRow('win-cuda').filename, cudartFilename: 'cudart-NEXT.zip' },
    ], false)
    expect(q).toBeNull()
  })

  it('survives every shape a stale or empty payload can take', () => {
    expect(engineDownloadQuoteMb(undefined, false)).toBeNull()
    expect(engineDownloadQuoteMb(null, false)).toBeNull()
    expect(engineDownloadQuoteMb([], false)).toBeNull()
    expect(engineDownloadQuoteMb('nonsense', false)).toBeNull()
    expect(engineDownloadQuoteMb([null, {}, { platform: 5, filename: 7 }], false)).toBeNull()
    // A linux row (not shipped today) belongs to neither platform bucket.
    expect(engineDownloadQuoteMb([{ platform: 'linux-x64', filename: 'piper_windows_amd64.zip' }], false)).toBeNull()
  })

  it('every measured filename is one the app actually pins', () => {
    // The table is worthless the moment it names an asset no registry requests,
    // so both registries are read and every key must appear in one of them.
    const sd = read('electron/services/sd-cpp-models.ts')
    const piper = read('electron/services/piper-models.ts')
    for (const filename of Object.keys(ENGINE_ARCHIVE_BYTES)) {
      expect(sd.includes(filename) || piper.includes(filename), `${filename} is not pinned by any registry`).toBe(true)
    }
    // …and the other direction: every release row's archive is measured, or the
    // quote would silently narrow. Both files declare their assets inline.
    for (const m of sd.matchAll(/filename:\s*'([^']+\.zip)'/g)) {
      expect(ENGINE_ARCHIVE_BYTES[m[1]], `unmeasured sd asset ${m[1]}`).toBeGreaterThan(0)
    }
    for (const m of piper.matchAll(/filename:\s*'([^']+\.(?:zip|tar\.gz))'/g)) {
      expect(ENGINE_ARCHIVE_BYTES[m[1]], `unmeasured piper asset ${m[1]}`).toBeGreaterThan(0)
    }
  })

  it('is wired onto both install buttons, from the payload main already sent', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/setSdReleases\(Array\.isArray\(c\.releases\) \? c\.releases : \[\]\)/)
    expect(page).toMatch(/setPiperReleases\(Array\.isArray\(pc\.releases\) \? pc\.releases : \[\]\)/)
    expect(page).toMatch(/local\.sdCpp\.installSized/)
    expect(page).toMatch(/local\.piper\.installSized/)
    // No quote ⇒ the old label, never a fabricated number.
    expect(page).toMatch(/sdEngineQuote\s*\n?\s*\?\s*t\('local\.sdCpp\.installSized'[\s\S]{0,80}: t\('local\.sdCpp\.install'\)/)
  })

  it('ships the size labels in every locale', () => {
    for (const l of LOCALES) {
      const j = media(l)
      expect(j.local.engineSizeOne, `${l} local.engineSizeOne`).toContain('{{size}}')
      expect(j.local.engineSizeRange, `${l} local.engineSizeRange`).toContain('{{min}}')
      expect(j.local.engineSizeRange, `${l} local.engineSizeRange`).toContain('{{max}}')
      expect(j.local.engineSizeRangeTitle, `${l} local.engineSizeRangeTitle`).toBeTruthy()
      expect(j.local.sdCpp.installSized, `${l} local.sdCpp.installSized`).toContain('{{size}}')
      expect(j.local.piper.installSized, `${l} local.piper.installSized`).toContain('{{size}}')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE COPY THAT POINTED THE WRONG WAY
// ─────────────────────────────────────────────────────────────────────────────

describe('finding 4 — "install sd.cpp below" when the control is above', () => {
  // The direction word each locale ALREADY uses for this same panel, taken from
  // models.error.installKokoro (which has always pointed UP) — and the word it
  // used for the wrong direction. Both are asserted against the shipped file, so
  // the map cannot drift into a bare claim.
  const DIRECTION: Record<string, { up: string; down: string }> = {
    en: { up: 'above',      down: 'below' },
    ru: { up: 'выше',       down: 'ниже' },
    es: { up: 'arriba',     down: 'abajo' },
    fr: { up: 'ci-dessus',  down: 'ci-dessous' },
    de: { up: 'oben',       down: 'unten' },
    zh: { up: '上方',        down: '下面' },
    ja: { up: '上の',        down: '下の' },
    ko: { up: '위에서',      down: '아래' },
  }

  const POINTERS = ['installSdCpp', 'installPiper', 'noLocalModels', 'noLocalVoices'] as const

  it('the install/download controls really are ABOVE the picker that says so', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const panel  = page.indexOf("{/* Local sd.cpp engine (image/video) — install + per-model download */}")
    const picker = page.indexOf('{/* Model picker */}')
    expect(panel).toBeGreaterThan(0)
    expect(picker).toBeGreaterThan(panel)
  })

  it('THE REPRO: every locale pointed DOWN at a control that is UP', () => {
    for (const l of LOCALES) {
      const e = media(l).models.error
      const { up, down } = DIRECTION[l]
      // The map's UP token is the one this locale already uses for this panel.
      expect(e.installKokoro, `${l} installKokoro must contain ${up}`).toContain(up)
      for (const key of POINTERS) {
        expect(e[key], `${l} ${key} must point up`).toContain(up)
        expect(e[key], `${l} ${key} still points down`).not.toContain(down)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE SPEED PACK, PITCHED ONCE, AFTER THE SLOW RUN
// ─────────────────────────────────────────────────────────────────────────────

describe('the 4-step pack is offered once per row, when the wait is fresh', () => {
  const packs = [
    { modelId: 'wan21-i2v-14b-480p', installed: false },
    { modelId: 'wan22-i2v-a14b',     installed: true },
  ]

  it('offers only a row that HAS a pack and does NOT have it installed', () => {
    const pitched = new Set<string>()
    expect(shouldPitchSpeedPack({ modelId: 'wan21-i2v-14b-480p', packs, pitched })).toBe(true)
    expect(shouldPitchSpeedPack({ modelId: 'wan22-i2v-a14b', packs, pitched })).toBe(false)
    // A row with no pack at all (the 1.3B, blocked on licence) says nothing.
    expect(shouldPitchSpeedPack({ modelId: 'wan21-t2v-1.3b', packs, pitched })).toBe(false)
    expect(shouldPitchSpeedPack({ modelId: '', packs, pitched })).toBe(false)
  })

  it('ONCE PER ROW PER SESSION — a second telling is nagging', () => {
    const pitched = new Set<string>(['wan21-i2v-14b-480p'])
    expect(shouldPitchSpeedPack({ modelId: 'wan21-i2v-14b-480p', packs, pitched })).toBe(false)
    // …and it is per ROW, not global: another row still gets its one chance.
    const others = [{ modelId: 'wan22-t2v-a14b', installed: false }, ...packs]
    expect(shouldPitchSpeedPack({ modelId: 'wan22-t2v-a14b', packs: others, pitched })).toBe(true)
  })

  it('the ratio comes from the run that just happened, not from a guess', () => {
    // 40 sampled passes against the pack's 4 — the 10x the copy claims.
    expect(speedPackPitch({ runSteps: 40, incrementalMb: 706 })).toEqual({ sizeMb: 706, runSteps: 40, ratio: 10 })
    expect(speedPackPitch({ runSteps: 20, incrementalMb: 1300 })).toEqual({ sizeMb: 1300, runSteps: 20, ratio: 5 })
  })

  it('says nothing when there is nothing honest to claim', () => {
    // The engine reported no recipe (older main build / a route with no
    // `effective`) — the one chance to mention a 10x saving is not spent on a
    // sentence with a hole in it.
    expect(speedPackPitch({ runSteps: undefined, incrementalMb: 706 })).toBeNull()
    expect(speedPackPitch({ runSteps: NaN, incrementalMb: 706 })).toBeNull()
    expect(speedPackPitch({ runSteps: 0, incrementalMb: 706 })).toBeNull()
    // The run was already short. FLOORED, not rounded: 6 against 4 is a real
    // 1.5x, and "2× fewer" is a number this app would be printing at someone.
    expect(speedPackPitch({ runSteps: 4, incrementalMb: 706 })).toBeNull()
    expect(speedPackPitch({ runSteps: 6, incrementalMb: 706 })).toBeNull()
    expect(speedPackPitch({ runSteps: 7, incrementalMb: 706 })).toBeNull()
    expect(speedPackPitch({ runSteps: 8, incrementalMb: 706 })?.ratio).toBe(2)
    // …and a pack that would transfer nothing is not news.
    expect(speedPackPitch({ runSteps: 40, incrementalMb: 0 })).toBeNull()
  })

  it('THE PIN: every curated pack really is a 4-step distill', () => {
    // SPEED_PACK_STEPS is quoted AT THE USER ("the pack needs 4"), so it is
    // pinned against the registry rather than trusted.
    expect(SPEED_PACK_STEPS).toBe(4)
    const rows = read('electron/services/sd-cpp-models.ts')
    const adapters = rows.slice(rows.indexOf('export const SD_SPEED_ADAPTERS'))
    const presets = [...adapters.matchAll(/preset:\s*\{\s*\n?\s*steps:\s*(\d+)/g)].map(m => Number(m[1]))
    expect(presets.length).toBeGreaterThanOrEqual(3)
    for (const steps of presets) expect(steps).toBe(SPEED_PACK_STEPS)
  })

  it('fires on the LOCAL VIDEO success path, with the engine\'s own step count', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/pitchSpeedPackAfterRun\(model, r\.effective\?\.steps\)/)
    // The one-shot is spent only when a pitch is actually shown.
    expect(page).toMatch(/if \(!pitch\) return\s*\n\s*speedPackPitched\.add\(modelId\)/)
    // The INCREMENTAL size: the two packs share a byte-identical LoRA, so the
    // second one costs ~0.6 GB and quoting 1.3 would be the same over-quote the
    // download rows were fixed for.
    expect(page).toMatch(/speedPackPitch\(\{ runSteps, incrementalMb: dl\.incrementalMb \}\)/)
    // Session-scoped, not visit-scoped: the page unmounts on every tab switch.
    expect(page).toMatch(/const speedPackPitched = new Set<string>\(\)/)
  })

  it('ships the pitch in every locale, with all four numbers', () => {
    for (const l of LOCALES) {
      const s = media(l).local.speedPackPitch
      for (const token of ['{{name}}', '{{size}}', '{{steps}}', '{{ratio}}']) {
        expect(s, `${l} local.speedPackPitch ${token}`).toContain(token)
      }
    }
  })
})
