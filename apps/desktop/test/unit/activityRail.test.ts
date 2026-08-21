// apps/desktop/test/unit/activityRail.test.ts
//
// THE PROGRESS MUST NOT GET LOST WHEN THE USER WANDERS.
//
// Owner incident (verbatim): «прогресс какая бы вкладка не была не должен
// проебываться теряться — юзер может лазить по приложению пока процессы идут».
// A Wan video generation was started on the Media tab; the owner switched tabs
// and had no idea it was running and no way to stop it. The render kept the GPU
// for another hour.
//
// The activity rail is the fix, and this file pins the half of it that can be
// executed. vitest here runs `environment: 'node'` with no testing-library, so
// the component cannot be mounted — which is exactly why the rail was built as
// three pure/near-pure modules plus a thin renderer:
//
//   • activity.store        — the task registry (transitions, terminality)
//   • activityRows          — the projection stores → ordered render list
//   • activityBridge        — push channels → registry rows
//   • activityCancel        — a cancel DESCRIPTOR → the real IPC call
//
// Everything the renderer cannot be tested for is asserted against its SOURCE
// (the idiom mediaRunState.test.ts already uses for MediaPage): the mount, the
// absence of a `confirm()`, the null-when-idle return.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

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

type ActivityStoreMod = typeof import('../../src/store/activity.store')
type MediaStoreMod    = typeof import('../../src/store/media.store')
type RowsMod          = typeof import('../../src/components/activity/activityRows')
type BridgeMod        = typeof import('../../src/components/activity/activityBridge')
type CancelMod        = typeof import('../../src/components/activity/activityCancel')
type MediaBridgeMod   = typeof import('../../src/pages/media/mediaProgressBridge')

let useActivityStore: ActivityStoreMod['useActivityStore']
let useMediaStore: MediaStoreMod['useMediaStore']
let rows: RowsMod
let bridge: BridgeMod
let cancelMod: CancelMod
let mediaBridge: MediaBridgeMod

beforeAll(async () => {
  ;({ useActivityStore } = await import('../../src/store/activity.store'))
  ;({ useMediaStore } = await import('../../src/store/media.store'))
  rows        = await import('../../src/components/activity/activityRows')
  bridge      = await import('../../src/components/activity/activityBridge')
  cancelMod   = await import('../../src/components/activity/activityCancel')
  mediaBridge = await import('../../src/pages/media/mediaProgressBridge')
})

const IDLE_RUN = { busy: false, progress: null, error: null, stopping: false, cancellable: false }

beforeEach(() => {
  useActivityStore.getState().resetTasks()
  useMediaStore.setState({ run: { ...IDLE_RUN } })
  bridge.resetActivityBridge()
  mediaBridge.resetMediaProgressBridge()
  ls.clear()
})

const tasks = () => useActivityStore.getState().tasks
const run   = () => useMediaStore.getState().run

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE INCIDENT, END TO END
// ═════════════════════════════════════════════════════════════════════════════

