// apps/desktop/test/unit/sdDownloadDedupLabel.test.ts
//
// THE BUTTON MUST SAY WHAT THE DOWNLOAD WILL ACTUALLY COST.
//
// Driver finding (owner, live): the Wan I2V row's DOWNLOAD button read
// "17.6 GB" while its own hover tooltip said the transfer would be ~11.7 GB
// because two of the four components are already on disk — and the tooltip was
// right (the real transfer for the shared pair came out at ~1 MB). The
// pessimistic number is the one on screen; the honest one was hidden behind a
// hover nobody performs before deciding whether they can afford a download.
//
// The dedup is REAL, not a promise: sdComponentReuse.test.ts pins
// findReusableComponent (sha256 is the file's identity, the twin is re-hashed
// before it is placed) and `isSdModelInstalled` is true only when EVERY
// component of a row is on disk — so "a row that declares these exact bytes is
// installed" is sound evidence that these bytes are already here.
//
// What was missing was only the WIRE: `sd-cpp:catalog` handed the renderer
// `{ role, sizeMb }` per file and no identity, so the panel could not tell a
// shared component from a fresh one and had nothing to subtract. It now sends
// the OTHER rows that declare each file (`sharedWith`), which is the same
// question sdFilesWithSha already answered for the installer, and the renderer
// does the arithmetic in one pure function.
//
// NOTE ON PRECISION: this is a PREDICTION, exactly like the tooltip's. If the
// twin's bytes no longer hash to their declared sha the installer refuses the
// reuse and re-downloads — so the copy says "shares files with installed
// models", never "you will transfer exactly N".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SD_VIDEO_MODELS, sdCatalogFiles } from '../../electron/services/sd-cpp-models'
import { sdDownloadSize } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const I2V = 'wan21-i2v-14b-480p'
const T2V = 'wan21-t2v-1.3b'

const row = (id: string) => SD_VIDEO_MODELS.find(m => m.id === id)!
/** The catalog payload's file rows, with NO user registry (no electron in a unit test). */
const files = (id: string) => sdCatalogFiles(row(id), [])

// ── 1. the registry really does share these bytes ─────────────────────────────

describe('sdCatalogFiles — which rows declare the same file', () => {
  it('names the t2v row on exactly the two components they share', () => {
    const shared = files(I2V).filter(f => f.sharedWith.length > 0)
    expect(shared.map(f => f.role).sort()).toEqual(['t5xxl', 'vae'])
    for (const f of shared) expect(f.sharedWith).toContain(T2V)
  })

  it('does NOT name the row itself (that would be its own file, not reuse)', () => {
    for (const f of files(I2V)) expect(f.sharedWith).not.toContain(I2V)
  })

  it('leaves the exclusive components alone — the DiT and clip_vision are only here', () => {
    const exclusive = files(I2V).filter(f => f.sharedWith.length === 0)
    expect(exclusive.map(f => f.role).sort()).toEqual(['clip_vision', 'diffusion'])
  })

  it('carries the size across unchanged (the panel still needs the total)', () => {
    expect(files(I2V).reduce((a, f) => a + f.sizeMb, 0))
      .toBe(row(I2V).files.reduce((a, f) => a + f.sizeMb, 0))
  })
})

// ── 2. the arithmetic the label shows ─────────────────────────────────────────

