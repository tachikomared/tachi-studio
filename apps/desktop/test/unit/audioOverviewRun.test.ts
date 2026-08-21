// apps/desktop/test/unit/audioOverviewRun.test.ts
//
// THE ONE OPERATION THE APP ACTIVELY KILLED WHEN YOU LOOKED AWAY.
//
// Every other long op in this app merely LOST its progress on navigation (the
// incident the activity rail was built for). The ~96-second audio overview was
// worse: `AudioOverviewPanel` set `cancelledRef.current = true` from its unmount
// effect and the pipeline checked that ref at four points, so switching sub-tabs
// aborted a render that had already spent a minute of local LLM + TTS time — and
// the only artifact it ever produced was a blob URL the same effect revoked.
//
// The fix has the same shape as media.store's `run` slice: the run lives in a
// module-scoped store, the pipeline lives in a module-scoped runner, and the
// panel is a VIEW over both. This file pins the seam:
//
//   • audioOverview.store  — the run state a remount re-attaches to
//   • audioOverviewRun     — the pipeline, the rail row, the auto-save, the
//                            settle announcement
//   • activityCancel       — the rail's Stop, which must reach a renderer-local
//                            run with no IPC at all
//
// vitest runs `environment: 'node'` with no testing-library, so the panel itself
// is asserted against its SOURCE (the idiom activityRail.test.ts already uses).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AudioOverviewRunDeps } from '../../src/pages/media/audioOverviewRun'
import { isRawScriptFailurePayload, hasUsableScriptModel } from '../../src/pages/media/audioOverviewHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// --- in-memory localStorage shim, installed BEFORE media.store is imported ---
// (activityCancel imports media.store, which persists through localStorage.)
const ls = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}

type StoreMod    = typeof import('../../src/store/audioOverview.store')
type RunMod      = typeof import('../../src/pages/media/audioOverviewRun')
type ActivityMod = typeof import('../../src/store/activity.store')
type CancelMod   = typeof import('../../src/components/activity/activityCancel')
type NotifyMod   = typeof import('../../src/components/activity/activityNotify')

let store: StoreMod
let runner: RunMod
let activity: ActivityMod
let cancelMod: CancelMod
let notifyMod: NotifyMod

beforeAll(async () => {
  store     = await import('../../src/store/audioOverview.store')
  runner    = await import('../../src/pages/media/audioOverviewRun')
  activity  = await import('../../src/store/activity.store')
  cancelMod = await import('../../src/components/activity/activityCancel')
  notifyMod = await import('../../src/components/activity/activityNotify')
})

beforeEach(() => {
  store.useAudioOverviewStore.getState().resetRun()
  activity.useActivityStore.getState().resetTasks()
  runner.resetAudioOverviewRunner()
  ls.clear()
})

const runState = () => store.useAudioOverviewStore.getState()
const tasks    = () => activity.useActivityStore.getState().tasks
const row      = () => tasks().find(t => t.id === runner.AUDIO_OVERVIEW_TASK_ID)

// ── fixtures ─────────────────────────────────────────────────────────────────

const SCRIPT_JSON = JSON.stringify({
  title: 'Solar power',
  turns: [
    { host: 'A', text: 'Welcome to the show.' },
    { host: 'B', text: 'Glad to be here.' },
    { host: 'A', text: 'That is all we have time for.' },
  ],
})

const INPUT = {
  source: 'Notes about solar panels and grid storage.',
  title: 'Solar power',
  length: 'short' as const,
  voiceA: 'kokoro:af_heart',
  voiceB: 'piper:en_US-amy',
}

function deferred<T>() {
  let settle!: (v: T) => void
  const promise = new Promise<T>(r => { settle = r })
  return { promise, settle }
}

/** Drain every pending microtask — a macrotask boundary, so the pipeline runs
 *  as far as its next REAL await (the gate) without counting `.then` hops. */
const flush = () => new Promise<void>(r => { setTimeout(r, 0) })

