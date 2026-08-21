// apps/desktop/test/unit/genTerminalNotify.test.ts
//
// TWO HALVES OF ONE HOLE: THE LONGEST OP IN THE APP NEVER SAID IT WAS OVER.
//
// 1. THE CHANNEL HAD NO TERMINAL EVENT. `sd-cpp:gen-progress` ticked every
//    second for the whole of a render and then simply stopped — on success it
//    pushed a last snapshot, and on FAILURE it pushed nothing at all and threw.
//    The Media page survived that only because it also awaits the IPC promise;
//    every OTHER consumer of the same channel (the canvas node, a headless run,
//    the chassis IO lamp — see opusChrome.helpers.ts, which names this exact
//    gap as the reason it refuses to drive a lamp off `onGenProgress`) saw a run
//    that started and never ended. The rail's own admission rule is the law
//    here: NO TERMINAL EVENT = NO ROW.
//
// 2. `notification:show` HAD ZERO CALLERS. The IPC, the zod schema and the
//    settings toggle all shipped; nothing ever called them. A 27-minute Wan
//    render finished into an unfocused window and said nothing.
//
// The pins below are the contract: a terminal event on every exit path of both
// generators (image and video), idempotent for the run slice that settles via
// the promise, and exactly ONE OS toast per settled row — never when the user is
// sitting in front of the window watching it, and never for work they stopped
// themselves.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// --- electron mock (sd-cpp-client reads app.getPath at import time) ----------
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-genterm-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

// --- in-memory localStorage shim, installed BEFORE media.store is imported ---
const ls = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}

type ClientMod      = typeof import('../../electron/services/sd-cpp-client')
type ActivityMod    = typeof import('../../src/store/activity.store')
type MediaStoreMod  = typeof import('../../src/store/media.store')
type BridgeMod      = typeof import('../../src/components/activity/activityBridge')
type NotifyMod      = typeof import('../../src/components/activity/activityNotify')
type MediaBridgeMod = typeof import('../../src/pages/media/mediaProgressBridge')

let client: ClientMod
let useActivityStore: ActivityMod['useActivityStore']
let useMediaStore: MediaStoreMod['useMediaStore']
let bridge: BridgeMod
let notify: NotifyMod
let mediaBridge: MediaBridgeMod

beforeAll(async () => {
  client = await import('../../electron/services/sd-cpp-client')
  ;({ useActivityStore } = await import('../../src/store/activity.store'))
  ;({ useMediaStore } = await import('../../src/store/media.store'))
  bridge      = await import('../../src/components/activity/activityBridge')
  notify      = await import('../../src/components/activity/activityNotify')
  mediaBridge = await import('../../src/pages/media/mediaProgressBridge')
})

// --- the window the renderer talks to ---------------------------------------

interface Shown { title: string; body?: string; silent?: boolean }
let shown: Shown[] = []
let focused = false

function installFakeWindow(): void {
  shown = []
  ;(globalThis as unknown as { tachi: unknown }).tachi = {
    notification: { show: (p: Shown) => { shown.push(p); return Promise.resolve() } },
  }
  ;(globalThis as unknown as { document: unknown }).document = {
    hasFocus: () => focused,
    visibilityState: 'visible',
  }
}

const IDLE_RUN = { busy: false, progress: null, error: null, stopping: false, stoppedByUser: false, cancellable: false }

beforeEach(() => {
  focused = false
  installFakeWindow()
  useActivityStore.getState().resetTasks()
  useMediaStore.setState({ run: { ...IDLE_RUN } })
  bridge.resetActivityBridge()
  notify.resetActivityNotify()
  mediaBridge.resetMediaProgressBridge()
  ls.clear()
})

afterEach(() => {
  delete (globalThis as unknown as { tachi?: unknown }).tachi
  delete (globalThis as unknown as { document?: unknown }).document
})

const tasks = () => useActivityStore.getState().tasks
const run   = () => useMediaStore.getState().run

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE CHANNEL'S LAST WORD (main process)
// ═════════════════════════════════════════════════════════════════════════════