describe('THE INCIDENT: a local render is visible from any tab, and stoppable there', () => {
  it('a generation appears on the rail from the engine progress event alone', () => {
    // MediaPage mounts once, installs the never-torn-down listener, starts work…
    const sinks: Array<(p: { step: number | null; total: number | null; percent: number; message: string; heartbeat: boolean }) => void> = []
    mediaBridge.installMediaProgressBridge({ sdCpp: { onGenProgress: cb => { sinks.push(cb); return () => {} } } })
    useMediaStore.getState().beginRun({ cancellable: true })

    // …the owner switches tabs (MediaPage is UNMOUNTED) and the engine ticks.
    sinks[0]({ step: 14, total: 20, percent: 70, message: '', heartbeat: false })

    // The rail — which is not the Media tab — has a live row with real numbers.
    const list = rows.buildActivityEntries({ run: run(), tasks: tasks() })
    expect(list).toHaveLength(1)
    const entry = list[0]
    if (entry.type !== 'row') throw new Error('expected a generic row, got a download row')
    const row = entry.row
    expect(row.id).toBe('media:generate')
    expect(row.kind).toBe('generate')
    expect(row.status).toBe('running')
    expect(row.percent).toBe(70)
    expect(row.counts).toEqual({ done: 14, total: 20 })
    expect(row.stage).toBe('14/20')      // the producer's own phrase, verbatim
    expect(row.surface).toBe('/media')   // clicking the row goes back to the work
    expect(row.cancel).toEqual({ kind: 'sd-generate' })
  })

  it('STOP on the rail issues the real kill IPC and latches the button', async () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    const cancelGeneration = vi.fn(async () => ({ ok: true, cancelled: true }))

    const before = rows.mediaRunRow(run())!
    expect(before.cancel).toEqual({ kind: 'sd-generate' })

    const out = await cancelMod.runActivityCancel(before.cancel!, { sdCpp: { cancelGeneration } })

    expect(cancelGeneration).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ ok: true, kind: 'sd-generate' })
    // The latch is the whole double-click guard: the row now says STOPPING and
    // offers no second button, while the run is still busy.
    expect(run().stopping).toBe(true)
    const after = rows.mediaRunRow(run())!
    expect(after.stopping).toBe(true)
    expect(after.cancel).toBeNull()
  })

  it('the kill lands through the SAME failure path — the row goes, the reason stays', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().markRunStopping()
    // main reports the child's death exactly as any other failure
    useMediaStore.getState().failRun('sd-cli vid_gen was stopped before it finished.')

    expect(rows.mediaRunRow(run())).toBeNull()              // no row for settled work
    expect(run().error).toContain('stopped before it finished')  // …but the reason survives
  })

  it('a cloud job advertises NO stop, because it has no child to kill', () => {
    useMediaStore.getState().beginRun()                     // cancellable: false
    expect(rows.mediaRunRow(run())!.cancel).toBeNull()
  })

  it('a stop with no bridge fails loudly in the return value, never by throwing', async () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    const out = await cancelMod.runActivityCancel({ kind: 'sd-generate' }, {})
    expect(out.ok).toBe(false)
    expect(out.error).toContain('cancelGeneration')
  })

  it('a migrate row stops through modelStorage.abort(engine) — the OTHER real cancel', async () => {
    const abort = vi.fn(async () => ({ ok: true }))
    const out = await cancelMod.runActivityCancel({ kind: 'migrate', engine: 'sdcpp' }, { modelStorage: { abort } })
    expect(abort).toHaveBeenCalledWith('sdcpp')
    expect(out).toEqual({ ok: true, kind: 'migrate' })
  })

  it('a throwing IPC is reported, not propagated (a failed Stop must not take the rail down)', async () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    const out = await cancelMod.runActivityCancel(
      { kind: 'sd-generate' },
      { sdCpp: { cancelGeneration: async () => { throw new Error('no child') } } },
    )
    expect(out).toEqual({ ok: false, kind: 'sd-generate', error: 'no child' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE TASK REGISTRY
// ═════════════════════════════════════════════════════════════════════════════

describe('activity.store: every transition a row can make', () => {
  it('a progress event OPENS a row (nothing else creates one)', () => {
    useActivityStore.getState().progressTask('engine:sdcpp', {
      kind: 'engine-install', label: 'stable-diffusion.cpp', stage: 'downloading', percent: 12,
    })
    expect(tasks()).toHaveLength(1)
    expect(tasks()[0]).toMatchObject({
      id: 'engine:sdcpp', kind: 'engine-install', label: 'stable-diffusion.cpp',
      stage: 'downloading', percent: 12, status: 'running',
    })
  })

  it('later ticks advance the SAME row instead of stacking new ones', () => {
    const s = useActivityStore.getState()
    s.progressTask('x', { kind: 'render', percent: 10, stage: 'a' })
    s.progressTask('x', { kind: 'render', percent: 40, stage: 'b' })
    expect(tasks()).toHaveLength(1)
    expect(tasks()[0]).toMatchObject({ percent: 40, stage: 'b' })
  })

  it('an unmeasured percent is -1, never a fabricated 0 (honesty clause 3)', () => {
    const s = useActivityStore.getState()
    s.progressTask('x', { kind: 'render', percent: -1 })
    expect(tasks()[0].percent).toBe(-1)
    s.progressTask('y', { kind: 'render', percent: Number.NaN })
    expect(tasks()[1].percent).toBe(-1)
    s.progressTask('z', { kind: 'render', percent: 400 })
    expect(tasks()[2].percent).toBe(100)
  })

  it('COMPLETION settles the row at a real 100% and drops the cancel', () => {
    const s = useActivityStore.getState()
    s.progressTask('x', { kind: 'migrate', percent: 61, cancel: { kind: 'migrate', engine: 'sdcpp' } })
    s.settleTask('x', { status: 'completed', stage: 'done' })
    expect(tasks()[0]).toMatchObject({ status: 'completed', percent: 100, cancel: null })
  })

  it('FAILURE keeps the producer\'s own message and the last real percent', () => {
    const s = useActivityStore.getState()
    s.progressTask('x', { kind: 'engine-install', percent: 37 })
    s.settleTask('x', { status: 'failed', error: 'HTTP 403 from huggingface.co' })
    expect(tasks()[0]).toMatchObject({ status: 'failed', percent: 37, error: 'HTTP 403 from huggingface.co' })
  })

  it('a terminal event for a row nobody opened is a NO-OP, never a phantom row', () => {
    useActivityStore.getState().settleTask('never-seen', { status: 'completed' })
    expect(tasks()).toEqual([])
  })

  it('a successful row auto-dismisses; a FAILED one is sticky until dismissed', async () => {
    const s = useActivityStore.getState()
    s.progressTask('ok', { kind: 'render' })
    s.progressTask('bad', { kind: 'render' })
    s.settleTask('ok', { status: 'completed' }, 0)
    s.settleTask('bad', { status: 'failed', error: 'boom' }, 0)
    await new Promise(r => setTimeout(r, 10))
    expect(tasks().map(t => t.id)).toEqual(['bad'])
    useActivityStore.getState().dismissTask('bad')
    expect(tasks()).toEqual([])
  })

  it('a retry on the same channel re-opens the row and clears the old error', () => {
    const s = useActivityStore.getState()
    s.progressTask('x', { kind: 'engine-install' })
    s.settleTask('x', { status: 'failed', error: 'boom' })
    s.progressTask('x', { kind: 'engine-install', percent: 5 })
    expect(tasks()[0]).toMatchObject({ status: 'running', error: undefined, percent: 5 })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · THE BRIDGE — real channels in, rows out
// ═════════════════════════════════════════════════════════════════════════════

type Sink = (raw: unknown) => void

function fakeSources() {
  const sinks: Record<string, Sink[]> = { sdCpp: [], piper: [], llamaCpp: [], design: [], modelStorage: [] }
  const ch = (k: string) => ({ onInstallProgress: (cb: Sink) => { sinks[k].push(cb); return () => {} } })
  return {
    sinks,
    api: {
      sdCpp: ch('sdCpp'),
      piper: ch('piper'),
      llamaCpp: ch('llamaCpp'),
      design: { onRenderProgress: (cb: Sink) => { sinks.design.push(cb); return () => {} } },
      modelStorage: { onMigrateProgress: (cb: Sink) => { sinks.modelStorage.push(cb); return () => {} } },
    },
  }
}

describe('activityBridge: one listener per existing channel, for the life of the app', () => {
  it('a second install (a second mount, or HMR) does NOT double-subscribe', () => {
    const a = fakeSources()
    expect(bridge.installActivityBridge(a.api)).toBe(true)
    expect(bridge.installActivityBridge(a.api)).toBe(false)
    expect(a.sinks.sdCpp).toHaveLength(1)
    expect(a.sinks.design).toHaveLength(1)
    expect(a.sinks.modelStorage).toHaveLength(1)
  })

  it('a preload that is not ready yet stays uninstalled so the next mount retries', () => {
    expect(bridge.installActivityBridge({})).toBe(false)
    expect(bridge.installActivityBridge(fakeSources().api)).toBe(true)
  })

  it('the latch lives on the WINDOW too, so an HMR module swap cannot double-subscribe', () => {
    // A fresh module evaluation starts with `installed = false`; the flag the
    // previous one left on the global is what still says "already attached".
    const a = fakeSources()
    expect(bridge.installActivityBridge(a.api)).toBe(true)
    expect((globalThis as Record<string, unknown>).__tachiActivityBridgeInstalled).toBe(true)
    bridge.resetActivityBridge()
    expect((globalThis as Record<string, unknown>).__tachiActivityBridgeInstalled).toBe(false)
  })

  it('an engine install becomes a row and settles on `done`', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    a.sinks.sdCpp[0]({ stage: 'downloading-engine', message: 'sd-cli', percent: 42, bytes: 100, totalBytes: 400 })
    expect(tasks()[0]).toMatchObject({
      id: 'engine:sdcpp', kind: 'engine-install', label: 'stable-diffusion.cpp',
      percent: 42, status: 'running', surface: '/catalog',
    })
    expect(tasks()[0].bytes).toMatchObject({ received: 100, total: 400 })
    a.sinks.sdCpp[0]({ stage: 'done', message: 'installed', percent: 100 })
    expect(tasks()[0].status).toBe('completed')
  })

  it('an install ERROR becomes a failed row carrying the installer\'s own message', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    a.sinks.piper[0]({ stage: 'extracting', message: 'unpacking', percent: 80 })
    a.sinks.piper[0]({ stage: 'error', message: 'tar exited 2' })
    expect(tasks()[0]).toMatchObject({ id: 'engine:piper', status: 'failed', error: 'tar exited 2' })
  })

  it('bytes the DOWNLOAD MANAGER owns are suppressed — never drawn twice', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    a.sinks.sdCpp[0]({ stage: 'downloading-model', message: 'sd15', percent: 10 })
    a.sinks.sdCpp[0]({ stage: 'verifying', message: 'sha256', percent: 55 })  // mid-transfer tick
    expect(tasks()).toEqual([])
    a.sinks.sdCpp[0]({ stage: 'done', message: '', percent: 100 })            // suppression released
    a.sinks.sdCpp[0]({ stage: 'extracting', message: 'unpacking', percent: 5 })
    expect(tasks()).toHaveLength(1)
  })

  it('a design MP4 export gets a row with no cancel — the Remotion render has none', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    a.sinks.design[0]({ stage: 'rendering', message: 'frame 120/300', percent: 40 })
    expect(tasks()[0]).toMatchObject({
      id: 'design:render', kind: 'render', labelKey: 'activity.label.render',
      surface: '/design', cancel: null, percent: 40,
    })
  })

  it('a weights migration gets the one bridge row that CAN be stopped', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    a.sinks.modelStorage[0]({
      engine: 'sdcpp', phase: 'copy', filesDone: 3, filesTotal: 9,
      bytesDone: 500, bytesTotal: 1000, message: 'copying',
    })
    expect(tasks()[0]).toMatchObject({
      id: 'migrate:sdcpp', kind: 'migrate', label: 'sdcpp', percent: 50,
      surface: '/settings', cancel: { kind: 'migrate', engine: 'sdcpp' },
    })
    expect(tasks()[0].counts).toEqual({ done: 3, total: 9 })
    a.sinks.modelStorage[0]({ engine: 'sdcpp', phase: 'aborted', filesDone: 3, filesTotal: 9, bytesDone: 500, bytesTotal: 1000 })
    expect(tasks()[0].status).toBe('cancelled')
  })

  it('an unreadable event shape is a silent no-op, never a blank row', () => {
    const a = fakeSources()
    bridge.installActivityBridge(a.api)
    for (const junk of [null, undefined, 42, 'done', {}, { percent: 10 }]) a.sinks.sdCpp[0](junk)
    a.sinks.modelStorage[0]({ engine: 'sdcpp' })   // no phase
    expect(tasks()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 · THE RENDER LIST
// ═════════════════════════════════════════════════════════════════════════════

describe('activityRows: ordering, folding, and the idle collapse', () => {
  it('IDLE renders nothing at all — the rail has no chrome of its own', () => {
    expect(rows.buildActivityEntries({ run: run(), tasks: tasks() })).toEqual([])
    expect(rows.anyActivityInFlight({ run: run(), tasks: tasks() })).toBe(false)
  })

  it('the live generation leads, then tasks running-first / oldest-first', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    const s = useActivityStore.getState()
    s.progressTask('old', { kind: 'engine-install' })
    s.progressTask('new', { kind: 'render' })
    s.settleTask('old', { status: 'completed' }, 60_000)
    const ids = rows.buildActivityEntries({ run: run(), tasks: tasks() })
      .map(e => (e.type === 'row' ? e.row.id : 'dl'))
    expect(ids).toEqual(['media:generate', 'new', 'old'])
  })

  it('rows past the fold collapse behind "+N more" so the dock cannot eat the page', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ type: 'row' as const, row: { id: String(i) } as never }))
    expect(rows.splitEntries(entries, false).shown).toHaveLength(rows.ACTIVITY_MAX_VISIBLE)
    expect(rows.splitEntries(entries, false).hidden).toBe(7 - rows.ACTIVITY_MAX_VISIBLE)
    expect(rows.splitEntries(entries, true).hidden).toBe(0)
  })

  it('the in-flight lamp lights on any live row and goes dark on the last terminal one', () => {
    expect(rows.anyActivityInFlight({ downloadActive: true })).toBe(true)
    useMediaStore.getState().beginRun()
    expect(rows.anyActivityInFlight({ run: run() })).toBe(true)
    useMediaStore.getState().endRun()
    expect(rows.anyActivityInFlight({ run: run() })).toBe(false)
    useActivityStore.getState().progressTask('x', { kind: 'render' })
    expect(rows.anyActivityInFlight({ tasks: tasks() })).toBe(true)
    useActivityStore.getState().settleTask('x', { status: 'failed' })
    expect(rows.anyActivityInFlight({ tasks: tasks() })).toBe(false)
  })

  it('parseRunProgress refuses to invent a percent out of the engine\'s prose', () => {
    expect(rows.parseRunProgress('12/20')).toEqual({ percent: 60, counts: { done: 12, total: 20 } })
    expect(rows.parseRunProgress('48%')).toEqual({ percent: 48, counts: null })
    expect(rows.parseRunProgress('loading model')).toEqual({ percent: -1, counts: null })
    expect(rows.parseRunProgress(null)).toEqual({ percent: -1, counts: null })
  })

  it('the detail column prints a measurement or nothing — never a fake 0%', () => {
    expect(rows.formatRowDetail({ bytes: { received: 5 * 1_048_576, total: 20 * 1_048_576, speedBytesPerSec: 2 * 1_048_576 } }))
      .toBe('5.0/20 MB · 2.0 MB/s')
    expect(rows.formatRowDetail({ counts: { done: 3, total: 9 } })).toBe('3/9')
    expect(rows.formatRowDetail({})).toBe('')
  })

  it('elapsed is a wall clock, and a backwards clock reads 0:00 rather than a minus sign', () => {
    expect(rows.fmtElapsed(0)).toBe('0:00')
    expect(rows.fmtElapsed(42_000)).toBe('0:42')
    expect(rows.fmtElapsed(9 * 60_000 + 5_000)).toBe('9:05')
    expect(rows.fmtElapsed(3 * 3_600_000 + 4 * 60_000 + 9_000)).toBe('3:04:09')
    expect(rows.fmtElapsed(-1)).toBe('0:00')
    expect(rows.fmtElapsed(Number.NaN)).toBe('0:00')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 · THE RENDERER, ASSERTED AGAINST ITS SOURCE
// ═════════════════════════════════════════════════════════════════════════════

describe('ActivityStrip is mounted globally and behaves like the dock it lives in', () => {
  const strip = () => read('src/components/activity/ActivityStrip.tsx')

  it('is mounted in the console dock, which renders on EVERY route', () => {
    const dock = read('src/components/console/ConsoleDock.tsx')
    expect(dock).toContain("import { ActivityStrip } from '../activity/ActivityStrip'")
    expect(dock).toContain('<ActivityStrip />')
    // …and the dock itself is mounted once, in the app shell
    expect(read('src/components/layout/AppShell.tsx')).toContain('<ConsoleDock />')
  })

  it('installs the rail bridge from an effect with NO cleanup (it must outlive every page)', () => {
    expect(strip()).toContain('useEffect(() => { installActivityBridge() }, [])')
  })

  it('never calls confirm() — it freezes this renderer, and Stop must act immediately', () => {
    const src = strip()
    expect(src).not.toMatch(/(?:window\.)?confirm\s*\(/)
    expect(src).toContain('void runActivityCancel(row.cancel)')
  })

  it('renders nothing when nothing is running (collapsed-by-default when idle)', () => {
    expect(strip()).toContain('if (entries.length === 0) return null')
  })

  it('arms no interval unless a row is actually running', () => {
    const src = strip()
    const eff = src.slice(src.indexOf('  const [, setTick]'), src.indexOf('  // Drop a latch'))
    expect(eff).toContain('if (liveCount === 0) return')
    expect(eff).toContain('clearInterval')
  })

  it('draws NOTHING BAR-SHAPED for an unmeasured run', () => {
    // Driver-reported 2026-08-01: next to an honest "queued · Ns" the strip
    // drew a full-width bordered TRACK with a 100%-wide fill at low opacity.
    // Static, but it reads as a progress bar — and a bar nobody measured is a
    // lie about how far along the work is. Indeterminate rows now get a dashed
    // rule: same column width, no fill, no edge to misread.
    const src = strip()
    // the bordered track is reachable ONLY on the measured branch
    expect(src).toContain('pct >= 0 ? (')
    expect(src).toContain("borderTop: '1px dashed var(--border)'")
    // the old tell: a width that falls back to a full bar when unmeasured
    expect(src).not.toContain("width: pct >= 0 ? `${pct}%` : '100%'")
  })

  it('never prints the same measurement twice (the frozen-catalog-row defect, inverted)', () => {
    // The stage slot is gated on the pure inverse of the formatter that wrote
    // the phrase, so "14/20" is not shown next to the 70% it already produced.
    expect(strip()).toContain("parseRunProgress(row.stage).percent < 0")
    expect(rows.parseRunProgress('14/20').percent).toBe(70)
    expect(rows.parseRunProgress('loading model').percent).toBe(-1)
  })

  it('does not render download rows — DownloadStrip still owns them (no double-draw)', () => {
    expect(strip()).toContain('downloads: null')
    expect(read('src/components/console/ConsoleDock.tsx')).toContain('<DownloadStrip />')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 · i18n — every key the strip asks for exists in every shipped language
// ═════════════════════════════════════════════════════════════════════════════

const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

function commonNs(lang: string): Record<string, unknown> {
  return JSON.parse(read(`src/i18n/locales/${lang}/common.json`)) as Record<string, unknown>
}

function lookup(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

describe('i18n: the rail speaks all eight languages', () => {
  // Harvested from the component itself, so a new t('activity.x') added later
  // fails here until it is translated — the check cannot go stale.
  const asked = Array.from(
    new Set(
      [...read('src/components/activity/ActivityStrip.tsx').matchAll(/t\('(activity\.[a-zA-Z.]+)'/g)]
        .map(m => m[1]),
    ),
  ).sort()

  it('the strip asks for a non-trivial set of activity.* keys', () => {
    expect(asked.length).toBeGreaterThanOrEqual(8)
    expect(asked).toContain('activity.title')
    expect(asked).toContain('activity.stop')
    expect(asked).toContain('activity.stopping')
  })

  for (const lang of LANGS) {
    it(`${lang}: every key the strip asks for resolves to a non-empty string`, () => {
      const ns = commonNs(lang)
      for (const key of asked) {
        const v = lookup(ns, key)
        expect(typeof v, `${lang}/common.json missing ${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/common.json blank ${key}`).not.toBe('')
      }
    })

    it(`${lang}: every labelKey the DATA can carry is translated`, () => {
      const ns = commonNs(lang)
      // These are emitted by activityRows / activityBridge, not by the strip's
      // own t() calls, so they are asserted from the producers' side.
      for (const key of ['activity.label.generate', 'activity.label.render', 'activity.label.migrate', 'activity.label.rife']) {
        expect(typeof lookup(ns, key), `${lang}/common.json missing ${key}`).toBe('string')
      }
    })
  }

  it('every labelKey the producers emit is in the asserted set (no orphan keys)', () => {
    const emitted = new Set(
      [
        ...read('src/components/activity/activityRows.ts').matchAll(/labelKey: '([^']+)'/g),
        ...read('src/components/activity/activityBridge.ts').matchAll(/labelKey: '([^']+)'/g),
      ].map(m => m[1]),
    )
    expect([...emitted].sort()).toEqual([
      'activity.label.generate', 'activity.label.migrate', 'activity.label.render',
      // rife = the frame-interpolation RUN row (routeRifeRunEvent). It reuses
      // the 'render' KIND but needs its own name: "Video export" would be a lie
      // about what is holding the GPU.
      'activity.label.rife',
    ])
  })
})
