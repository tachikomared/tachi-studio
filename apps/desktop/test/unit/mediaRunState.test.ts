// apps/desktop/test/unit/mediaRunState.test.ts
//
// A RENDER THAT IS RUNNING LOOKS LIKE IT IS RUNNING — FROM ANY TAB.
//
// Driver finding (owner, live): a local Wan render was started on the MEDIA
// tab, the owner navigated away and came back, and the composer showed an idle
// GENERATE button — while sd-cli was still pinning the GPU at 95%. Nothing had
// failed. React unmounted MediaPage, threw away its `busy` / `progress` /
// `genError` useState, and dropped the 'sd-cpp:gen-progress' subscription with
// it; the render itself never noticed and kept going for another hour.
//
// The fix is a HOME that outlives the component, not a poll:
//   • the in-flight run lives in media.store's `run` slice (NOT persisted — a
//     render dies with the app, so a restored `busy:true` would offer to Stop a
//     process that no longer exists);
//   • the progress listener lives in a module (mediaProgressBridge) that is
//     installed once and never torn down.
//
// Pinned here: every transition of that slice, the fact that a tick lands with
// NOTHING mounted, that the completion path (the gallery push) survives the
// same way, and that none of it is written to localStorage.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// --- in-memory localStorage shim, installed BEFORE the store is imported -----
// (the idiom catalogStore.test.ts uses; the store persists through zustand)
const ls = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}
;(globalThis as unknown as { localStorage: typeof localStorageShim }).localStorage = localStorageShim

type StoreMod  = typeof import('../../src/store/media.store')
type BridgeMod = typeof import('../../src/pages/media/mediaProgressBridge')
let useMediaStore: StoreMod['useMediaStore']
let bridge: BridgeMod

beforeAll(async () => {
  ;({ useMediaStore } = await import('../../src/store/media.store'))
  bridge = await import('../../src/pages/media/mediaProgressBridge')
})

// `stoppedByUser` latches with `stopping` but SURVIVES the run settling, so the
// inline failure row can still tell a user's Stop from a crash after failRun
// cleared `stopping` (mediaStopInlineRow.test.ts owns that behaviour).
const IDLE = { busy: false, progress: null, error: null, stopping: false, stoppedByUser: false, cancellable: false, preview: null }

beforeEach(() => {
  useMediaStore.setState({ run: { ...IDLE }, gallery: [] })
  ls.clear()
  bridge.resetMediaProgressBridge()
})

const run = () => useMediaStore.getState().run

