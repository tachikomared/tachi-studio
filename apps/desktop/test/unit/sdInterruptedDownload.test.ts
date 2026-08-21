// apps/desktop/test/unit/sdInterruptedDownload.test.ts
//
// A DYING INSTALL MUST NOT LOOK LIKE ONE THAT NEVER STARTED.
//
// Driver finding (owner, live, rows5): the TI2V-5B install died mid-file TWICE
// on network flake (socket idle timeout, then getaddrinfo ENOTFOUND
// huggingface.co). Both times the progress line VANISHED and the button went
// back to the plain "↓ Wan 2.2 TI2V 5B · 6.3 GB" label — no error, no badge,
// nothing — while 5-6.5 GB of verified partials sat on disk.
//
// The resume plumbing was never the problem: a re-click skipped the completed
// components and appended to the `.part`, exactly as designed. What was missing
// was that NOTHING THE USER COULD SEE SURVIVED THE FAILURE. The only surface
// that knew was a transient `sd-cpp:install-progress` event, and a download that
// runs for an hour outlives the tab that subscribed to it — switch away from
// Media and the error is pushed to nobody, then the panel remounts with fresh
// state and re-renders the virgin label.
//
// So the fix is deliberately NOT a longer-lived event. The durable evidence is
// the bytes themselves: main reports what is on disk PER ROW through the catalog
// it already sends, and the row's state is derived from that. It survives a tab
// switch, an app restart, and a crash — none of which an event does.
//
// (Rebuilding the installer around the download-manager queue — which would also
// have surfaced this — is a known bigger item and deliberately not done here.)

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdpartial-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { sdModelOnDiskMb, modelComponentPaths } from '../../electron/services/sd-cpp-installer'
import { partPathFor } from '../../electron/services/model-storage'
import { SD_VIDEO_MODELS, sdCatalogFiles } from '../../electron/services/sd-cpp-models'
import { sdDownloadRowState, sdDownloadSize } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const ROW = 'wan22-ti2v-5b'          // the row the driver actually lost twice
const MiB = 1_048_576

/** Write `mb` MiB of nothing at `path`, creating its directory. */
function place(path: string, mb: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(Math.round(mb * MiB)))
}

beforeEach(() => {
  const paths = modelComponentPaths(ROW)!
  for (const p of Object.values(paths)) {
    try { rmSync(p, { force: true }) } catch { /* */ }
    try { rmSync(partPathFor(p), { force: true }) } catch { /* */ }
  }
})

afterAll(() => { try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* */ } })

// ── 1. main can see the bytes ────────────────────────────────────────────────

describe('sdModelOnDiskMb — what this row already has', () => {
  it('is empty for a row nothing was ever downloaded for', () => {
    expect(sdModelOnDiskMb(ROW)).toEqual({})
  })

  it('counts a COMPLETED component', () => {
    const paths = modelComponentPaths(ROW)!
    place(paths.vae!, 3)
    expect(sdModelOnDiskMb(ROW)).toEqual({ vae: 3 })
  })

  it('counts a `.part` — the interrupted file the next click resumes', () => {
    const paths = modelComponentPaths(ROW)!
    place(partPathFor(paths.diffusion!), 7)
    expect(sdModelOnDiskMb(ROW)).toEqual({ diffusion: 7 })
  })

  it('prefers the LANDED file over a stale `.part` of the same role', () => {
    const paths = modelComponentPaths(ROW)!
    place(paths.vae!, 5)
    place(partPathFor(paths.vae!), 1)
    expect(sdModelOnDiskMb(ROW).vae).toBe(5)
  })

  it('reports each role separately — a half-done install is a MIX', () => {
    const paths = modelComponentPaths(ROW)!
    place(paths.vae!, 4)
    place(partPathFor(paths.diffusion!), 6)
    const disk = sdModelOnDiskMb(ROW)
    expect(disk.vae).toBe(4)
    expect(disk.diffusion).toBe(6)
  })

  it('answers {} for an unknown id instead of throwing', () => {
    expect(sdModelOnDiskMb('no-such-model')).toEqual({})
  })
})