describe('sdDownloadSize', () => {
  it('with nothing installed, the honest number IS the full one', () => {
    const s = sdDownloadSize({ files: files(I2V), installedIds: [] })
    expect(s.totalMb).toBe(18029)
    expect(s.incrementalMb).toBe(18029)
    expect(s.savedMb).toBe(0)
  })

  it('with the 1.3B Wan row installed, it drops to the DiT + clip_vision', () => {
    const s = sdDownloadSize({ files: files(I2V), installedIds: [T2V] })
    expect(s.incrementalMb).toBe(10816 + 1206)   // 12,022 MiB
    expect(s.savedMb).toBe(243 + 5764)           // 6,007 MiB — the umt5 encoder is 5.6 GB of it
    expect(s.incrementalMb + s.savedMb).toBe(s.totalMb)
  })

  it('reads 11.7 GB / saves 5.9 GB — the numbers the tooltip already promised', () => {
    const gb = (mb: number) => (mb / 1024).toFixed(1)
    const s = sdDownloadSize({ files: files(I2V), installedIds: [T2V] })
    expect(gb(s.totalMb)).toBe('17.6')
    expect(gb(s.incrementalMb)).toBe('11.7')
    expect(gb(s.savedMb)).toBe('5.9')
    // …and the row's own notes say the same thing in prose. If someone edits one
    // and not the other, the card contradicts itself again.
    expect(row(I2V).notes).toContain('17.6 GB')
    expect(row(I2V).notes).toContain('11.7 GB')
  })

  it('ignores an installed id that declares none of these files', () => {
    const s = sdDownloadSize({ files: files(I2V), installedIds: ['sd-turbo', 'civitai-812345'] })
    expect(s.incrementalMb).toBe(s.totalMb)
    expect(s.savedMb).toBe(0)
  })

  it('never claims a saving it cannot evidence (an older main build sends no sharedWith)', () => {
    // Defensive: a renderer running against a main process that predates the
    // field must fall back to the pessimistic number, not invent a discount.
    const legacy = files(I2V).map(f => ({ role: f.role, sizeMb: f.sizeMb }))
    const s = sdDownloadSize({ files: legacy, installedIds: [T2V] })
    expect(s.incrementalMb).toBe(s.totalMb)
    expect(s.savedMb).toBe(0)
  })

  it('an empty row is 0/0/0 rather than NaN', () => {
    expect(sdDownloadSize({ files: [], installedIds: [T2V] }))
      .toEqual({ totalMb: 0, incrementalMb: 0, savedMb: 0, onDiskMb: 0 })
  })
})

// ── 2b. …AND THE ROW'S OWN PARTIALS ──────────────────────────────────────────
//
// Driver finding (owner, live, rows5): the TI2V-5B install died twice on
// network flake with 5.1 GB of a completed diffusion.gguf already on disk, and
// the button still promised the full 6.3 GB. The discount above only ever
// crossed `sharedWith` against ANOTHER installed row — a row's own completed
// components and its own `.part` bytes, which the installer skips and resumes
// respectively, counted for nothing.
//
// They are the SAME kind of evidence as a shared file (bytes that will not
// travel), so they belong in the same subtraction — but they are a DIFFERENT
// fact about the row (this download was started and stopped), so they come back
// as their own field rather than being folded into `savedMb`: only one of the
// two justifies the word "resume".

