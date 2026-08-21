// apps/desktop/test/unit/promptQueueStore.test.ts
//
// FOLLOW-UP PROMPT QUEUE — the store half + the wiring that makes it real.
//
// What this pins:
//   - per-SURFACE isolation: a follow-up typed on TACHIAPP can never drain into
//     a CODE run (the two routes share ONE live session slot, which is exactly
//     how the transcript-bleed class of bug happens);
//   - the cap REFUSES rather than dropping the oldest;
//   - `takeQueuedPrompt` removes as it reads, so a re-fired effect (or React
//     StrictMode's double-invoke) can never send the same follow-up twice;
//   - an `error` event latches the pause for the OWNING surface only;
//   - reset() / startNewSession() clear the queue — a follow-up written for a
//     conversation that was just thrown away must not fire into the next one;
//   - the page actually queues on Enter and actually calls the drain.
//
// Same localStorage / safeStorage shims as agentStore.test.ts: the persist
// middleware touches both on every setState.

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const _ls = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}
;(globalThis as any).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
  },
}

import { useAgentStore } from '../../src/store/agent.store'
import { PROMPT_QUEUE_CAP } from '../../src/pages/agent/promptQueue'

const S = () => useAgentStore.getState()
const codeQ     = () => S().pendingPrompts.code
const tachiappQ = () => S().pendingPrompts.tachiapp

beforeEach(() => {
  useAgentStore.setState({
    pendingPrompts:    { code: [], tachiapp: [] },
    promptQueuePaused: { code: false, tachiapp: false },
    permissionQueue:   [],
    messages: [], status: 'idle', error: null, viewingArchiveId: null,
    pastSessions: [], sessionTag: null, sessionId: null, startedAt: null,
  })
})

describe('agent store — follow-up prompt queue', () => {
  it('queues in arrival order and reports success', () => {
    expect(S().queuePrompt('code', 'run the tests')).toBe(true)
    expect(S().queuePrompt('code', 'then commit')).toBe(true)
    expect(codeQ().map(q => q.text)).toEqual(['run the tests', 'then commit'])
  })

  it('refuses empty text without touching the queue', () => {
    expect(S().queuePrompt('code', '   ')).toBe(false)
    expect(codeQ()).toHaveLength(0)
  })

  it('REFUSES past the cap instead of dropping the oldest', () => {
    for (let i = 0; i < PROMPT_QUEUE_CAP; i++) {
      expect(S().queuePrompt('code', `m${i}`)).toBe(true)
    }
    expect(S().queuePrompt('code', 'overflow')).toBe(false)
    expect(codeQ()).toHaveLength(PROMPT_QUEUE_CAP)
    expect(codeQ()[0].text).toBe('m0')          // oldest survived
    expect(codeQ().some(q => q.text === 'overflow')).toBe(false)
  })

  it('is isolated PER SURFACE — TACHIAPP follow-ups never leak into CODE', () => {
    S().queuePrompt('code', 'code work')
    S().queuePrompt('tachiapp', 'app work')
    expect(codeQ().map(q => q.text)).toEqual(['code work'])
    expect(tachiappQ().map(q => q.text)).toEqual(['app work'])
    // Draining one surface leaves the other untouched.
    expect(S().takeQueuedPrompt('code')?.text).toBe('code work')
    expect(codeQ()).toHaveLength(0)
    expect(tachiappQ()).toHaveLength(1)
  })

  it('takeQueuedPrompt is FIFO and removes as it reads (never sends twice)', () => {
    S().queuePrompt('code', 'first')
    S().queuePrompt('code', 'second')
    expect(S().takeQueuedPrompt('code')?.text).toBe('first')
    // A second consumer in the same tick (StrictMode double-invoke, re-fired
    // effect) gets the NEXT one, never 'first' again.
    expect(S().takeQueuedPrompt('code')?.text).toBe('second')
    expect(S().takeQueuedPrompt('code')).toBeNull()
  })

  it('unqueuePrompt removes exactly the chip the operator clicked', () => {
    S().queuePrompt('code', 'a')
    S().queuePrompt('code', 'b')
    S().queuePrompt('code', 'c')
    const bId = codeQ()[1].id
    S().unqueuePrompt('code', bId)
    expect(codeQ().map(q => q.text)).toEqual(['a', 'c'])
  })

  it('clearQueuedPrompts also releases that surface’s pause latch', () => {
    S().queuePrompt('code', 'a')
    S().setPromptQueuePaused('code', true)
    S().clearQueuedPrompts('code')
    expect(codeQ()).toHaveLength(0)
    expect(S().promptQueuePaused.code).toBe(false)
  })
})

