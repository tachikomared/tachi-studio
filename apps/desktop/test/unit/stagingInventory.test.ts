// apps/desktop/test/unit/stagingInventory.test.ts
//
// The guards on a feature whose whole job is to DELETE things.
//
// It exists because of one file found on the owner's machine on 2026-08-02: a
// 4.76 GB `.gguf.tmp` sitting in `llama-cpp/downloads/` since 2026-06-09, which
// no download task claimed, no resume could adopt, and no dashboard counted —
// on a system drive with 9.1 GB free. Reclaiming it is easy; reclaiming it
// WITHOUT ever eating a live download, a paused download's `.part`, or an
// extracted engine tree is the part that needs pinning.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// vi.hoisted, not a bare const: vi.mock factories are hoisted above these
// declarations, so a factory closing over a plain `const` reads it in its
// temporal dead zone.
const STATE = vi.hoisted(() => ({ userData: '', claimed: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => STATE.userData, isPackaged: false },
  BrowserWindow: class { static getAllWindows() { return [] } },
  ipcMain: { handle: () => {} },
}))

// The download manager owns the OTHER guard — the set of paths a task will
// still write to. Stubbed so a test can put a file under a live claim without
// standing up the whole manager.
vi.mock('../../electron/services/download-manager', () => ({
  claimedDownloadPaths: () => STATE.claimed,
}))

import {
  classifyStagingFile,
  scanStagingInventory,
  reclaimStaging,
  stagingDownloadDirs,
  STAGING_MIN_AGE_MS,
} from '../../electron/services/staging-inventory'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-02T21:00:00Z')

let root = ''

/** Write a file into `<userData>/<engine>/downloads/` (or a subdir of it). */
function put(rel: string, bytes: number, ageMs: number): string {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes))
  const t = new Date(NOW - ageMs)
  fs.utimesSync(p, t, t)
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))
  STATE.userData = root
  STATE.claimed = []
})
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* windows lock */ }
})

describe('classification is read off the file, and most things are not offered', () => {
  it('names the two kinds', () => {
    expect(classifyStagingFile('a.gguf.tmp')).toBe('abandoned-partial')
    expect(classifyStagingFile('a.gguf.part')).toBe('abandoned-partial')
    expect(classifyStagingFile('sd-master-b290693-bin-win-cuda12-x64.zip')).toBe('cached-archive')
  })

  it('refuses everything else — this is what protects an extracted engine', () => {
    // piper/downloads holds 362 EXTRACTED files it actually runs from.
    for (const n of ['onnxruntime.dll', 'libtashkeel_model.ort', 'ru_dict', 'piper.exe', 'model.gguf', '']) {
      expect(classifyStagingFile(n), n).toBeNull()
    }
  })

  it('is case-insensitive, because Windows is', () => {
    expect(classifyStagingFile('A.GGUF.TMP')).toBe('abandoned-partial')
    expect(classifyStagingFile('Bundle.ZIP')).toBe('cached-archive')
  })
})

describe('where it looks', () => {
  it('finds `<userData>/*/downloads` by the layout, not by a list of engines', () => {
    fs.mkdirSync(path.join(root, 'llama-cpp', 'downloads'), { recursive: true })
    fs.mkdirSync(path.join(root, 'sd-cpp', 'downloads'), { recursive: true })
    // A brand-new engine nobody has told this module about is covered too.
    fs.mkdirSync(path.join(root, 'some-future-engine', 'downloads'), { recursive: true })
    fs.mkdirSync(path.join(root, 'llama-cpp', 'models'), { recursive: true })
    const dirs = stagingDownloadDirs().map(d => path.basename(path.dirname(d)))
    expect(dirs.sort()).toEqual(['llama-cpp', 'sd-cpp', 'some-future-engine'])
  })

  it('never descends into a downloads directory', () => {
    // The extracted tree lives one level deeper. A recursive walk would start
    // offering an engine's own parts.
    put('piper/downloads/nested/inner.zip', 64, 40 * HOUR)
    put('piper/downloads/piper_windows_amd64.zip', 128, 40 * HOUR)
    const inv = scanStagingInventory(NOW)
    expect(inv.files.map(f => f.name)).toEqual(['piper_windows_amd64.zip'])
  })
})

describe('the age guard — derived from the file, not from bookkeeping', () => {
  it('offers a cold staging file', () => {
    put('llama-cpp/downloads/hf_model.gguf.tmp', 2048, 8 * 7 * 24 * HOUR)  // the real one: 8 weeks
    const inv = scanStagingInventory(NOW)
    expect(inv.files).toHaveLength(1)
    expect(inv.files[0].kind).toBe('abandoned-partial')
    expect(inv.files[0].owner).toBe('llama-cpp')
    expect(inv.deadBytes).toBe(2048)
  })

  it('withholds a file being written RIGHT NOW, and says it withheld it', () => {
    // A live transfer rewrites its staging file continuously, so its mtime is
    // always ~now. This is the guard that makes the whole module safe.
    put('llama-cpp/downloads/in-flight.gguf.tmp', 4096, 30 * 1000)
    const inv = scanStagingInventory(NOW)
    expect(inv.files).toHaveLength(0)
    expect(inv.withheldCount).toBe(1)
    expect(inv.totalBytes).toBe(0)
  })

  it('sits exactly on the documented threshold', () => {
    put('sd-cpp/downloads/edge.zip', 10, STAGING_MIN_AGE_MS)
    expect(scanStagingInventory(NOW).files).toHaveLength(1)
    fs.rmSync(path.join(root, 'sd-cpp/downloads/edge.zip'))
    put('sd-cpp/downloads/edge2.zip', 10, STAGING_MIN_AGE_MS - 1000)
    expect(scanStagingInventory(NOW).files).toHaveLength(0)
  })
})