describe('sdDownloadSize — the row\'s own bytes on disk', () => {
  /** The catalog rows plus a per-role on-disk figure, as main now sends them. */
  const withDisk = (id: string, onDisk: Partial<Record<string, number>>) =>
    files(id).map(f => ({ ...f, onDiskMb: onDisk[f.role] ?? 0 }))

  it('subtracts a COMPLETED component of this very row', () => {
    // The live case: diffusion landed, the rest did not.
    const s = sdDownloadSize({
      files: withDisk(I2V, { diffusion: 10816 }),
      installedIds: [],
    })
    expect(s.totalMb).toBe(18029)
    expect(s.onDiskMb).toBe(10816)
    expect(s.savedMb).toBe(0)                       // nothing is SHARED — this is our own file
    expect(s.incrementalMb).toBe(18029 - 10816)
  })

  it('subtracts a HALF-WRITTEN `.part` too — resume transfers only the remainder', () => {
    const s = sdDownloadSize({
      files: withDisk(I2V, { diffusion: 4000 }),
      installedIds: [],
    })
    expect(s.onDiskMb).toBe(4000)
    expect(s.incrementalMb).toBe(18029 - 4000)
  })

  it('adds up with the shared-file discount instead of fighting it', () => {
    // Both kinds of evidence at once: the 2.1 row is installed (vae + t5xxl are
    // free) AND this row's own diffusion already landed.
    const s = sdDownloadSize({
      files: withDisk(I2V, { diffusion: 10816 }),
      installedIds: [T2V],
    })
    expect(s.savedMb).toBe(243 + 5764)
    expect(s.onDiskMb).toBe(10816)
    expect(s.incrementalMb).toBe(1206)              // only clip_vision is left
    expect(s.incrementalMb + s.savedMb + s.onDiskMb).toBe(s.totalMb)
  })

  it('never double-counts a shared file that is ALSO already here', () => {
    // The installer hard-links the twin into this row's directory, so the file
    // is BOTH shared and on disk. Counting it twice would drive the label
    // negative — it is one set of bytes and it is subtracted once.
    const s = sdDownloadSize({
      files: withDisk(I2V, { vae: 243, t5xxl: 5764 }),
      installedIds: [T2V],
    })
    expect(s.savedMb).toBe(243 + 5764)
    expect(s.onDiskMb).toBe(0)                      // the shared discount already owns them
    expect(s.incrementalMb).toBe(10816 + 1206)
  })

  it('clamps a component that measures LARGER than the registry claims', () => {
    // `sizeMb` is the registry's rounded estimate; the real file can exceed it.
    // Without a clamp one fat component would make the whole row read negative.
    const s = sdDownloadSize({
      files: withDisk(I2V, { diffusion: 99_999 }),
      installedIds: [],
    })
    expect(s.onDiskMb).toBe(10816)
    expect(s.incrementalMb).toBe(18029 - 10816)
    expect(s.incrementalMb).toBeGreaterThanOrEqual(0)
  })

  it('a main build that sends no onDiskMb keeps the pessimistic number', () => {
    const s = sdDownloadSize({ files: files(I2V), installedIds: [] })
    expect(s.onDiskMb).toBe(0)
    expect(s.incrementalMb).toBe(s.totalMb)
  })
})

// ── 3. the wire that carries it ───────────────────────────────────────────────

describe('the field reaches the panel', () => {
  it('sd-cpp:catalog sends the file rows through sdCatalogFiles', () => {
    const ipc = read('electron/ipc/sd-cpp.ipc.ts')
    expect(ipc).toContain('sdCatalogFiles')
    // Both curated lists, or one of the two kinds silently keeps the old shape.
    expect((ipc.match(/files:\s*sdCatalogFiles\(m\)/g) ?? []).length).toBe(2)
  })

  it('the renderer type declares it, so tsc can see it', () => {
    expect(read('src/types/electron.d.ts')).toMatch(/sharedWith[?]?:\s*string\[\]/)
  })

  it('MediaPage keeps the files (it used to drop everything but the total)', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/setSdModels\(c\.models\.map\(mm => \(\{[^}]*files:/)
  })
})

// ── 4. what the user reads ────────────────────────────────────────────────────

describe('the download button label', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('uses the shared-files label only when there is something to subtract', () => {
    expect(page).toContain('local.modelItemShared')
    // The full-price label survives for every row that dedups nothing.
    expect(page).toContain('local.modelItem')
    expect(page).toMatch(/savedMb > 0/)
  })

  it('feeds it the INCREMENTAL number, not the total', () => {
    const at = page.indexOf('local.modelItemShared')
    const call = page.slice(at, at + 260)
    expect(call).toMatch(/incrementalMb/)
    expect(call).toMatch(/savedMb/)
  })

  it('ships the string in every locale, with all three placeholders intact', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/media.json')) as { local: Record<string, string> })
      .local.modelItemShared
    expect(en).toBeTruthy()
    for (const l of LOCALES) {
      const v = (JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as { local: Record<string, string> })
        .local.modelItemShared
      expect(v, `${l}/media.json local.modelItemShared`).toBeTruthy()
      for (const ph of ['{{name}}', '{{size}}', '{{saved}}']) {
        expect(v, `${l} lost ${ph}`).toContain(ph)
      }
      if (l !== 'en') expect(v, `${l} is still the English string`).not.toBe(en)
    }
  })

  it('says WHY it is cheaper — a bare smaller number reads like a different file', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/media.json')) as { local: Record<string, string> })
      .local.modelItemShared
    expect(en).toMatch(/shares?/i)
    expect(en).toMatch(/saves/i)
  })
})