describe('agent store — pause policy', () => {
  it('an `error` event latches the pause for the OWNING surface only', () => {
    useAgentStore.setState({ sessionTag: 'tachiapp' })
    S().queuePrompt('tachiapp', 'follow-up')
    S().queuePrompt('code', 'unrelated')
    S().appendEvent({ type: 'error', message: 'stream died' } as any)
    expect(S().promptQueuePaused.tachiapp).toBe(true)
    // The Code surface has nothing to do with a TACHIAPP failure.
    expect(S().promptQueuePaused.code).toBe(false)
  })

  it('a clean `done` leaves the latch alone (the drain decision is the page’s)', () => {
    S().queuePrompt('code', 'follow-up')
    S().appendEvent({ type: 'done', reason: 'stop' } as any)
    expect(S().promptQueuePaused.code).toBe(false)
    expect(codeQ()).toHaveLength(1)   // the store never drains on its own
  })

  it('an ENDED-INCOMPLETE `done` does not pause either — a give-up still drains', () => {
    S().queuePrompt('code', 'follow-up')
    S().appendEvent({ type: 'done', reason: 'stop', incomplete: true, incompleteCode: 'no-completion' } as any)
    expect(S().endedIncomplete).toBeTruthy()
    expect(S().promptQueuePaused.code).toBe(false)
  })
})

describe('agent store — a new conversation drops the queue', () => {
  it('reset() clears the live surface’s queue and latch', () => {
    S().queuePrompt('code', 'follow-up')
    S().setPromptQueuePaused('code', true)
    S().reset()
    expect(codeQ()).toHaveLength(0)
    expect(S().promptQueuePaused.code).toBe(false)
  })

  it('startNewSession() clears it too, and only for the live surface', () => {
    useAgentStore.setState({ sessionTag: 'tachiapp' })
    S().queuePrompt('tachiapp', 'app follow-up')
    S().queuePrompt('code', 'code follow-up')
    S().startNewSession()
    expect(tachiappQ()).toHaveLength(0)
    expect(codeQ()).toHaveLength(1)
  })

  it('permission cards are NOT collateral damage of the prompt-queue clears', () => {
    // reset() deliberately keeps permission cards (each has a resolver waiting
    // in main). Clearing the prompt queue there must not have changed that.
    S().pushPermission({
      id: 'req-1', toolName: 'bash', toolInput: { command: 'ls' },
      reason: 'Bash', recommendedDecision: 'allow',
    })
    S().queuePrompt('code', 'follow-up')
    S().reset()
    expect(S().permissionQueue).toHaveLength(1)
    expect(codeQ()).toHaveLength(0)
  })

  it('the queue is never persisted (it describes a run that is already gone)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/store/agent.store.ts'), 'utf8')
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).not.toContain('pendingPrompts')
    expect(partialize).not.toContain('promptQueuePaused')
  })
})

// The store is worth nothing if the composer still refuses to type or the page
// never drains — both are a handful of lines in one file.
describe('AgentPage wiring', () => {
  const APP  = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
  const page = () => read('src/pages/agent/AgentPage.tsx')

  it('Enter goes through submitComposer, which QUEUES while running', () => {
    const src = page()
    expect(src).toContain("if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComposer() }")
    // …and submitComposer's running branch queues rather than dropping.
    expect(src).toContain('if (isRunning && !surfaceBlocked && !isViewingArchive && !workflowMode) {')
    expect(src).toContain('queuePrompt(promptSurface, text)')
  })

  it('the composer textarea is NOT disabled by a live run', () => {
    const src = page()
    const disabledLine = src
      .split('\n')
      .find(l => l.includes("disabled={surfaceBlocked || (!workflowMode && !effectiveWorkingDir)"))
    expect(disabledLine, 'composer textarea disabled expression').toBeTruthy()
    expect(disabledLine).not.toContain('isRunning')
    // 'starting' stays disabled — the session is still being spawned.
    expect(disabledLine).toContain("status === 'starting'")
  })

  it('STOP survives: the running branch renders QUEUE *and* the abort button', () => {
    const src = page()
    expect(src).toContain('data-testid="queue-prompt-button"')
    expect(src).toContain('<button onClick={abort} style={abortBtn}')
  })

  it('the drain is an effect over (status, queue) and takes exactly one entry', () => {
    const src = page()
    expect(src).toContain('shouldDrainPrompt({')
    expect(src).toContain('const next = takeQueuedPrompt(promptSurface)')
    expect(src).toContain('sendTaskRef.current({ text: next.text })')
    // Re-entry guard: without it a still-'done' status would fire the whole
    // queue in one tick.
    expect(src).toContain('drainingRef.current = true')
  })

  it('STOP latches the pause so nothing auto-fires after an interrupt', () => {
    const src = page()
    const abortFn = src.slice(src.indexOf('const abort = () => {'), src.indexOf('// ── FOLLOW-UP QUEUE'))
    expect(abortFn).toContain('setPromptQueuePaused(promptSurface, true)')
  })

  it('ships the queue copy in every locale', () => {
    for (const lang of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const agent = JSON.parse(read(`src/i18n/locales/${lang}/agent.json`))
      expect(agent.queue, `${lang}/agent.json queue`).toBeTruthy()
      for (const k of ['placeholder', 'label', 'labelHint', 'paused', 'pausedHint',
                       'resume', 'resumeHint', 'button', 'buttonHint', 'remove', 'full']) {
        expect(agent.queue[k], `${lang}/agent.json queue.${k}`).toBeTruthy()
      }
      // The interpolations the UI actually passes must survive translation.
      expect(agent.queue.label).toContain('{{n}}')
      expect(agent.queue.paused).toContain('{{n}}')
      expect(agent.queue.full).toContain('{{cap}}')
    }
  })
})