// ── 2. the wire that carries it to the panel ─────────────────────────────────

describe('sd-cpp:catalog sends the per-row disk state', () => {
  const ipc = read('electron/ipc/sd-cpp.ipc.ts')

  it('imports the reader', () => {
    expect(ipc).toContain('sdModelOnDiskMb')
  })

  it('stamps it onto BOTH curated lists, or one kind stays blind', () => {
    expect((ipc.match(/files:\s*sdCatalogFiles\(m\)/g) ?? []).length).toBe(2)
    expect((ipc.match(/onDiskMb/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('the renderer type declares it, so tsc can see it', () => {
    expect(read('src/types/electron.d.ts')).toMatch(/onDiskMb[?]?:\s*number/)
  })

  it('MediaPage keeps the field when it maps the catalog rows', () => {
    expect(read('src/pages/media/MediaPage.tsx')).toMatch(/onDiskMb:\s*f\.onDiskMb/)
  })
})

// ── 3. the state the row renders in ──────────────────────────────────────────

describe('sdDownloadRowState — a third state, because there are three', () => {
  it('installed still wins over everything', () => {
    expect(sdDownloadRowState(ROW, [ROW], 5000)).toBe('installed')
  })

  it('bytes on disk and not installed = RESUME, not a fresh download', () => {
    expect(sdDownloadRowState(ROW, [], 5151)).toBe('resume')
  })

  it('nothing on disk is still a plain download', () => {
    expect(sdDownloadRowState(ROW, [], 0)).toBe('download')
    expect(sdDownloadRowState(ROW, [])).toBe('download')
  })

  it('ignores a bogus figure rather than inventing an interrupted install', () => {
    expect(sdDownloadRowState(ROW, [], -1)).toBe('download')
    expect(sdDownloadRowState(ROW, [], Number.NaN)).toBe('download')
  })
})

// ── 4. what the interrupted row SAYS ─────────────────────────────────────────

describe('the resume label', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('MediaPage renders a resume branch at all', () => {
    expect(page).toContain('local.modelItemResume')
    expect(page).toMatch(/=== 'resume'/)
  })

  it('feeds the row state its own on-disk figure (the whole point)', () => {
    expect(page).toMatch(/sdDownloadRowState\(m\.id, \w+, [\w.]+\)/)
  })

  it('quotes the REMAINING transfer, not the full price', () => {
    const at = page.indexOf('local.modelItemResume')
    const call = page.slice(at, at + 320)
    expect(call).toMatch(/incrementalMb/)
    expect(call).toMatch(/onDiskMb/)
  })

  it('ships in every locale with all four placeholders intact', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/media.json')) as { local: Record<string, string> })
      .local.modelItemResume
    expect(en).toBeTruthy()
    for (const l of LOCALES) {
      const v = (JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as { local: Record<string, string> })
        .local.modelItemResume
      expect(v, `${l}/media.json local.modelItemResume`).toBeTruthy()
      for (const ph of ['{{name}}', '{{size}}', '{{done}}', '{{total}}']) {
        expect(v, `${l} lost ${ph}`).toContain(ph)
      }
      if (l !== 'en') expect(v, `${l} is still the English string`).not.toBe(en)
    }
  })

  it('says the download was INTERRUPTED — a bare smaller number reads like a different file', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/media.json')) as { local: Record<string, string> })
      .local.modelItemResume
    expect(en).toMatch(/interrupt|resume/i)
  })
})

// ── 5. the failure is surfaced while someone IS looking ──────────────────────

describe('a failed model download reaches the user', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('the progress handler still toasts the error', () => {
    const at = page.indexOf("p.stage === 'error'")
    expect(at).toBeGreaterThan(-1)
    expect(page.slice(at, at + 200)).toContain('showToast')
  })

  it('…and RE-READS the disk, so the row flips to resume instead of reverting', () => {
    const at = page.indexOf("p.stage === 'error'")
    expect(page.slice(at, at + 200)).toMatch(/refresh\(\)/)
  })

  it('the download click no longer swallows an { ok:false } result', () => {
    // `sd-cpp:download-model` RESOLVES with { ok:false, error } — it never
    // throws — so a bare `.catch(() => {})` discarded every failure that came
    // back through the promise rather than the event.
    expect(page).not.toMatch(/sdCpp\.downloadModel\([^)]*\)\.catch\(\(\) => \{\}\)/)
    expect(page).toMatch(/downloadSdRow/)
  })
})