describe('the claim guard — a PAUSED download is the opposite of abandoned', () => {
  it('withholds a cold `.part` that a task still owns', () => {
    // Tasks come back from a restart PAUSED. Those bytes are exactly what the
    // user's next Resume click is counting on, and their mtime is cold.
    const p = put('llama-cpp/downloads/paused.gguf.part', 1024, 72 * HOUR)
    STATE.claimed = [p]
    const inv = scanStagingInventory(NOW)
    expect(inv.files).toHaveLength(0)
    expect(inv.withheldCount).toBe(1)
  })

  it('matches a claim case-insensitively and across slash styles', () => {
    const p = put('llama-cpp/downloads/paused.gguf.part', 1024, 72 * HOUR)
    STATE.claimed = [p.toUpperCase().replace(/\\/g, '/')]
    expect(scanStagingInventory(NOW).files).toHaveLength(0)
  })
})

describe('reclaim re-derives the offer and refuses anything outside it', () => {
  it('deletes what it offered and reports the bytes freed', () => {
    const p = put('llama-cpp/downloads/dead.gguf.tmp', 4096, 100 * HOUR)
    const res = reclaimStaging([p], NOW)
    expect(res.removed).toEqual([p])
    expect(res.freedBytes).toBe(4096)
    expect(res.failed).toEqual([])
    expect(fs.existsSync(p)).toBe(false)
  })

  it('REFUSES a path the caller invented — the renderer is not an authority', () => {
    // The rule removeModelItem follows for weights, restated for staging: an
    // IPC payload is a request, matched against a scan taken now.
    const victim = path.join(root, 'llama-cpp', 'models', 'precious.gguf')
    fs.mkdirSync(path.dirname(victim), { recursive: true })
    fs.writeFileSync(victim, Buffer.alloc(16))
    const res = reclaimStaging([victim, 'C:\\Windows\\System32\\kernel32.dll'], NOW)
    expect(res.removed).toEqual([])
    expect(res.refused).toHaveLength(2)
    expect(res.freedBytes).toBe(0)
    expect(fs.existsSync(victim)).toBe(true)
  })

  it('REFUSES a file that became live between the list and the click', () => {
    const p = put('llama-cpp/downloads/reused.gguf.part', 2048, 100 * HOUR)
    // The user saw it offered; then a download adopted the path.
    STATE.claimed = [p]
    const res = reclaimStaging([p], NOW)
    expect(res.removed).toEqual([])
    expect(res.refused).toEqual([p])
    expect(fs.existsSync(p)).toBe(true)
  })

  it('an empty or junk request deletes nothing and does not throw', () => {
    put('llama-cpp/downloads/dead.gguf.tmp', 32, 100 * HOUR)
    expect(reclaimStaging([], NOW).removed).toEqual([])
    expect(reclaimStaging([''], NOW).removed).toEqual([])
    expect(scanStagingInventory(NOW).files).toHaveLength(1)
  })
})

describe('the outcome line survives the list it emptied', () => {
  // The UI defect a driver found on 2026-08-02, pinned at the source: the block
  // that owns "Freed 5.66 GB" used to unmount the moment the inventory went
  // empty — which is exactly when a successful reclaim produces that sentence.
  // Same for "1 skipped, in use since the list was read". An honest state with
  // no voice is the bug class this repo keeps deleting.
  const src = () => fs.readFileSync(
    path.join(__dirname, '../../src/pages/settings/ModelStorageSection.tsx'), 'utf8')

  it('renders while a note exists even with nothing left to offer', () => {
    expect(src()).toContain("if ((!inv || inv.files.length === 0) && !note) return null")
  })

  it('reads the list through null-safe locals, since inv may now be absent', () => {
    const s = src()
    expect(s).toContain('const files = inv?.files ?? []')
    expect(s).toContain('const totalBytes = inv?.totalBytes ?? 0')
    // …and the header/list only appear when there is something to act on.
    expect(s).toContain('{files.length > 0 && (')
  })
})

describe('the report separates the two costs, because the button costs differently', () => {
  it('dead bytes and cached bytes are counted apart and sum to the total', () => {
    put('llama-cpp/downloads/partial.gguf.tmp', 5000, 100 * HOUR)
    put('sd-cpp/downloads/cudart.zip', 300, 100 * HOUR)
    put('sd-cpp/downloads/engine.zip', 200, 100 * HOUR)
    const inv = scanStagingInventory(NOW)
    expect(inv.deadBytes).toBe(5000)
    expect(inv.cachedBytes).toBe(500)
    expect(inv.totalBytes).toBe(5500)
    expect(inv.files.map(f => f.bytes)).toEqual([5000, 300, 200])   // biggest first
  })

  it('nothing to report is an empty report, not an error', () => {
    fs.mkdirSync(path.join(root, 'rife', 'downloads'), { recursive: true })
    const inv = scanStagingInventory(NOW)
    expect(inv.files).toEqual([])
    expect(inv.totalBytes).toBe(0)
    expect(inv.scannedDirs).toHaveLength(1)
  })
})