/** One second of mono audio per turn, so the stitched duration is predictable. */
function fakeDeps(over: Partial<AudioOverviewRunDeps> = {}) {
  return {
    ask:        vi.fn(async () => ({ ok: true, text: SCRIPT_JSON })),
    synthesize: vi.fn(async () => ({ ok: true, b64: 'UklGRg==' })),
    decode:     vi.fn(async (b64s: readonly string[]) => b64s.map(() => new Float32Array(44_100))),
    saveWav:    vi.fn(async () => ({ ok: true, path: 'C:/Tachi/Media/kokoro/Solar-power.wav' })),
    makeUrl:    vi.fn(() => 'blob:audio-overview-1'),
    revokeUrl:  vi.fn(),
    now:        () => Date.now(),
    notify:     vi.fn(() => ({ sent: true })),
    ...over,
  } as unknown as AudioOverviewRunDeps & Record<string, ReturnType<typeof vi.fn>>
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE RUN OUTLIVES THE PANEL
// ═════════════════════════════════════════════════════════════════════════════

describe('THE INCIDENT: navigating away no longer kills the podcast render', () => {
  const panel = () => read('src/pages/media/AudioOverviewPanel.tsx')

  it('the panel no longer arms an unmount kill, and no longer revokes the result', () => {
    const src = panel()
    expect(src).not.toMatch(/cancelledRef/)
    expect(src).not.toMatch(/revokeObjectURL/)
  })

  it('the panel owns no pipeline of its own — every IPC leg moved to the runner', () => {
    const src = panel()
    expect(src).not.toMatch(/quickask\.ask/)
    expect(src).not.toMatch(/OfflineAudioContext/)
    expect(src).toContain('startAudioOverviewRun')
    expect(src).toContain('cancelAudioOverviewRun')
  })

  it('a run nobody is watching still finishes, saves, and settles', async () => {
    const deps = fakeDeps()
    const out = await runner.startAudioOverviewRun(INPUT, deps)

    expect(out.started).toBe(true)
    expect(runState().stage).toBe('ready')
    expect(deps.saveWav).toHaveBeenCalledTimes(1)
    expect(runState().result?.path).toBe('C:/Tachi/Media/kokoro/Solar-power.wav')
  })

  it('a second start while one is in flight is refused, never a parallel render', async () => {
    const gate = deferred<{ ok: boolean; text?: string }>()
    const first = runner.startAudioOverviewRun(INPUT, fakeDeps({ ask: vi.fn(() => gate.promise) }))
    const second = await runner.startAudioOverviewRun(INPUT, fakeDeps())
    expect(second).toEqual({ started: false, reason: 'busy' })
    gate.settle({ ok: true, text: SCRIPT_JSON })
    await first
  })

  it('an empty source or a missing voice is refused with a reason, not a half-run', async () => {
    expect(await runner.startAudioOverviewRun({ ...INPUT, source: '   ' }, fakeDeps()))
      .toEqual({ started: false, reason: 'empty-source' })
    expect(await runner.startAudioOverviewRun({ ...INPUT, voiceB: '' }, fakeDeps()))
      .toEqual({ started: false, reason: 'no-voices' })
    expect(runState().stage).toBe('idle')
    expect(tasks()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE RAIL ROW
// ═════════════════════════════════════════════════════════════════════════════

describe('the run is a rail row, visible and stoppable from any tab', () => {
  it('opens with a real cancel, a surface to jump to, and its own name', async () => {
    const gate = deferred<{ ok: boolean; text?: string }>()
    const p = runner.startAudioOverviewRun(INPUT, fakeDeps({ ask: vi.fn(() => gate.promise) }))

    // The row exists while the script is still being drafted — the rail is not
    // waiting for the first measurable number to admit it.
    expect(row()).toMatchObject({
      kind: 'generate',
      labelKey: 'activity.label.audioOverview',
      surface: '/media',
      status: 'running',
      cancel: { kind: 'audio-overview' },
    })
    // Honesty clause 3: nothing has been measured yet.
    expect(row()!.percent).toBe(-1)

    gate.settle({ ok: true, text: SCRIPT_JSON })
    await p
  })

  it('advances on COMPLETED turns — the count is a measurement, not an intention', async () => {
    const seen: Array<{ done: number; total: number } | undefined> = []
    const gate = deferred<{ ok: boolean; b64?: string }>()
    let call = 0
    const synthesize = vi.fn(() => {
      seen.push(row()?.counts)
      call += 1
      return call === 2 ? gate.promise : Promise.resolve({ ok: true, b64: 'UklGRg==' })
    })
    const p = runner.startAudioOverviewRun(INPUT, fakeDeps({ synthesize }))
    await flush()

    // Parked on turn 2 of 3: one turn is DONE.
    expect(runState().stage).toBe('synthesizing')
    expect(runState().progress).toEqual({ n: 2, m: 3 })
    expect(row()!.counts).toEqual({ done: 1, total: 3 })
    expect(row()!.percent).toBe(33)
    expect(seen[0]).toEqual({ done: 0, total: 3 })

    gate.settle({ ok: true, b64: 'UklGRg==' })
    await p
    expect(row()!.status).toBe('completed')
    expect(row()!.percent).toBe(100)
  })

  it('a synth failure settles the row with the ENGINE\'s own words, and the panel keeps the retry', async () => {
    const deps = fakeDeps({ synthesize: vi.fn(async () => ({ ok: false, error: 'piper exited 3' })) })
    await runner.startAudioOverviewRun(INPUT, deps)

    expect(row()).toMatchObject({ status: 'failed' })
    expect(row()!.error).toContain('piper exited 3')
    expect(runState().stage).toBe('error')
    expect(runState().error?.stage).toBe('synth')
    expect(runState().error?.message).toContain('piper exited 3')
    // The parsed script survives the failure so Retry can reuse it (the panel's
    // existing contract) — even though the panel that started it may be gone.
    expect(runState().script?.turns).toHaveLength(3)
  })

  it('a retry that reuses a parsed script never claims to be drafting one', async () => {
    const gate = deferred<{ ok: boolean; b64?: string }>()
    const deps = fakeDeps({ ask: vi.fn(), synthesize: vi.fn(() => gate.promise) })
    const script = {
      title: 'Solar power',
      turns: [{ host: 'A' as const, text: 'One.' }, { host: 'B' as const, text: 'Two.' }],
    }
    const p = runner.startAudioOverviewRun({ ...INPUT, script }, deps)
    await flush()

    expect(deps.ask).not.toHaveBeenCalled()          // the LLM leg is skipped
    expect(runState().stage).toBe('synthesizing')
    expect(row()!.stage).toContain('1/2')            // …and the rail says so too

    gate.settle({ ok: true, b64: 'UklGRg==' })
    await p
  })

  it('a settled row carries no stale stage phrase beside its verdict', async () => {
    await runner.startAudioOverviewRun(INPUT, fakeDeps())
    expect(row()).toMatchObject({ status: 'completed', stage: '', percent: 100 })
  })

  it('the settle announces itself through the notify seam', async () => {
    const deps = fakeDeps()
    await runner.startAudioOverviewRun(INPUT, deps)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ kind: 'audio-overview', status: 'completed' })
    expect(deps.notify.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('a failure announces the producer\'s reason, never a rewrite of it', async () => {
    const deps = fakeDeps({ synthesize: vi.fn(async () => ({ ok: false, error: 'piper exited 3' })) })
    await runner.startAudioOverviewRun(INPUT, deps)
    const notice = deps.notify.mock.calls[0][0]
    expect(notice.status).toBe('failed')
    expect(notice.detail).toContain('piper exited 3')
  })

  it('the notify seam ADMITS the new kind (a kind with no copy line says nothing)', () => {
    const done = notifyMod.formatSettleNotice({ kind: 'audio-overview', status: 'completed', elapsedMs: 96_000 })
    expect(done?.title).toBeTruthy()
    expect(done?.body).toContain('1:36')
    const failed = notifyMod.formatSettleNotice({ kind: 'audio-overview', status: 'failed', detail: 'piper exited 3' })
    expect(failed?.title).toBeTruthy()
    expect(failed?.body).toBe('piper exited 3')
    // A cancel is the user's own decision — still nothing to say.
    expect(notifyMod.formatSettleNotice({ kind: 'audio-overview', status: 'cancelled' })).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · STOP
// ═════════════════════════════════════════════════════════════════════════════

describe('STOP reaches a renderer-local run from the rail, with no IPC at all', () => {
  it('the dispatcher stops it without any window.tachi bridge', async () => {
    const gate = deferred<{ ok: boolean; b64?: string }>()
    let call = 0
    const p = runner.startAudioOverviewRun(INPUT, fakeDeps({
      synthesize: vi.fn(() => { call += 1; return call === 2 ? gate.promise : Promise.resolve({ ok: true, b64: 'UklGRg==' }) }),
    }))
    await flush()

    const out = await cancelMod.runActivityCancel({ kind: 'audio-overview' }, {})
    expect(out).toEqual({ ok: true, kind: 'audio-overview' })
    // The latch is instant — the button cannot be pressed twice.
    expect(runState().stopping).toBe(true)

    gate.settle({ ok: true, b64: 'UklGRg==' })
    await p
    expect(runState().stage).toBe('idle')
    expect(runState().result).toBeNull()
    expect(row()!.status).toBe('cancelled')
  })

  it('a stopped run produces no file and says nothing (they pressed the button)', async () => {
    const gate = deferred<{ ok: boolean; text?: string }>()
    const deps = fakeDeps({ ask: vi.fn(() => gate.promise) })
    const p = runner.startAudioOverviewRun(INPUT, deps)
    runner.cancelAudioOverviewRun()
    gate.settle({ ok: true, text: SCRIPT_JSON })
    await p

    expect(deps.saveWav).not.toHaveBeenCalled()
    expect(runState().stage).toBe('idle')
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ status: 'cancelled' })
  })

  it('a late reply from a stopped run cannot write over the run that replaced it', async () => {
    const gate = deferred<{ ok: boolean; text?: string }>()
    const stale = runner.startAudioOverviewRun(INPUT, fakeDeps({ ask: vi.fn(() => gate.promise) }))
    runner.cancelAudioOverviewRun()
    gate.settle({ ok: true, text: SCRIPT_JSON })
    await stale

    // A fresh run starts and finishes…
    await runner.startAudioOverviewRun({ ...INPUT, title: 'Second' }, fakeDeps({
      saveWav: vi.fn(async () => ({ ok: true, path: 'C:/Tachi/Media/kokoro/Second.wav' })),
    }))
    expect(runState().stage).toBe('ready')
    expect(runState().result?.path).toBe('C:/Tachi/Media/kokoro/Second.wav')
  })

  it('a stale run\'s unwind cannot settle the row a newer run owns', async () => {
    const gate = deferred<{ ok: boolean; text?: string }>()
    const deps = fakeDeps({ ask: vi.fn(() => gate.promise) })
    const p = runner.startAudioOverviewRun(INPUT, deps)
    runner.cancelAudioOverviewRun()

    // Something else takes the slice over while the stopped run is still
    // unwinding — the row and the OS toast are keyed on the OPERATION, not on
    // the run, so this is the one thing that could cross the two.
    store.useAudioOverviewStore.getState().beginRun({ ...INPUT, title: 'Second' })
    activity.useActivityStore.getState().progressTask(runner.AUDIO_OVERVIEW_TASK_ID, {
      kind: 'generate', stage: 'drafting script…', percent: -1,
    })

    gate.settle({ ok: true, text: SCRIPT_JSON })
    await p

    expect(row()!.status).toBe('running')     // the newer run's row is untouched
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('the stop is a no-op when nothing is running (a stale rail click)', () => {
    expect(() => runner.cancelAudioOverviewRun()).not.toThrow()
    expect(runState().stopping).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 · SAVE ON COMPLETE — the blob becomes a real file
// ═════════════════════════════════════════════════════════════════════════════

describe('the result is a file on disk, not a URL that dies with the page', () => {
  it('saves the stitched WAV under a name taken from the script title', async () => {
    const deps = fakeDeps()
    await runner.startAudioOverviewRun(INPUT, deps)

    const arg = deps.saveWav.mock.calls[0][0] as { b64: string; name: string }
    expect(arg.name).toBe('Solar-power.wav')
    // A real RIFF/WAVE payload, not the raw turn bytes.
    const bytes = Buffer.from(arg.b64, 'base64')
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
    expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
    // 3 one-second turns + 2 × 350 ms gaps.
    expect(runState().result?.durationSec).toBe(4)
    expect(runState().result?.turns).toBe(3)
    expect(runState().result?.url).toBe('blob:audio-overview-1')
    expect(runState().result?.saveError).toBeNull()
  })

  it('a FAILED save does not throw the audio away — the run is ready, the loss is named', async () => {
    const deps = fakeDeps({ saveWav: vi.fn(async () => ({ ok: false, error: 'disk full' })) })
    await runner.startAudioOverviewRun(INPUT, deps)

    expect(runState().stage).toBe('ready')
    expect(runState().result?.path).toBeNull()
    expect(runState().result?.saveError).toContain('disk full')
    expect(runState().result?.url).toBe('blob:audio-overview-1')
    expect(row()!.status).toBe('completed')   // the podcast exists; only the file does not
  })

  it('no saveWav surface at all ⇒ blob only, and never an invented path', async () => {
    const deps = fakeDeps({ saveWav: null })
    await runner.startAudioOverviewRun(INPUT, deps)
    expect(runState().result?.path).toBeNull()
    expect(runState().result?.url).toBe('blob:audio-overview-1')
    expect(runState().stage).toBe('ready')
  })

  it('a failed save is retried from the held bytes — the podcast is not made twice', async () => {
    const failing = fakeDeps({ saveWav: vi.fn(async () => ({ ok: false, error: 'disk full' })) })
    await runner.startAudioOverviewRun(INPUT, failing)
    expect(runState().result?.path).toBeNull()

    const saveWav = vi.fn(async () => ({ ok: true, path: 'C:/Tachi/Media/kokoro/Solar-power.wav' }))
    expect(await runner.saveAudioOverviewFile({ saveWav }))
      .toEqual({ ok: true, path: 'C:/Tachi/Media/kokoro/Solar-power.wav' })

    // The expensive legs ran exactly once — a retry writes a file, nothing more.
    expect(failing.ask).toHaveBeenCalledTimes(1)
    expect(failing.synthesize).toHaveBeenCalledTimes(3)
    expect(runState().result?.path).toBe('C:/Tachi/Media/kokoro/Solar-power.wav')
    expect(runState().result?.saveError).toBeNull()
  })

  it('a save retry with nothing held is a no-op, never an invented file', async () => {
    const saveWav = vi.fn(async () => ({ ok: true, path: 'C:/nope.wav' }))
    expect(await runner.saveAudioOverviewFile({ saveWav })).toEqual({ ok: false })
    expect(saveWav).not.toHaveBeenCalled()
  })

  it('a new run revokes the PREVIOUS blob — the only place a revoke is allowed', async () => {
    const deps = fakeDeps()
    await runner.startAudioOverviewRun(INPUT, deps)
    expect(deps.revokeUrl).not.toHaveBeenCalled()
    await runner.startAudioOverviewRun(INPUT, { ...deps, makeUrl: vi.fn(() => 'blob:audio-overview-2') })
    expect(deps.revokeUrl).toHaveBeenCalledWith('blob:audio-overview-1')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 · RE-ATTACH — a remounted panel reads the live run out of the store
// ═════════════════════════════════════════════════════════════════════════════

describe('a remounted panel re-attaches to the run in flight', () => {
  it('mid-run: progress, script, stop and the input are all readable from the store', async () => {
    const gate = deferred<{ ok: boolean; b64?: string }>()
    let call = 0
    const p = runner.startAudioOverviewRun(INPUT, fakeDeps({
      synthesize: vi.fn(() => { call += 1; return call === 2 ? gate.promise : Promise.resolve({ ok: true, b64: 'UklGRg==' }) }),
    }))
    await flush()

    // Everything a fresh mount needs to paint the working state:
    const s = runState()
    expect(store.isAudioOverviewBusy(s)).toBe(true)
    expect(s.stage).toBe('synthesizing')
    expect(s.progress).toEqual({ n: 2, m: 3 })
    expect(s.script?.title).toBe('Solar power')
    expect(s.stopping).toBe(false)
    // …and the INPUT, so Retry works from a panel that never saw the first click.
    expect(s.input).toMatchObject({ source: INPUT.source, voiceA: INPUT.voiceA, voiceB: INPUT.voiceB })

    gate.settle({ ok: true, b64: 'UklGRg==' })
    await p
  })

  it('settled: the whole result is in the store, so the player survives a remount', async () => {
    await runner.startAudioOverviewRun(INPUT, fakeDeps())
    const s = runState()
    expect(store.isAudioOverviewBusy(s)).toBe(false)
    expect(s.stage).toBe('ready')
    expect(s.result).toMatchObject({
      path: 'C:/Tachi/Media/kokoro/Solar-power.wav',
      url: 'blob:audio-overview-1',
      turns: 3,
      title: 'Solar power',
    })
    expect(s.script?.turns).toHaveLength(3)
  })

  it('the panel renders the run from the store, holding no run state of its own', () => {
    const src = read('src/pages/media/AudioOverviewPanel.tsx')
    expect(src).toContain('useAudioOverviewStore')
    expect(src).not.toMatch(/useState<Stage>/)
    expect(src).not.toMatch(/setStage\(/)
  })

  it('the media tab opens on Audio Overview while a run is in flight', () => {
    expect(read('src/pages/media/MediaTabbed.tsx')).toContain('isAudioOverviewBusy')
  })

  it('the run slice is NOT persisted — a restart must not restore a dead render', () => {
    const src = read('src/store/audioOverview.store.ts')
    expect(src).not.toMatch(/persist\(/)
    expect(src).not.toMatch(/localStorage/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 · i18n — every new key exists in all eight shipped languages
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

describe('i18n: the new row, its stage phrases and its toast speak every language', () => {
  const KEYS = [
    'activity.label.audioOverview',
    'activity.notify.audioOverviewReady',
    'activity.notify.audioOverviewFailed',
    'audioOverview.stage.script',
    'audioOverview.stage.voices',
    'audioOverview.stage.mix',
    'audioOverview.stage.saving',
    'audioOverview.saved',
    'audioOverview.reveal',
    'audioOverview.saveFailed',
  ]

  for (const lang of LANGS) {
    it(`${lang}: every key resolves to a non-empty string`, () => {
      const ns = commonNs(lang)
      for (const key of KEYS) {
        const v = lookup(ns, key)
        expect(typeof v, `${lang}/common.json missing ${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/common.json blank ${key}`).not.toBe('')
      }
    })
  }

  it('the voices phrase keeps its {{n}}/{{m}} placeholders in every language', () => {
    for (const lang of LANGS) {
      const v = lookup(commonNs(lang), 'audioOverview.stage.voices') as string
      expect(v, `${lang} lost a placeholder`).toContain('{{n}}')
      expect(v, `${lang} lost a placeholder`).toContain('{{m}}')
    }
  })

  it('the localized copy is registered from the panel, so the rail speaks the UI language', () => {
    expect(read('src/pages/media/AudioOverviewPanel.tsx')).toContain('setAudioOverviewCopy')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7 · A FAILED SCRIPT DRAFT NEVER PRINTS THE ROUTER'S OWN JSON
//     (Driver Checkpoint A, finding 1)
// ═════════════════════════════════════════════════════════════════════════════
//
// quick-ask's only route back from a router that is UP and failing is its raw
// HTTP error text ("router 502: {...}") — the WHOLE provider chain (a dozen
// free-tier names, one of them 401ing) landing verbatim in the panel AND the
// rail, on a fresh install, in the same box that promised "the local keyless
// model". The producer's-own-words rule stands for anything that IS a
// sentence (piper/sd-cli exit lines, the router-not-running line) — only a
// raw wire payload gets mapped, and the raw text still reaches the console.

describe('isRawScriptFailurePayload: a wire payload is not a sentence', () => {
  it('flags the router\'s own HTTP error text', () => {
    expect(isRawScriptFailurePayload(
      'router 502: {"error":{"message":"Provider error (Qwen3 Coder (free)): 401: User not found"}}',
    )).toBe(true)
  })

  it('flags a JSON object turning up anywhere in the reason', () => {
    expect(isRawScriptFailurePayload('upstream said {"code":401,"msg":"nope"}')).toBe(true)
  })

  it('never flags a human-readable engine line', () => {
    expect(isRawScriptFailurePayload('piper exited 3')).toBe(false)
    expect(isRawScriptFailurePayload('sd-cli exited 1. CUDA error: out of memory')).toBe(false)
    expect(isRawScriptFailurePayload(
      'The local FreeLLM router is not running yet — it starts with the app; wait a moment and retry.',
    )).toBe(false)
    expect(isRawScriptFailurePayload('fetch failed')).toBe(false)
    expect(isRawScriptFailurePayload('')).toBe(false)
  })
})

describe('a raw router/provider payload never reaches the panel or the rail', () => {
  const RAW = 'router 502: {"error":{"message":"Provider error (Qwen3 Coder (free)): 401: User not found"}}'

  it('maps to the honest fallback line; the raw payload goes to the console instead', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = fakeDeps({ ask: vi.fn(async () => ({ ok: false, error: RAW })) })
    await runner.startAudioOverviewRun(INPUT, deps)

    const message = runState().error?.message ?? ''
    expect(message).not.toContain('{"error"')
    expect(message).not.toContain('401')
    expect(message).not.toContain('User not found')
    expect(message).toBe(runner.FALLBACK_AUDIO_OVERVIEW_COPY.errScriptUnreachable())
    // …and the rail's row carries the exact same honest line, never the raw one.
    expect(row()!.error).toBe(message)

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('audio-overview'), expect.stringContaining(RAW))
    errSpy.mockRestore()
  })

  it('a human-readable engine failure still passes through in the producer\'s own words', async () => {
    const deps = fakeDeps({ ask: vi.fn(async () => ({ ok: false, error: 'weird upstream said no' })) })
    await runner.startAudioOverviewRun(INPUT, deps)
    expect(runState().error?.message).toContain('weird upstream said no')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8 · CREATE IS GATED ON A CONFIGURED SCRIPT MODEL
//     (Driver Checkpoint A, finding 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// The panel promises "drafted by the local keyless model", yet Create used
// to enable with no check that one was configured at all — a fresh install
// with every free provider unconfigured could only ever draft into the raw
// router error finding 1 fixes the wording of. hasUsableScriptModel is a
// PRESENCE/CONFIG check (freellmapi's own fallback catalog, the same probe
// provider-health.store already runs) — not an invented health-ping.

describe('hasUsableScriptModel: a presence/config check, not a live ping', () => {
  it('true when at least one fallback model is enabled', () => {
    expect(hasUsableScriptModel([{ enabled: false }, { enabled: true }])).toBe(true)
  })

  it('false for an empty or all-disabled catalog', () => {
    expect(hasUsableScriptModel([])).toBe(false)
    expect(hasUsableScriptModel([{ enabled: false }])).toBe(false)
  })

  it('false rather than throwing on a missing/malformed list', () => {
    expect(hasUsableScriptModel(null)).toBe(false)
    expect(hasUsableScriptModel(undefined)).toBe(false)
  })
})

describe('the panel gates Create on the script model, the same way it gates on voices', () => {
  const panel = () => read('src/pages/media/AudioOverviewPanel.tsx')

  it('probes freellmapi\'s fallback catalog, not an invented health-ping', () => {
    const src = panel()
    expect(src).toContain('freellmapi')
    expect(src).toContain('listFallbackModels')
    expect(src).toContain('hasUsableScriptModel')
  })

  it('Create is disabled when the resolver reports nothing usable', () => {
    const src = panel()
    expect(src).toMatch(/scriptModelReady/)
    // disabled + the dimmed style + the cursor all read the SAME gate, so
    // none of the three can quietly drift from the rest.
    const gate = src.match(/const cannotGenerate = ([^\n]+)/)?.[1] ?? ''
    expect(gate).toContain('scriptModelReady')
    expect((src.match(/cannotGenerate/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('names what to set up when nothing is configured', () => {
    expect(panel()).toContain('audioOverview.scriptModel.notConfigured')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 9 · i18n — the new script-failure + gate copy speaks every language
// ═════════════════════════════════════════════════════════════════════════════

function mediaNs(lang: string): Record<string, unknown> {
  return JSON.parse(read(`src/i18n/locales/${lang}/media.json`)) as Record<string, unknown>
}

describe('i18n: the new script-failure + script-model-gate copy speaks every language', () => {
  const KEYS = ['audioOverview.error.scriptUnreachable', 'audioOverview.scriptModel.notConfigured']

  for (const lang of LANGS) {
    it(`${lang}: every key resolves to a non-empty string`, () => {
      const ns = mediaNs(lang)
      for (const key of KEYS) {
        const v = lookup(ns, key)
        expect(typeof v, `${lang}/media.json missing ${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/media.json blank ${key}`).not.toBe('')
      }
    })
  }
})