// ── 6. the arithmetic, end to end on the row that lost it ────────────────────

describe('the TI2V-5B row the driver lost twice', () => {
  // THE EXACT SCREEN. The driver already owned a Wan 2.1 row, so the shared
  // discount was ALREADY working: 12.0 GB total − the 5.6 GB umt5 encoder =
  // the "6.3 GB" on the button. What it still ignored was the row's OWN 5.1 GB
  // diffusion.gguf, which had completed before the next component died.
  //
  // The disk map is data here, as main now sends it. Section 1 proves
  // sdModelOnDiskMb builds exactly this shape from real files; writing the
  // actual 5.1 GB would prove nothing more and cost the volume 5 GB.
  const DISK: Record<string, number> = { diffusion: 5151 }
  const WAN21 = 'wan21-t2v-1.3b'
  const gb = (mb: number) => (mb / 1024).toFixed(1)
  const row = () => SD_VIDEO_MODELS.find(m => m.id === ROW)!
  const rows = (disk: Record<string, number>) =>
    sdCatalogFiles(row(), []).map(f => ({ ...f, onDiskMb: disk[f.role] ?? 0 }))

  it('the row really is the shape this test assumes', () => {
    // Pins DISK + the numbers below against the registry: a renamed role or a
    // re-quantised file would otherwise leave the test passing and measuring
    // nothing.
    const f = row().files
    expect(f.map(x => x.role).sort()).toEqual(['diffusion', 't5xxl', 'vae'])
    expect(f.find(x => x.role === 'diffusion')!.sizeMb).toBe(5151)
    expect(f.find(x => x.role === 'vae')!.sizeMb).toBe(1345)
    expect(f.find(x => x.role === 't5xxl')!.sizeMb).toBe(5764)
    // …and the prose on the card says the same two numbers.
    expect(row().notes).toContain('~12 GB')
    expect(row().notes).toContain('6.3 GB')
  })

  it('reproduces the 6.3 GB the button promised (shared discount only)', () => {
    const before = sdDownloadSize({ files: rows({}), installedIds: [WAN21] })
    expect(gb(before.totalMb)).toBe('12.0')
    expect(before.savedMb).toBe(5764)
    expect(gb(before.incrementalMb)).toBe('6.3')   // ← what was on screen
    expect(before.onDiskMb).toBe(0)
  })

  it('…and drops it to the vae once the row\'s own diffusion is counted', () => {
    const after = sdDownloadSize({ files: rows(DISK), installedIds: [WAN21] })
    expect(after.savedMb).toBe(5764)               // the shared discount survives
    expect(after.onDiskMb).toBe(5151)              // …plus this row's own bytes
    expect(after.incrementalMb).toBe(1345)         // only the 2.2 vae is left
    expect(gb(after.incrementalMb)).toBe('1.3')
    expect(after.incrementalMb + after.savedMb + after.onDiskMb).toBe(after.totalMb)
  })

  it('and the row stops pretending it was never started', () => {
    const after = sdDownloadSize({ files: rows(DISK), installedIds: [WAN21] })
    expect(sdDownloadRowState(ROW, [WAN21], after.onDiskMb)).toBe('resume')
    // The row is NOT installed — the vae is still missing — so it must not read
    // as done either. Three states, and this is the middle one.
    expect(sdDownloadRowState(ROW, [WAN21], after.onDiskMb)).not.toBe('installed')
  })
})