describe('sdTerminalEvent — the payload that ends a run on the progress channel', () => {
  const snapDone = {
    step: 20, total: 20, percent: 100, message: 'save result PNG image to \'out.png\'',
    heartbeat: false, phase: 'decoding' as const,
  }

  it('stamps the terminal stage, the media kind and the measured duration', () => {
    const e = client.sdTerminalEvent(snapDone, { stage: 'done', kind: 'image', startedAt: 1_000, now: 164_000 })
    expect(e.stage).toBe('done')
    expect(e.kind).toBe('image')
    expect(e.elapsedMs).toBe(163_000)
    expect(e.heartbeat).toBe(false)
    // the parser's own last line survives — the renderer never writes this copy
    expect(e.message).toBe(snapDone.message)
    expect(e.percent).toBe(100)
  })

  it('an ERROR carries the thrown reason and claims NO completion', () => {
    const e = client.sdTerminalEvent(
      { step: 12, total: 20, percent: 60, message: 'sampling', heartbeat: false, phase: 'sampling' },
      { stage: 'error', kind: 'video', startedAt: 0, now: 5_000, message: 'sd-cli exited with code 3' },
    )
    expect(e.stage).toBe('error')
    expect(e.kind).toBe('video')
    expect(e.message).toBe('sd-cli exited with code 3')
    // A run that died is not 60% of anything any more — but the last real
    // reading (12/20) is kept, because it is what actually happened.
    expect(e.percent).toBe(-1)
    expect(e.step).toBe(12)
    expect(e.total).toBe(20)
  })

  it('never reports a negative duration when the host clock jumps backwards', () => {
    const e = client.sdTerminalEvent(snapDone, { stage: 'done', kind: 'image', startedAt: 9_000, now: 1_000 })
    expect(e.elapsedMs).toBe(0)
  })
})

// THREE producers now, not two: W5-A added `upscaleImage` (`sd-cli -M upscale`),
// which spawns the same binary, rides the same 'sd-cpp:gen-progress' channel and
// is stopped by the same cancelGeneration — so it owes the channel the same last
// word. The counts below are asserted EXACTLY rather than loosened to `>=`: the
// bug this suite exists for is a producer that forgets, and a floor would let a
// fourth one land silently un-terminated.
const SD_GEN_PRODUCERS = 3   // generateImage + generateVideo + upscaleImage