describe('the run slice: every transition the Generate button reads', () => {
  it('beginRun goes busy and CLEARS the previous failure', () => {
    useMediaStore.getState().failRun('sd-cli exited 1.')
    expect(run().error).toBe('sd-cli exited 1.')
    useMediaStore.getState().beginRun({ cancellable: true })
    // …including `stoppedByUser`, which is scoped to ONE run: it deliberately
    // outlives failRun so the inline row can read it, so beginRun is the only
    // thing that clears it and a stop must never tint the next run's failure.
    // `preview` is in the reset too: a latent frame from the last run must not
    // be on screen while the next one starts.
    expect(run()).toEqual({ busy: true, progress: null, error: null, stopping: false, stoppedByUser: false, cancellable: true, preview: null })
  })

  it('setRunPreview records a frame while busy, and ignores one after the run settled', () => {
    const frame = 'data:image/png;base64,AAA'
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().setRunPreview(frame)
    expect(run().preview).toBe(frame)

    // Frames are STICKY within a run: they arrive every few sampler steps, so a
    // slot that emptied between them would flicker.
    useMediaStore.getState().setRunProgress('7/20')
    expect(run().preview).toBe(frame)

    // …and a frame decoded just before the run settled must not repaint over
    // the finished image.
    useMediaStore.getState().endRun()
    useMediaStore.getState().setRunPreview('data:image/png;base64,BBB')
    expect(run().preview).toBe(frame)

    // The next run starts clean.
    useMediaStore.getState().beginRun()
    expect(run().preview).toBeNull()
  })

  it('only a LOCAL render advertises itself as cancellable', () => {
    useMediaStore.getState().beginRun()                       // cloud job: no child to kill
    expect(run().cancellable).toBe(false)
    useMediaStore.getState().beginRun({ cancellable: true })
    expect(run().cancellable).toBe(true)
  })

  it('setRunProgress records the live line while busy', () => {
    useMediaStore.getState().beginRun()
    useMediaStore.getState().setRunProgress('12/20')
    expect(run().progress).toBe('12/20')
  })

  it('…and IGNORES a tick that lands after the run settled (stale heartbeat)', () => {
    useMediaStore.getState().beginRun()
    useMediaStore.getState().endRun()
    useMediaStore.getState().setRunProgress('19/20')
    expect(run().progress).toBeNull()
    expect(run().busy).toBe(false)
  })

  it('failRun keeps the message and drops busy/stopping/progress in ONE write', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().setRunProgress('7/20')
    useMediaStore.getState().markRunStopping()
    useMediaStore.getState().failRun('sd-cli vid_gen was stopped before it finished.')
    // the row and the button can never disagree after a remount
    expect(run().busy).toBe(false)
    expect(run().stopping).toBe(false)
    expect(run().progress).toBeNull()
    expect(run().error).toBe('sd-cli vid_gen was stopped before it finished.')
  })

  it('endRun leaves an undismissed failure alone (success does not erase history)', () => {
    useMediaStore.getState().failRun('boom')
    useMediaStore.getState().beginRun()
    useMediaStore.setState({ run: { ...run(), error: 'boom' } })  // an older, undismissed one
    useMediaStore.getState().endRun()
    expect(run().error).toBe('boom')
    expect(run().busy).toBe(false)
  })

  it('markRunStopping latches only while busy — never on an idle composer', () => {
    useMediaStore.getState().markRunStopping()
    expect(run().stopping).toBe(false)
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().markRunStopping()
    expect(run().stopping).toBe(true)
  })

  it('clearRunError dismisses the row without touching the run', () => {
    useMediaStore.getState().beginRun()
    useMediaStore.setState({ run: { ...run(), error: 'old' } })
    useMediaStore.getState().clearRunError()
    expect(run().error).toBeNull()
    expect(run().busy).toBe(true)
  })
})

describe('THE BUG: the live run survives the page being unmounted', () => {
  it('a progress tick lands with NOTHING mounted, and the state is there on return', () => {
    // "MediaPage mounts" — the bridge is installed from its effect…
    const off = vi.fn()
    const sent: Array<(p: { step: number | null; total: number | null; percent: number; message: string; heartbeat: boolean }) => void> = []
    bridge.installMediaProgressBridge({
      sdCpp: { onGenProgress: cb => { sent.push(cb); return off } },
    })
    useMediaStore.getState().beginRun({ cancellable: true })

    // …"the owner switches tabs": the component is gone. The listener is not.
    expect(off).not.toHaveBeenCalled()
    sent[0]({ step: 14, total: 20, percent: 70, message: '', heartbeat: false })

    // …"and comes back": the composer re-reads a run that never stopped.
    expect(run().busy).toBe(true)
    expect(run().progress).toBe('14/20')
    expect(run().cancellable).toBe(true)
  })

  it('the COMPLETION path survives it too — the gallery push needs no component', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    // the promise resolves long after the page unmounted
    useMediaStore.getState().addEntry({
      id: 'e1', model: 'wan21-t2v-1.3b', modality: 'video', prompt: 'a cat',
      artifacts: [{ kind: 'video', mimeType: 'video/webm', path: 'C:/out/x.webm' } as never],
      createdAt: 1,
    })
    useMediaStore.getState().endRun()
    expect(useMediaStore.getState().gallery).toHaveLength(1)
    expect(run().busy).toBe(false)
  })

  it('the FAILURE is still on screen when the owner comes back to look', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().failRun('sd-cli vid_gen was killed (SIGKILL) before it finished.')
    expect(run().error).toContain('killed (SIGKILL)')
  })
})

