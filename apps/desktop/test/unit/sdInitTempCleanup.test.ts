// apps/desktop/test/unit/sdInitTempCleanup.test.ts
//
// THE INIT-FRAME TEMPS NOBODY DELETED (FLF driver, finding 5) — and the honest
// wall-clock copy for the row that produced them (finding 6).
//
// A wired reference image / i2v init frame arrives at the canvas runner as a
// `data:` URL: the renderer has a File, never a path, so MAIN materialises the
// bytes before sd-cli can open them. That write had no matching delete —
// `sd-init-<ts>.png` in %TEMP%, one per run, forever. The driver counted 882
// of them on one machine, which for a 480p init frame is real disk and, on a
// Wan i2v flow, the same picture written again on every single click.
//
// The house pattern is the video-last-frame extractor's: materialise, use,
// remove in `finally`, and never touch a file we did not create (an init frame
// that was already a PATH belongs to the user).
//
// …AND THE OTHER ROUTE (review of 59c658a, finding 1). The fix above was wired
// into the CANVAS runner only. The MEDIA PAGE reaches sd-cli through
// sd-cpp.ipc's two generate handlers, which materialise the composer's INIT
// FRAME through the same `materializeInitImage` — and had no `finally` of any
// kind, so every click on Generate left one more `sd-init-*` behind. Same leak,
// same 882, one route over. Both handlers are exercised here through the
// registered channel, because the ownership question ("did MAIN write this file,
// or did the user pick it?") is decided at that boundary and nowhere else.
//
// Finding 6 rides along because it is the same row: 44 minutes of GPU for 33
// frames at 20 steps on a 12 GB card is the truth the notes owed the user
// BEFORE they click, not after.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Every temp dir this file makes, so the suite does not do to the test machine
// what the bug under test did to the driver's (review finding 5): each run used
// to leave a fistful of `tachi-*` dirs in %TEMP% forever.
const TEMPS = vi.hoisted(() => [] as string[])

/** mkdtempSync + "remember to delete this in afterAll". */
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  TEMPS.push(d)
  return d
}

afterAll(() => {
  for (const d of TEMPS) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } }
})

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  const d = mk(j(td(), 'tachi-inittmp-'))
  TEMPS.push(d)
  return d
})

// ipcMain.handle is captured straight into this map, so the two generate
// handlers can be invoked exactly as the renderer invokes them (the idiom
// nodesFlowDelete / storageRootHealVerticals use).
type IpcHandler = (event: unknown, payload: unknown) => unknown
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }))

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => { ipcState.handlers.set(channel, fn) },
    on: () => {},
  },
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => String(b),
  },
}))

interface SdCall { modelId: string; initImagePath?: string; initExisted?: boolean }
const sd = vi.hoisted(() => ({ image: [] as SdCall[], video: [] as SdCall[] }))

vi.mock('../../electron/services/sd-cpp-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  const p  = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'tachi-inittmp-out-'))
  TEMPS.push(dir)
  let seq = 0
  const record = (bucket: SdCall[], mime: string) => async (input: SdCall) => {
    // The engine sees the file WHILE it runs — that is the half that must work.
    bucket.push({ ...input, initExisted: input.initImagePath ? fs.existsSync(input.initImagePath) : undefined })
    const path = p.join(dir, `${input.modelId}-${seq++}.bin`)
    fs.writeFileSync(path, 'bytes')
    return { mime, path }
  }
  return {
    generateImage: vi.fn(record(sd.image, 'image/png')),
    generateVideo: vi.fn(record(sd.video, 'video/mp4')),
    // Named by sd-cpp.ipc's import list; never invoked here, but a mocked
    // module has to carry them or the access throws when the module loads.
    sdStatus: vi.fn(() => ({ installed: false, models: [] })),
    cancelGeneration: vi.fn(() => ({ cancelled: false })),
  }
})