describe('THE CONTRACT: every generator ends the channel on EVERY exit path', () => {
  const src = () => read('electron/services/sd-cpp-client.ts')

  it('every catch path pushes the terminal error BEFORE it rethrows', () => {
    const catches = src().match(/catch \(err\)[\s\S]*?throw err/g) ?? []
    // image + video + upscale
    expect(catches.length).toBe(SD_GEN_PRODUCERS)
    for (const block of catches) expect(block).toContain("pushTerminal('error'")
  })

  it('every success path pushes a terminal done instead of a bare final snapshot', () => {
    const s = src()
    expect((s.match(/pushTerminal\('done'\)/g) ?? []).length).toBe(SD_GEN_PRODUCERS)
    // the old "final snapshot with no terminal marker" is gone
    expect(s).not.toContain('pushProgress(parser.finish())')
  })

  it('the terminal payload is built by the one exported builder, not inline', () => {
    const s = src()
    // 1 export + one call site per producer
    expect((s.match(/sdTerminalEvent\(/g) ?? []).length).toBeGreaterThanOrEqual(1 + SD_GEN_PRODUCERS)
  })

  // Each producer must also clear its heartbeat on the way out, or a finished
  // run keeps ticking "Starting…" forever.
  it('every producer clears its heartbeat timer in the catch as well', () => {
    const catches = src().match(/catch \(err\)[\s\S]*?throw err/g) ?? []
    for (const block of catches) expect(block).toContain('clearInterval(hbTimer)')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE RENDERER SEAM: a terminal is not progress, and it is not a settle
// ═════════════════════════════════════════════════════════════════════════════

type GenSink = (p: Record<string, unknown>) => void

function armMediaBridge(): GenSink {
  let sink: GenSink = () => {}
  mediaBridge.installMediaProgressBridge({
    sdCpp: { onGenProgress: (cb: GenSink) => { sink = cb; return () => {} } },
  } as never)
  return (p) => sink(p)
}

describe('mediaProgressBridge — the terminal event is idempotent for the run slice', () => {
  it('does NOT settle the run: the IPC promise owns that (no double-handling)', () => {
    const push = armMediaBridge()
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 4, total: 20, percent: 20, message: '', heartbeat: false, phase: 'sampling' })
    expect(run().progress).toBe('4/20')

    push({ step: null, total: null, percent: 100, message: 'Done.', heartbeat: false, phase: 'decoding', stage: 'done', kind: 'image', elapsedMs: 12_000 })

    // The row is still the promise's to close — the channel only reports.
    expect(run().busy).toBe(true)
    // …and a terminal is not a progress line, so it does not overwrite one.
    expect(run().progress).toBe('4/20')
  })

  it('fires exactly ONE toast for the run, with the engine-measured duration', () => {
    const push = armMediaBridge()
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 1, total: 4, percent: 25, message: '', heartbeat: false, phase: 'sampling' })
    push({ step: null, total: null, percent: 100, message: 'Done.', heartbeat: false, phase: 'decoding', stage: 'done', kind: 'video', elapsedMs: 163_000 })
    push({ step: null, total: null, percent: 100, message: 'Done.', heartbeat: false, phase: 'decoding', stage: 'done', kind: 'video', elapsedMs: 163_000 })

    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Video ready')
    expect(shown[0].body).toBe('took 2:43')
  })

  it('SAYS NOTHING while the user is watching the window', () => {
    focused = true
    const push = armMediaBridge()
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 1, total: 4, percent: 25, message: '', heartbeat: false, phase: 'sampling' })
    push({ stage: 'done', kind: 'image', elapsedMs: 4_000, step: null, total: null, percent: 100, message: 'Done.', heartbeat: false })
    expect(shown).toEqual([])
  })

  it('a FAILURE toasts the engine\'s own words', () => {
    const push = armMediaBridge()
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 1, total: 4, percent: 25, message: '', heartbeat: false, phase: 'sampling' })
    push({ stage: 'error', kind: 'image', elapsedMs: 900, step: 1, total: 4, percent: -1, message: 'sd-cli exited with code 3 — out of VRAM', heartbeat: false })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Generation failed')
    expect(shown[0].body).toContain('out of VRAM')
  })

  it('a run the user STOPPED gets no toast — they already know', () => {
    const push = armMediaBridge()
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 1, total: 4, percent: 25, message: '', heartbeat: false, phase: 'sampling' })
    useMediaStore.getState().markRunStopping()
    push({ stage: 'error', kind: 'image', elapsedMs: 900, step: 1, total: 4, percent: -1, message: 'sd-cli was stopped before it finished.', heartbeat: false })
    expect(shown).toEqual([])
  })

  it('the NEXT run still reports, even when it dies before its first tick', () => {
    const push = armMediaBridge()
    // run A: ticks, lands, reports.
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ step: 1, total: 4, percent: 25, message: '', heartbeat: false, phase: 'sampling' })
    push({ stage: 'done', kind: 'image', elapsedMs: 4_000, step: null, total: null, percent: 100, message: 'Done.', heartbeat: false })
    useMediaStore.getState().endRun()

    // run B: the spawn dies instantly, so the terminal error is the FIRST event
    // on the channel. A plain "already handled" latch would have eaten this one.
    useMediaStore.getState().beginRun({ cancellable: true })
    push({ stage: 'error', kind: 'image', elapsedMs: 40, step: null, total: null, percent: -1, message: 'spawn ENOENT', heartbeat: false })

    expect(shown).toHaveLength(2)
    expect(shown[1].title).toBe('Generation failed')
    expect(shown[1].body).toBe('spawn ENOENT')
  })

  it('a terminal for work no row was watching is a silent no-op', () => {
    const push = armMediaBridge()
    // no beginRun: nothing was in flight in THIS window (a stale replay)
    push({ stage: 'done', kind: 'image', elapsedMs: 1_000, step: null, total: null, percent: 100, message: 'Done.', heartbeat: false })
    expect(shown).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · THE RAIL'S OWN SETTLES
// ═════════════════════════════════════════════════════════════════════════════

type InstallSink = (p: unknown) => void

function armRail(): { sd: InstallSink; rife: InstallSink; design: InstallSink } {
  const sinks: Record<string, InstallSink> = {}
  bridge.installActivityBridge({
    sdCpp: { onInstallProgress: (cb: InstallSink) => { sinks.sd = cb; return () => {} } },
    rife: {
      onInstallProgress: (cb: InstallSink) => { sinks.rifeInstall = cb; return () => {} },
      onProgress: (cb: InstallSink) => { sinks.rife = cb; return () => {} },
    },
    design: { onRenderProgress: (cb: InstallSink) => { sinks.design = cb; return () => {} } },
  })
  return {
    sd: (p) => sinks.sd?.(p),
    rife: (p) => sinks.rife?.(p),
    design: (p) => sinks.design?.(p),
  }
}

describe('activityBridge — one toast per settled row, and only for rows that existed', () => {
  it('an engine install that finishes unfocused toasts the engine\'s own name', () => {
    const a = armRail()
    a.sd({ stage: 'downloading-engine', message: 'downloading…', percent: 40 })
    expect(tasks()).toHaveLength(1)
    a.sd({ stage: 'done', message: 'Installed.', percent: 100 })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('stable-diffusion.cpp installed')
  })

  it('a failed install carries the installer\'s message as the body', () => {
    const a = armRail()
    a.sd({ stage: 'downloading-engine', message: 'downloading…', percent: 40 })
    a.sd({ stage: 'error', message: 'checksum mismatch', percent: -1 })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('stable-diffusion.cpp install failed')
    expect(shown[0].body).toBe('checksum mismatch')
  })

  it('THE ADMISSION RULE: a done with no row (the already-on-disk fast path) is silent', () => {
    const a = armRail()
    a.sd({ stage: 'done', message: 'Already installed.', percent: 100 })
    expect(tasks()).toEqual([])
    expect(shown).toEqual([])
  })

  it('a MANAGED download that ends on the same channel stays silent too', () => {
    const a = armRail()
    a.sd({ stage: 'downloading-model', message: 'model…', percent: 10 })
    a.sd({ stage: 'done', message: 'Done.', percent: 100 })
    expect(shown).toEqual([])
  })

  it('an interpolation run reports itself when it lands', () => {
    const a = armRail()
    a.rife({ jobId: 'C:/clips/a.mp4', stage: 'interpolating', message: 'frames', percent: 30, counts: { done: 3, total: 10 } })
    a.rife({ jobId: 'C:/clips/a.mp4', stage: 'done', message: 'Done.', percent: 100 })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Frame interpolation finished')
  })

  it('a CANCELLED row never toasts — the user pressed the button', () => {
    const a = armRail()
    a.rife({ jobId: 'C:/clips/a.mp4', stage: 'interpolating', message: 'frames', percent: 30 })
    a.rife({ jobId: 'C:/clips/a.mp4', stage: 'cancelled', message: 'Stopped.', percent: -1 })
    expect(shown).toEqual([])
  })

  it('the Design MP4 export reports itself the same way', () => {
    const a = armRail()
    a.design({ stage: 'rendering', message: 'encoding', percent: 55 })
    a.design({ stage: 'done', message: 'Exported.', percent: 100 })
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Video export finished')
  })

  it('nothing is said while the window has focus', () => {
    focused = true
    const a = armRail()
    a.sd({ stage: 'downloading-engine', message: 'downloading…', percent: 40 })
    a.sd({ stage: 'done', message: 'Installed.', percent: 100 })
    expect(shown).toEqual([])
    // …and the row still settled: the toast is an extra, never the mechanism.
    expect(tasks()[0].status).toBe('completed')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 · THE COPY
// ═════════════════════════════════════════════════════════════════════════════

describe('formatSettleNotice — honest, short, and never invented', () => {
  it('a cancelled settle formats to NOTHING at all', () => {
    expect(notify.formatSettleNotice({ kind: 'image', status: 'cancelled' })).toBeNull()
  })

  it('an unmeasured duration simply has no body rather than a fake one', () => {
    const n = notify.formatSettleNotice({ kind: 'rife', status: 'completed' })
    expect(n?.title).toBe('Frame interpolation finished')
    expect(n?.body).toBe('')
  })

  it('stays inside the IPC schema\'s limits (title 256 / body 512)', () => {
    const n = notify.formatSettleNotice({
      kind: 'engine-install', status: 'failed',
      name: 'x'.repeat(400), detail: 'y'.repeat(900),
    })
    expect(n!.title.length).toBeLessThanOrEqual(256)
    expect(n!.body.length).toBeLessThanOrEqual(512)
  })

  it('the localized copy replaces the English fallback when the strip registers it', () => {
    notify.setActivityNotifyCopy({
      ...notify.FALLBACK_NOTIFY_COPY,
      videoReady: () => 'Видео готово',
      took: (e) => `за ${e}`,
    })
    const n = notify.formatSettleNotice({ kind: 'video', status: 'completed', elapsedMs: 63_000 })
    expect(n).toEqual({ title: 'Видео готово', body: 'за 1:03' })
  })
})

describe('the wiring that a node-env suite cannot mount is pinned to its source', () => {
  it('ActivityStrip re-registers the notification copy whenever the locale changes', () => {
    const strip = read('src/components/activity/ActivityStrip.tsx')
    expect(strip).toContain('setActivityNotifyCopy')
    expect(strip).toMatch(/setActivityNotifyCopy\([\s\S]*?\}, \[t\]\)/)
  })

  it('every notification string is a key in all eight locales', () => {
    const KEYS = [
      'imageReady', 'videoReady', 'genFailed', 'installed', 'installFailed',
      'renderDone', 'renderFailed', 'rifeDone', 'rifeFailed', 'took',
    ]
    for (const lng of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const json = JSON.parse(read(`src/i18n/locales/${lng}/common.json`)) as
        { activity?: { notify?: Record<string, string> } }
      const notifyBlock = json.activity?.notify ?? {}
      for (const k of KEYS) {
        expect(typeof notifyBlock[k], `${lng}/common.json activity.notify.${k}`).toBe('string')
        expect(notifyBlock[k].length, `${lng}/common.json activity.notify.${k}`).toBeGreaterThan(0)
      }
    }
  })
})
