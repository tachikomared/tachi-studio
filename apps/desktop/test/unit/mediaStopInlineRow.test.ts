// apps/desktop/test/unit/mediaStopInlineRow.test.ts
//
// THE SAME LIE, THE OTHER SURFACE.
//
// 6227a0e fixed the STOP TOAST: a run the user asked to stop stopped being
// reported as a fault, because `runFailureToastKind` learned to tell "you asked
// for this" from "something went wrong". Its own commit message flagged what it
// did NOT fix: «inline failure row under Generate still error-styles a user
// stop — next pass». This is that pass.
//
// The inline row is the surface that MATTERS MORE, and that is not a figure of
// speech — it exists precisely because a toast cannot outlive a 70-minute
// render the user walked away from (see sdCppGenerateLifecycle). So the state
// the user is most likely to come back and read was the one still shouting
// GENERATION FAILED, in danger red, under a hint about running out of GPU
// memory — about a render they stopped on purpose.
//
// ── WHY THE ROW COULD NOT JUST CALL THE MAPPER ───────────────────────────────
//
// `runFailureToastKind` takes TWO signals, and the row could only ever see one.
// The toast is built inside the catch, where `run.stopping` is still latched;
// the row renders LATER, after `failRun` has cleared `stopping` as part of
// settling the run. Reading the flag at render time always answered `false`, so
// the row would have been left with the message-sniffing half of the evidence
// and would still mislabel any stop that main worded differently.
//
// The fix is one field, not a second mapper: `stoppedByUser` latches alongside
// `stopping` in markRunStopping and is NOT cleared by failRun (only a new run
// clears it, via beginRun's reset to IDLE). Both surfaces then call the SAME
// function with the same two signals — which is the actual guarantee wanted
// here, since "two surfaces, two severity rules" is how this bug existed at all.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// In-memory localStorage (the store persists through zustand). `vi.hoisted` so
// it is installed BEFORE the store module is imported — mediaRunState.test.ts
// achieves the same with a dynamic import in beforeAll.
vi.hoisted(() => {
  const ls = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string): void => { ls.set(k, v) },
    removeItem: (k: string): void => { ls.delete(k) },
    clear: (): void => { ls.clear() },
    key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
    get length(): number { return ls.size },
  }
})

import { useMediaStore } from '../../src/store/media.store'
import { runFailureToastKind } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const run = () => useMediaStore.getState().run

const STOPPED = 'sd-cli vid_gen was stopped before it finished.'
const KILLED  = 'sd-cli was killed (SIGKILL) before it finished.'
const CRASHED = 'sd-cli exited 1. CUDA error: out of memory'

describe('the evidence survives the run settling', () => {
  beforeEach(() => { useMediaStore.setState({ gallery: [] }); useMediaStore.getState().endRun() })

  it('THE REPRO: after failRun the row can still tell it was a stop', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().markRunStopping()
    useMediaStore.getState().failRun(STOPPED)
    // `stopping` is gone — that is correct, the run is no longer stopping…
    expect(run().stopping).toBe(false)
    // …and the reason it stopped is not.
    expect(run().stoppedByUser).toBe(true)
    expect(runFailureToastKind({ message: run().error!, stopping: run().stoppedByUser })).toBe('info')
  })

  it('a NEW run clears it — one stop does not tint the next failure', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().markRunStopping()
    useMediaStore.getState().failRun(STOPPED)
    useMediaStore.getState().beginRun({ cancellable: true })
    expect(run().stoppedByUser).toBe(false)
    useMediaStore.getState().failRun(CRASHED)
    expect(runFailureToastKind({ message: run().error!, stopping: run().stoppedByUser })).toBe('error')
  })

  it('a real crash the user never touched stays an error', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().failRun(CRASHED)
    expect(run().stoppedByUser).toBe(false)
    expect(runFailureToastKind({ message: run().error!, stopping: run().stoppedByUser })).toBe('error')
  })

  it('a SIGKILL from outside stays an error — nobody asked for that one', () => {
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().failRun(KILLED)
    expect(runFailureToastKind({ message: run().error!, stopping: run().stoppedByUser })).toBe('error')
  })

  it('a cancel from ANOTHER surface still reads as a stop (message half of the evidence)', () => {
    // The canvas media node has no Stop button of its own, so nothing latches
    // here; main's own sentence is what carries it.
    useMediaStore.getState().beginRun({ cancellable: true })
    useMediaStore.getState().failRun(STOPPED)
    expect(run().stoppedByUser).toBe(false)
    expect(runFailureToastKind({ message: run().error!, stopping: run().stoppedByUser })).toBe('info')
  })

  it('markRunStopping still only latches on a LIVE run', () => {
    useMediaStore.getState().endRun()
    useMediaStore.getState().markRunStopping()
    expect(run().stoppedByUser).toBe(false)
    expect(run().stopping).toBe(false)
  })

  it('the new field is still not persisted', () => {
    const src = read('src/store/media.store.ts')
    const part = src.slice(src.indexOf('partialize:'))
    expect(part).not.toContain('run:')
    expect(part).not.toContain('stoppedByUser')
  })
})