import {
  runMediaNode,
  sweepStaleSdInitTemps,
  sweepStaleMediaTemps,
  classifyMediaTemp,
  SD_INIT_TEMP_MAX_AGE_MS,
} from '../../electron/services/graph-to-agentkit'
import { registerSdCppIpc } from '../../electron/ipc/sd-cpp.ipc'
import { materializeInitImage } from '../../electron/services/util/init-image'
import { SD_VIDEO_MODELS } from '../../electron/services/sd-cpp-models'
import type { TachiFlow, TachiMediaNode, TachiNode } from '../../src/pages/nodes/types'

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('INIT-FRAME-BYTES').toString('base64')}`

function mediaNode(id: string, modality: 'image' | 'video', model: string, params: Record<string, unknown>): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 },
    data: { label: id, modality, provider: 'local', model, prompt: `p ${id}`, params },
  } as TachiNode
}

async function run(node: TachiNode): Promise<void> {
  const flow: TachiFlow = { name: 'tmp', nodes: [node], edges: [] } as TachiFlow
  await runMediaNode(flow.nodes[0] as TachiMediaNode, flow, new Map())
}

beforeEach(() => {
  sd.image.length = 0
  sd.video.length = 0
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. PER-RUN CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

describe('a data: init frame is materialised, used, and removed', () => {
  it('reaches the engine as a real file…', async () => {
    await run(mediaNode('vid', 'video', 'wan21-t2v-1.3b', { image_url: PNG_DATA_URL }))
    expect(sd.video[0]!.initImagePath).toBeTruthy()
    expect(sd.video[0]!.initExisted, 'the engine was handed a path with no file behind it').toBe(true)
  })

  it('…and is gone once the run returns', async () => {
    await run(mediaNode('vid', 'video', 'wan21-t2v-1.3b', { image_url: PNG_DATA_URL }))
    expect(existsSync(sd.video[0]!.initImagePath!)).toBe(false)
  })

  it('is removed on the img2img path too', async () => {
    await run(mediaNode('img', 'image', 'sd15', { image_url: PNG_DATA_URL }))
    expect(sd.image[0]!.initExisted).toBe(true)
    expect(existsSync(sd.image[0]!.initImagePath!)).toBe(false)
  })

  it('is removed even when the engine THROWS (the finally, not a happy path)', async () => {
    const { generateVideo } = await import('../../electron/services/sd-cpp-client')
    const seen: string[] = []
    vi.mocked(generateVideo).mockImplementationOnce(async (input: { initImagePath?: string }) => {
      if (input.initImagePath) seen.push(input.initImagePath)
      throw new Error('engine refused')
    })
    await run(mediaNode('vid', 'video', 'wan21-t2v-1.3b', { image_url: PNG_DATA_URL }))
    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0]!)).toBe(false)
  })

  it('NEVER deletes a frame it did not create (an on-disk path is the user\'s)', async () => {
    const dir = tempDir('tachi-user-frame-')
    const mine = join(dir, 'my-photo.png')
    writeFileSync(mine, 'USER-BYTES')
    await run(mediaNode('vid', 'video', 'wan21-t2v-1.3b', { image_url: mine }))
    expect(sd.video[0]!.initImagePath).toBe(mine)
    expect(existsSync(mine), 'the run ate the user\'s own file').toBe(true)
  })

  it('two runs never collide on one filename (a same-millisecond pair)', async () => {
    await run(mediaNode('a', 'video', 'wan21-t2v-1.3b', { image_url: PNG_DATA_URL }))
    await run(mediaNode('b', 'video', 'wan21-t2v-1.3b', { image_url: PNG_DATA_URL }))
    expect(sd.video[0]!.initImagePath).not.toBe(sd.video[1]!.initImagePath)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE OTHER ROUTE — the Media page's two IPC handlers
// ═════════════════════════════════════════════════════════════════════════════
//
// Same leak, different door. The composer sends `initImage` (a data: URL, since
// the renderer only ever holds a File) and sd-cpp.ipc turns it into the
// `initImagePath` the service understands. That write is main's, so the delete
// is main's too — and the ONLY thing it may delete is what it wrote: the same
// control also accepts a path (a Remix of an entry that recorded one), and that
// is the user's own picture sitting in their own folder.

describe('the Media-page generate handlers clean up after themselves', () => {
  registerSdCppIpc({} as never)

  const call = async (channel: string, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
    const h = ipcState.handlers.get(channel)
    if (!h) throw new Error(`handler not registered: ${channel}`)
    return await h({ sender: {} }, payload) as { ok: boolean; error?: string }
  }

  it('the image handler materialises a real file for the engine…', async () => {
    const r = await call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a cat', initImage: PNG_DATA_URL })
    expect(r.ok).toBe(true)
    expect(sd.image[0]!.initImagePath).toBeTruthy()
    expect(sd.image[0]!.initExisted, 'the engine was handed a path with no file behind it').toBe(true)
  })

  it('…and it is gone once the handler answers', async () => {
    await call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a cat', initImage: PNG_DATA_URL })
    expect(existsSync(sd.image[0]!.initImagePath!), 'one leaked temp per Generate click').toBe(false)
  })

  it('the video handler (INIT FRAME → i2v) does the same', async () => {
    await call('sd-cpp:generate-video', { modelId: 'wan21-i2v-14b-480p', prompt: 'animate', initImage: PNG_DATA_URL })
    expect(sd.video[0]!.initExisted).toBe(true)
    expect(existsSync(sd.video[0]!.initImagePath!)).toBe(false)
  })

  it('removes it even when the engine THROWS (the finally, not a happy path)', async () => {
    const { generateVideo } = await import('../../electron/services/sd-cpp-client')
    const seen: string[] = []
    vi.mocked(generateVideo).mockImplementationOnce(async (input: { initImagePath?: string }) => {
      if (input.initImagePath) seen.push(input.initImagePath)
      throw new Error('engine refused')
    })
    const r = await call('sd-cpp:generate-video', { modelId: 'wan21-i2v-14b-480p', prompt: 'animate', initImage: PNG_DATA_URL })
    expect(r.ok).toBe(false)          // resolved, not rejected — the row renders it
    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0]!)).toBe(false)
  })

  it('NEVER deletes the user\'s own picture — on success…', async () => {
    const mine = join(tempDir('tachi-user-pick-'), 'holiday.png')
    writeFileSync(mine, 'USER-BYTES')
    await call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a cat', initImage: mine })
    expect(sd.image[0]!.initImagePath).toBe(mine)
    expect(existsSync(mine), 'the run ate the user\'s own file').toBe(true)
  })

  it('…nor when the engine dies holding it', async () => {
    const mine = join(tempDir('tachi-user-pick-'), 'holiday.png')
    writeFileSync(mine, 'USER-BYTES')
    const { generateImage } = await import('../../electron/services/sd-cpp-client')
    vi.mocked(generateImage).mockImplementationOnce(async () => { throw new Error('VRAM') })
    const r = await call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a cat', initImage: mine })
    expect(r.ok).toBe(false)
    expect(existsSync(mine), 'a failed render deleted the user\'s file').toBe(true)
  })

  it('two clicks inside one millisecond do not share a filename', async () => {
    // Both handlers name the temp with entropy as well as a clock, for the same
    // reason the canvas route does: the loser of a same-ms collision would
    // generate from the winner's frame — and now that the file is DELETED at the
    // end of a run, the second run would also lose it mid-flight.
    await Promise.all([
      call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a', initImage: PNG_DATA_URL }),
      call('sd-cpp:generate', { modelId: 'sd15', prompt: 'b', initImage: PNG_DATA_URL }),
    ])
    expect(sd.image).toHaveLength(2)
    expect(sd.image[0]!.initImagePath).not.toBe(sd.image[1]!.initImagePath)
    expect(sd.image.every(c => c.initExisted)).toBe(true)
    // The clock alone made this pass by luck on a fast machine, so the claim is
    // pinned on the NAME: `<ts>-<hex>`, and still inside the shape the boot
    // sweep collects.
    for (const c of sd.image) {
      expect(c.initImagePath!.split(/[\\/]/).pop()).toMatch(/^sd-init-\d+-[0-9a-f]+\.png$/)
    }
  })

  it('a payload with NO init frame reaches the engine unchanged', async () => {
    await call('sd-cpp:generate', { modelId: 'sd15', prompt: 'a cat' })
    expect(sd.image[0]!.initImagePath).toBeUndefined()
    expect('initImagePath' in sd.image[0]!).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE SWEEP — for the 882 already on disk
// ═════════════════════════════════════════════════════════════════════════════

describe('sweepStaleSdInitTemps', () => {
  const HOUR = 60 * 60 * 1000
  const now = Date.now()

  /** A temp dir seeded with one file per entry, aged by `hoursOld`. */
  function seeded(files: Array<{ name: string; hoursOld: number }>): string {
    const dir = tempDir('tachi-sweep-')
    for (const f of files) {
      const p = join(dir, f.name)
      writeFileSync(p, 'x')
      const when = new Date(now - f.hoursOld * HOUR)
      utimesSync(p, when, when)
    }
    return dir
  }

  it('collects OUR stale leftovers', () => {
    const dir = seeded([
      { name: 'sd-init-1690000000000.png', hoursOld: 48 },
      { name: 'sd-init-1690000000001-ab12cd34.png', hoursOld: 25 },
    ])
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })

  it('collects EVERY extension the materialiser can emit, not just .png', () => {
    // extForMime names the file by the declared mime — a JPEG init frame lands
    // as `sd-init-<ts>.jpg`. The sweep's pattern was .png-only, so those were
    // permanently uncollectable: nothing else on the machine ever looks at them
    // again (review of 59c658a, finding 2).
    const dir = seeded([
      { name: 'sd-init-1690000000000.jpg',           hoursOld: 25 },
      { name: 'sd-init-1690000000001.jpeg',          hoursOld: 25 },
      { name: 'sd-init-1690000000002-ab12cd34.webp', hoursOld: 25 },
      { name: 'sd-init-1690000000003.bmp',           hoursOld: 25 },
    ])
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(4)
    expect(readdirSync(dir)).toEqual([])
  })

  it('is kept in sync with extForMime — every name the materialiser writes IS sweepable', () => {
    // The pattern and the naming table live in different modules, so this loop is
    // the only thing holding them together: write one temp per mime extForMime
    // knows about, age them all, and demand the sweep take every one.
    const dir = tempDir('tachi-sweep-live-')
    const b64 = Buffer.from('INIT').toString('base64')
    const mimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', '', 'application/octet-stream']
    const written = mimes.map((mime, i) =>
      materializeInitImage(`data:${mime};base64,${b64}`, { dir, now: () => 1690000000000 + i }))
    expect(written.every(p => typeof p === 'string')).toBe(true)
    for (const p of written) {
      const when = new Date(now - 25 * HOUR)
      utimesSync(p!, when, when)
    }
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(new Set(written).size)
    expect(readdirSync(dir)).toEqual([])
  })

  it('and leaves a FRESH .jpg alone, exactly like a fresh .png', () => {
    const dir = seeded([{ name: 'sd-init-1690000000000.jpg', hoursOld: 1 }])
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('leaves a temp from a RUN THAT IS STILL GOING alone', () => {
    // A 44-minute Wan render holds its init frame open the whole time; a sweep
    // that collected it would break the run it shares a machine with.
    const dir = seeded([{ name: 'sd-init-1690000000000.png', hoursOld: 1 }])
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('touches nothing that is not ours, however old', () => {
    const dir = seeded([
      { name: 'important.png', hoursOld: 999 },
      { name: 'sd-init.png', hoursOld: 999 },          // no timestamp — not our shape
      { name: 'sd-init-123.txt', hoursOld: 999 },      // not an image ext we emit
      { name: 'xsd-init-123.png', hoursOld: 999 },     // not our prefix
      { name: 'sd-vid-123.webm', hoursOld: 999 },      // an OUTPUT, never a temp
      { name: 'sd-init-123.gif', hoursOld: 999 },      // extForMime cannot emit .gif
    ])
    expect(sweepStaleSdInitTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(6)
  })

  it('never throws on a directory it cannot read', () => {
    expect(sweepStaleSdInitTemps(join(tmpdir(), 'tachi-does-not-exist-at-all'), SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
  })

  it('is 24h by default, and is scheduled off the boot path', () => {
    expect(SD_INIT_TEMP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
    // The boot path still schedules ONE sweep, under the name it always used —
    // that name is now an alias for the two-shape sweep.
    expect(sweepStaleSdInitTemps).toBe(sweepStaleMediaTemps)
    // Deferred + unref'd: the boot prelude is a budget (R8b), and a readdir of
    // %TEMP% is not something to spend it on.
    const ipc = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '..', '..', 'electron/ipc/graph.ipc.ts'), 'utf8',
    ) as string
    expect(ipc).toContain('sweepStaleSdInitTemps()')
    expect(ipc).toContain('.unref?.()')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3b. THE OTHER LEFTOVER — a killed interpolation's multi-GB frame directory
//
// rife-runner deletes its `tachi-rife-*` work dir in a `finally`, which covers
// every path the runner controls and NONE of the paths where the process itself
// dies: a crash, a power cut, and (until the will-quit fix) an app quit each
// stranded a whole decoded PNG sequence forever. The sweep is the backstop, and
// because it now deletes RECURSIVELY the matcher is the entire safety argument.
// ═════════════════════════════════════════════════════════════════════════════

describe('classifyMediaTemp — what the sweep is allowed to touch', () => {
  it('claims the runner\'s own work-dir shape (mkdtemp: prefix + six chars)', () => {
    for (const n of ['tachi-rife-a1B2c3', 'tachi-rife-XXXXXX', 'tachi-rife-000000']) {
      expect(classifyMediaTemp(n), n).toBe('rife-workdir')
    }
  })

  it('does NOT claim the vitest fixtures — deleting one mid-suite is a self-inflicted flake', () => {
    // rifeRunner.test.ts uses `tachi-rife-test-`, rifeInstaller.test.ts uses
    // `tachi-rife-inst-`; both are mkdtemp prefixes, so both are longer AND
    // carry an infix the runner's own name never has.
    for (const n of ['tachi-rife-test-a1B2c3', 'tachi-rife-inst-a1B2c3']) {
      expect(classifyMediaTemp(n), n).toBeNull()
    }
  })

  it('does not claim look-alikes of either shape', () => {
    for (const n of [
      'tachi-rife-',            // the bare prefix — mkdtemp always adds six
      'tachi-rife-abcde',       // five
      'tachi-rife-abcdefg',     // seven
      'tachi-rife-ab_2c3',      // an underscore is not in libuv's tempchars
      'xtachi-rife-a1B2c3',     // not our prefix
      'tachi-rife-a1B2c3.mp4',  // a FILE that borrowed the name
      'tachi-sweep-a1B2c3',     // this suite's own scratch dirs
      'important',
    ]) {
      expect(classifyMediaTemp(n), n).toBeNull()
    }
  })

  it('still classifies every init-frame name it always did', () => {
    expect(classifyMediaTemp('sd-init-1690000000000.png')).toBe('init-frame')
    expect(classifyMediaTemp('sd-init-1690000000000-ab12cd34.webp')).toBe('init-frame')
    expect(classifyMediaTemp('sd-init.png')).toBeNull()
  })

  // The live latent preview's frame file (2026-08-03). generateImage removes it
  // on both exits it controls; a KILLED process runs neither, so a crash
  // mid-render strands one. Same accumulation that produced 882 sd-init files.
  it('claims the preview frame a crashed render leaves behind', () => {
    expect(classifyMediaTemp('tachi-sd-preview-1785700000000-123.png')).toBe('preview-frame')
    expect(classifyMediaTemp('tachi-sd-preview-1-0.png')).toBe('preview-frame')
  })

  it('does not claim a user file that merely starts the same way', () => {
    for (const n of [
      'tachi-sd-preview.png',                  // no stamps at all
      'tachi-sd-preview-1785700000000.png',    // only one — ours always has two
      'tachi-sd-preview-abc-123.png',          // both must be integers
      'tachi-sd-preview-1-2.jpg',              // we only ever write PNG
      'my-tachi-sd-preview-1-2.png',           // not our prefix
      'tachi-sd-preview-1-2.png.bak',          // a copy someone made
    ]) {
      expect(classifyMediaTemp(n), n).toBeNull()
    }
  })
})

// ── AND THE SWEEP HAS TO AGREE WITH THE CLASSIFIER (review, 2026-08-03) ─────
//
// classifyMediaTemp learned 'preview-frame' and the sweep did not. Its type
// check was `kind === 'init-frame' ? !st.isFile() : !st.isDirectory()` — a
// two-way ternary over what had been a two-value union — so a preview PNG (a
// FILE) took the else branch, was tested for directory-ness, and was skipped
// forever. The classifier test passed the whole time, because it only ever
// asked the classifier. The fix is a shape TABLE, so a new kind without a
// declared shape fails to typecheck instead of being silently exempted.
describe('sweepStaleMediaTemps · the preview frame a crashed render leaves', () => {
  const HOUR = 60 * 60 * 1000

  it('DELETES a stale preview PNG — the classifier alone never made it happen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tachi-sweep-prev-'))
    const stale = join(dir, 'tachi-sd-preview-1785700000000-123.png')
    writeFileSync(stale, 'x')
    const old = Date.now() - 48 * HOUR
    utimesSync(stale, old / 1000, old / 1000)

    const removed = sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, Date.now())
    expect(removed, 'THE PIN: this was 0 — the file matched the classifier and the sweep skipped it').toBe(1)
    expect(existsSync(stale)).toBe(false)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('leaves a preview frame from a run that may still be going', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tachi-sweep-prev-'))
    const fresh = join(dir, 'tachi-sd-preview-1785700000000-124.png')
    writeFileSync(fresh, 'x')
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, Date.now())).toBe(0)
    expect(existsSync(fresh)).toBe(true)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('does not follow a DIRECTORY wearing the preview name', () => {
    // Same rule the other two shapes get: the name is not enough, the shape has
    // to match, or a recursive delete could take something that is not ours.
    const dir = mkdtempSync(join(tmpdir(), 'tachi-sweep-prev-'))
    const trap = join(dir, 'tachi-sd-preview-1-2.png')
    mkdirSync(trap)
    const old = Date.now() - 48 * HOUR
    utimesSync(trap, old / 1000, old / 1000)
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, Date.now())).toBe(0)
    expect(existsSync(trap)).toBe(true)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
})

describe('sweepStaleMediaTemps · tachi-rife-* work dirs', () => {
  const HOUR = 60 * 60 * 1000
  const now = Date.now()

  /** A temp dir seeded with one WORK DIR per entry (frames inside), aged. */
  function seededDirs(dirs: Array<{ name: string; hoursOld: number }>): string {
    const root = tempDir('tachi-sweep-rife-')
    for (const d of dirs) {
      const p = join(root, d.name)
      mkdirSync(join(p, 'in'), { recursive: true })
      mkdirSync(join(p, 'out'), { recursive: true })
      writeFileSync(join(p, 'in', '00000001.png'), 'FRAME')
      writeFileSync(join(p, 'out', '00000001.png'), 'FRAME')
      const when = new Date(now - d.hoursOld * HOUR)
      utimesSync(p, when, when)
    }
    return root
  }

  it('removes a stale work dir, gigabytes of frames and all', () => {
    const dir = seededDirs([{ name: 'tachi-rife-a1B2c3', hoursOld: 48 }])
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves a FRESH work dir alone — a running interpolation owns it', () => {
    // The failure this forbids is the worst one available: deleting the frame
    // directory out from under a live rife process on the same machine.
    const dir = seededDirs([{ name: 'tachi-rife-a1B2c3', hoursOld: 1 }])
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(existsSync(join(dir, 'tachi-rife-a1B2c3', 'out', '00000001.png'))).toBe(true)
  })

  it('leaves the vitest fixture dirs alone, however old', () => {
    const dir = seededDirs([
      { name: 'tachi-rife-test-a1B2c3', hoursOld: 999 },
      { name: 'tachi-rife-inst-a1B2c3', hoursOld: 999 },
    ])
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('ignores a stale FILE wearing the work-dir name (and a DIR wearing an init-frame name)', () => {
    const dir = tempDir('tachi-sweep-type-')
    const file = join(dir, 'tachi-rife-a1B2c3')
    writeFileSync(file, 'not a directory')
    const asDir = join(dir, 'sd-init-1690000000000.png')
    mkdirSync(asDir)
    for (const p of [file, asDir]) {
      const when = new Date(now - 999 * HOUR)
      utimesSync(p, when, when)
    }
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('takes both shapes in ONE pass and counts them together', () => {
    const dir = seededDirs([
      { name: 'tachi-rife-a1B2c3', hoursOld: 30 },
      { name: 'tachi-rife-d4E5f6', hoursOld: 1 },        // fresh — survives
    ])
    for (const [name, hoursOld] of [['sd-init-1690000000000.png', 30], ['sd-init-1690000000001.jpg', 1]] as const) {
      const p = join(dir, name)
      writeFileSync(p, 'x')
      const when = new Date(now - hoursOld * HOUR)
      utimesSync(p, when, when)
    }
    expect(sweepStaleMediaTemps(dir, SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['sd-init-1690000000001.jpg', 'tachi-rife-d4E5f6'])
  })

  it('never throws on a directory it cannot read', () => {
    expect(sweepStaleMediaTemps(join(tmpdir(), 'tachi-does-not-exist-at-all'), SD_INIT_TEMP_MAX_AGE_MS, now)).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. FINDING 6 — the i2v row says what 20 steps costs
// ═════════════════════════════════════════════════════════════════════════════

describe('the Wan i2v row is honest about wall-clock', () => {
  const row = SD_VIDEO_MODELS.find(m => m.id === 'wan21-i2v-14b-480p')!

  it('names the measurement: ~44 min for 33 frames at 20 steps on 12 GB', () => {
    expect(row.notes).toMatch(/44\s*min/i)
    expect(row.notes).toContain('33 frames')
    expect(row.notes).toContain('20 steps')
    expect(row.notes).toContain('12 GB')
  })

  it('says WHY it is slow — GPU-bound, not the CPU-offload people assume', () => {
    expect(row.notes).toMatch(/GPU-bound/i)
  })

  it('sets the expectation in minutes, and points at the speed path', () => {
    expect(row.notes).toMatch(/tens of minutes/i)
    expect(row.notes).toMatch(/distilled/i)
  })

  it('keeps the download-size prose the dedup label test pins', () => {
    expect(row.notes).toContain('17.6 GB')
    expect(row.notes).toContain('11.7 GB')
  })
})