describe('the run slice is NOT persisted — a restart has no render to show', () => {
  it('nothing about the in-flight run reaches localStorage', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().setRunProgress('3/20')
    useMediaStore.getState().failRun('boom')
    const raw = ls.get('tachi-media-v1')
    if (raw) {
      const persisted = JSON.parse(raw) as { state?: Record<string, unknown> }
      expect(Object.keys(persisted.state ?? {})).not.toContain('run')
      expect(raw).not.toContain('boom')
    }
    // …and the partialize list is the reason (source of truth for the above)
    const src = read('src/store/media.store.ts')
    const part = src.slice(src.indexOf('partialize:'))
    expect(part).not.toContain('run:')
  })
})

describe('formatSdProgress — one line, best available detail', () => {
  it('steps beat percent beat the engine message', () => {
    const f = bridge.formatSdProgress
    expect(f({ step: 3, total: 20, percent: 15, message: 'x', heartbeat: false })).toBe('3/20')
    expect(f({ step: null, total: null, percent: 48, message: 'x', heartbeat: false })).toBe('48%')
    expect(f({ step: null, total: null, percent: -1, message: 'loading model', heartbeat: true })).toBe('loading model')
    expect(f({ step: null, total: null, percent: -1, message: '', heartbeat: true })).toBe('…')
    // step 0 of 20 is real progress, not a falsy hole
    expect(f({ step: 0, total: 20, percent: 0, message: '', heartbeat: false })).toBe('0/20')
  })
})

describe('the progress bridge is installed ONCE and never torn down', () => {
  it('a second install (a second mount) does not add a second listener', () => {
    const onGenProgress = vi.fn(() => () => {})
    expect(bridge.installMediaProgressBridge({ sdCpp: { onGenProgress } })).toBe(true)
    expect(bridge.installMediaProgressBridge({ sdCpp: { onGenProgress } })).toBe(false)
    expect(onGenProgress).toHaveBeenCalledTimes(1)
  })

  it('a preload that is not ready yet is retried on the next mount', () => {
    expect(bridge.installMediaProgressBridge({})).toBe(false)
    expect(bridge.installMediaProgressBridge({ sdCpp: { onGenProgress: () => () => {} } })).toBe(true)
  })

  it('the imgnAI poll ticks land too, and a stale preload without it is a no-op', () => {
    const imgnaiCbs: Array<(p: { status: string; elapsedSec: number }) => void> = []
    bridge.installMediaProgressBridge({
      sdCpp: { onGenProgress: () => () => {} },
      imgnaiMedia: { onGenProgress: cb => { imgnaiCbs.push(cb); return () => {} } },
    })
    useMediaStore.getState().beginRun()
    imgnaiCbs[0]({ status: 'queued', elapsedSec: 12 })
    expect(run().progress).toBe('queued · 12s')

    bridge.resetMediaProgressBridge()
    expect(() => bridge.installMediaProgressBridge({ sdCpp: { onGenProgress: () => () => {} } })).not.toThrow()
  })
})

describe('MediaPage reads the run from the STORE, not from its own useState', () => {
  const page = () => read('src/pages/media/MediaPage.tsx')

  it('the three fields that vanished on unmount are gone from component state', () => {
    const src = page()
    expect(src).not.toContain('const [busy, setBusy]')
    expect(src).not.toContain('const [progress, setProgress]')
    expect(src).not.toContain('const [genError, setGenError]')
    // …and are read off the slice instead
    expect(src).toContain('const run             = useMediaStore(s => s.run)')
    expect(src).toContain('const busy     = run.busy')
    expect(src).toContain('const progress = run.progress')
    expect(src).toContain('const genError = run.error')
  })

  it('the progress subscription no longer dies with the component', () => {
    const src = page()
    // the effect installs the module bridge and returns NO cleanup
    expect(src).toContain('useEffect(() => { installMediaProgressBridge() }, [])')
    // the old per-component subscriptions are gone
    expect(src).not.toContain('window.tachi.sdCpp.onGenProgress((p) => {')
    expect(src).not.toContain('window.tachi.imgnaiMedia?.onGenProgress?.((p) => {')
  })

  it('generate() drives the run through the store on every exit', () => {
    const src = page()
    const body = src.slice(src.indexOf('  const generate = async () => {'), src.indexOf('const pushEntry ='))
    expect(body).toContain('beginRun({ cancellable:')
    expect(body).toContain('failRun(text)')
    expect(body).toContain('if (useMediaStore.getState().run.busy) endRun()')
  })
})