describe('the row reads the shared mapper, not a second rule', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('derives the severity from runFailureToastKind + the latched flag', () => {
    expect(page).toContain('const genErrorIsStop =')
    expect(page).toMatch(/runFailureToastKind\(\{ message: genError, stopping: run\.stoppedByUser \}\) === 'info'/)
  })

  it('ONE mapper serves both surfaces — the toast and the row', () => {
    // Two call sites, one function. A third severity rule is how this bug got
    // to exist on two screens with one fix.
    expect((page.match(/runFailureToastKind\(/g) ?? []).length).toBe(2)
  })
})

describe('a stop is not painted as a fault', () => {
  const page = read('src/pages/media/MediaPage.tsx')
  const row  = page.slice(page.indexOf('{genError && ('), page.indexOf('{/* ── Right: persistent result gallery'))

  it('the row exists and is the one under Generate', () => {
    expect(row.length).toBeGreaterThan(200)
  })

  it('announces a stop as STATUS and a failure as ALERT', () => {
    // role="alert" is an assertive interruption. A user pressing Stop and being
    // interrupted about it is the audible version of the red border.
    expect(row).toMatch(/role=\{genErrorIsStop \? 'status' : 'alert'\}/)
    expect(row).not.toContain('role="alert"')
  })

  it('the danger colour is conditional, never unconditional', () => {
    // Every var(--danger) in this row must be behind the flag.
    const dangerHits = row.match(/var\(--danger[^)]*\)/g) ?? []
    expect(dangerHits.length).toBeGreaterThan(0)
    expect(row).not.toMatch(/border: '2px solid var\(--danger, #c00\)'/)
    expect(row).toContain('genErrorIsStop ?')
  })

  it('uses the STOPPED copy, not "Generation failed" and not the out-of-memory hint', () => {
    expect(row).toContain("t('genError.stoppedTitle')")
    expect(row).toContain("t('genError.stoppedHint')")
    // …and still uses the failure copy for a real failure.
    expect(row).toContain("t('genError.title')")
    expect(row).toContain("t('genError.hint')")
  })

  it('still shows main\'s own sentence and a DISMISS, and still invents no RETRY', () => {
    expect(row).toContain('{genError}')
    expect(row).toContain('onClick={() => clearRunError()}')
    expect(row).not.toContain('retry')
    expect(row).not.toContain('Retry')
  })
})

describe('the stopped copy ships in every locale', () => {
  const en = JSON.parse(read('src/i18n/locales/en/media.json')) as { genError: Record<string, string> }

  it('English says what happened and does not blame the GPU', () => {
    expect(en.genError.stoppedTitle).toBeTruthy()
    expect(en.genError.stoppedHint).toBeTruthy()
    expect(en.genError.stoppedHint).not.toMatch(/memory/i)
    // The failure hint it replaces is the one that does.
    expect(en.genError.hint).toMatch(/memory/i)
  })

  it('every locale carries both keys, actually translated', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as { genError: Record<string, string> }
      expect(json.genError?.stoppedTitle, `${l} genError.stoppedTitle`).toBeTruthy()
      expect(json.genError?.stoppedHint, `${l} genError.stoppedHint`).toBeTruthy()
      if (l !== 'en') {
        expect(json.genError.stoppedTitle, `${l} stoppedTitle is still English`).not.toBe(en.genError.stoppedTitle)
        expect(json.genError.stoppedHint, `${l} stoppedHint is still English`).not.toBe(en.genError.stoppedHint)
      }
    }
  })
})
