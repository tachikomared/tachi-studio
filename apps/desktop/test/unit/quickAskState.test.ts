// apps/desktop/test/unit/quickAskState.test.ts
//
// Quick-ask launcher state (electron/services/quick-ask-service.ts): the
// module-local thread, the replayed last exchange, the prompt-recall ring and
// the pin flag — the four things that decide whether clicking away destroys
// your answer. electron + the sidecar/settings/notification/privacy modules are
// mocked so the service loads under vitest's node env; none of them is touched
// by the pure helpers under test.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable stand-ins for the two modules whose ANSWERS the service branches on
// (stored settings + privacy mode). vi.hoisted keeps them defined before the
// mock factories run.
const env = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  privacy: 'normal' as 'normal' | 'private',
}))

vi.mock('electron', () => ({
  BrowserWindow: class { static getFocusedWindow() { return null } },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  app: { getPath: () => '/tmp/tachi-test' },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn(), clear: vi.fn() },
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('no spawning in unit tests') }) }))
vi.mock('../../electron/services/sidecar-manager', () => ({
  getFreellmapiPort: () => 0,
  getFreellmapiApiKey: () => '',
}))
vi.mock('../../electron/services/settings-store', () => ({
  loadSettings: () => ({ ...env.settings }),
  saveSettings: vi.fn(),
}))
vi.mock('../../electron/services/notifications', () => ({ notifyTaskDone: vi.fn() }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => env.privacy }))

import { saveSettings } from '../../electron/services/settings-store'
import {
  QUICKASK_MAX_TURNS,
  QUICKASK_MAX_CHARS,
  QUICKASK_MESSAGE_MAX,
  QUICKASK_CONTEXT_MAX,
  QUICKASK_CONTEXT_PREVIEW,
  QUICKASK_HISTORY_MAX,
  appendTurn,
  getTurns,
  recordExchange,
  getLastExchange,
  pushPromptHistory,
  getPromptHistory,
  resetQuickAskSession,
  setQuickAskPinned,
  isQuickAskPinned,
  buildShownPayload,
  hashText,
  clipboardChip,
  selectionChip,
  resolveCapture,
  isAutoCaptureEnabled,
  setAutoCaptureEnabled,
  __resetQuickAskStateForTests,
} from '../../electron/services/quick-ask-service'

beforeEach(() => {
  __resetQuickAskStateForTests()
  env.settings = {}
  env.privacy = 'normal'
  vi.mocked(saveSettings).mockClear()
})

describe('quick-ask lastExchange (record / replay / clear)', () => {
  it('records the exchange and replays it in the shown payload', () => {
    recordExchange('what is a mutex', 'a lock', 1_700_000_000_000)
    expect(getLastExchange()).toEqual({ prompt: 'what is a mutex', answer: 'a lock', ts: 1_700_000_000_000 })
    expect(buildShownPayload().lastExchange).toEqual({
      prompt: 'what is a mutex', answer: 'a lock', ts: 1_700_000_000_000,
    })
  })

  it('keeps the newest exchange when a follow-up completes', () => {
    recordExchange('first', 'A', 1)
    recordExchange('second', 'B', 2)
    expect(getLastExchange()).toEqual({ prompt: 'second', answer: 'B', ts: 2 })
  })

  it('survives re-summon (nothing clears it) until explicit New', () => {
    recordExchange('keep me', 'answer', 5)
    expect(buildShownPayload().lastExchange?.answer).toBe('answer')
    expect(buildShownPayload().lastExchange?.answer).toBe('answer')  // second summon
    resetQuickAskSession()
    expect(getLastExchange()).toBeNull()
    expect(buildShownPayload().lastExchange).toBeNull()
  })
})

describe('quick-ask thread (cap + reset)', () => {
  it('appends turns instead of replacing them', () => {
    appendTurn('user', 'q1')
    appendTurn('assistant', 'a1')
    appendTurn('user', 'shorter please')
    expect(getTurns()).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'shorter please' },
    ])
  })

  it(`caps the thread at ${QUICKASK_MAX_TURNS} turns, dropping the oldest`, () => {
    for (let i = 0; i < QUICKASK_MAX_TURNS + 4; i++) appendTurn(i % 2 ? 'assistant' : 'user', `m${i}`)
    const turns = getTurns()
    expect(turns).toHaveLength(QUICKASK_MAX_TURNS)
    expect(turns[0].content).toBe('m4')
    expect(turns[turns.length - 1].content).toBe(`m${QUICKASK_MAX_TURNS + 3}`)
  })

  it('trims each message to the per-message character budget', () => {
    // Budget = typed prompt + one attached clipboard/selection context block.
    expect(QUICKASK_MESSAGE_MAX).toBe(QUICKASK_MAX_CHARS + QUICKASK_CONTEXT_MAX)
    appendTurn('user', 'x'.repeat(QUICKASK_MESSAGE_MAX + 500))
    expect(getTurns()[0].content).toHaveLength(QUICKASK_MESSAGE_MAX)
  })

  it('New (resetQuickAskSession) clears the thread but KEEPS prompt recall', () => {
    appendTurn('user', 'q')
    appendTurn('assistant', 'a')
    pushPromptHistory('q')
    resetQuickAskSession()
    expect(getTurns()).toEqual([])
    expect(getPromptHistory()).toEqual(['q'])
  })
})

describe('quick-ask prompt-recall ring', () => {
  it('is newest-first and de-duplicates a repeated prompt', () => {
    pushPromptHistory('one')
    pushPromptHistory('two')
    pushPromptHistory('one')
    expect(getPromptHistory()).toEqual(['one', 'two'])
  })

  it('ignores blank prompts', () => {
    pushPromptHistory('   ')
    pushPromptHistory('')
    expect(getPromptHistory()).toEqual([])
  })

  it(`caps at ${QUICKASK_HISTORY_MAX} entries`, () => {
    for (let i = 0; i < QUICKASK_HISTORY_MAX + 5; i++) pushPromptHistory(`p${i}`)
    const ring = getPromptHistory()
    expect(ring).toHaveLength(QUICKASK_HISTORY_MAX)
    expect(ring[0]).toBe(`p${QUICKASK_HISTORY_MAX + 4}`)   // newest first
  })

  it('records the prompt through recordExchange too', () => {
    recordExchange('  spaced  ', 'ans', 1)
    expect(getPromptHistory()).toEqual(['spaced'])
  })
})

describe('quick-ask pin flag', () => {
  it('defaults to unpinned and toggles', () => {
    expect(isQuickAskPinned()).toBe(false)
    expect(setQuickAskPinned(true)).toBe(true)
    expect(isQuickAskPinned()).toBe(true)
    expect(buildShownPayload().pinned).toBe(true)
    setQuickAskPinned(false)
    expect(isQuickAskPinned()).toBe(false)
  })
})

// ── clipboard / selection context ────────────────────────────────────────────

describe('quick-ask context chip arming', () => {
  it('hashes text stably and distinguishes different text', () => {
    expect(hashText('same')).toBe(hashText('same'))
    expect(hashText('a')).not.toBe(hashText('b'))
    expect(hashText('')).toBe(hashText(''))
  })

  it('arms the clipboard chip when the clipboard CHANGED since last summon', () => {
    const chip = clipboardChip('a fresh copy', hashText('something older'))
    expect(chip).toMatchObject({ kind: 'clipboard', text: 'a fresh copy', chars: 12, armed: true })
  })

  it('shows the chip UNARMED when the clipboard is unchanged', () => {
    const text = 'stale clipboard'
    const chip = clipboardChip(text, hashText(text))
    expect(chip?.armed).toBe(false)
    expect(chip?.kind).toBe('clipboard')
  })

  it('offers nothing for an empty or whitespace-only clipboard', () => {
    expect(clipboardChip('', null)).toBeNull()
    expect(clipboardChip('   \n\t ', null)).toBeNull()
    expect(selectionChip('')).toBeNull()
  })

  it('caps the sent text and keeps the preview short and single-line', () => {
    const chip = clipboardChip('line one\nline two ' + 'y'.repeat(QUICKASK_CONTEXT_MAX), null)!
    expect(chip.text).toHaveLength(QUICKASK_CONTEXT_MAX)
    expect(chip.chars).toBe(QUICKASK_CONTEXT_MAX)
    expect(chip.preview.length).toBeLessThanOrEqual(QUICKASK_CONTEXT_PREVIEW)
    expect(chip.preview).not.toContain('\n')
  })

  it('always arms a captured selection (the user just selected it)', () => {
    expect(selectionChip('the selected paragraph')).toMatchObject({
      kind: 'selection', armed: true, chars: 22,
    })
  })
})

describe('quick-ask selection-capture state machine', () => {
  it('CHANGED clipboard after the synthetic copy = the selection, and restores the clipboard', () => {
    const r = resolveCapture({ before: 'my precious clipboard', after: 'the selected text', prevHash: null })
    expect(r.context).toMatchObject({ kind: 'selection', text: 'the selected text', armed: true })
    expect(r.restoreClipboard).toBe(true)
  })

  it('UNCHANGED clipboard (nothing selected) falls back to the clipboard chip', () => {
    const r = resolveCapture({ before: 'my precious clipboard', after: 'my precious clipboard', prevHash: null })
    expect(r.context).toMatchObject({ kind: 'clipboard', text: 'my precious clipboard', armed: true })
    expect(r.restoreClipboard).toBe(false)
  })

  it('FAILED capture degrades silently (caller passes after === before)', () => {
    const before = 'clipboard survives a powershell failure'
    const r = resolveCapture({ before, after: before, prevHash: hashText(before) })
    expect(r.context).toMatchObject({ kind: 'clipboard', armed: false })   // unchanged → unarmed
    expect(r.restoreClipboard).toBe(false)
  })

  it('still restores the clipboard when the "selection" turned out to be blank', () => {
    const r = resolveCapture({ before: 'original', after: '   ', prevHash: null })
    expect(r.context).toMatchObject({ kind: 'clipboard', text: 'original' })
    expect(r.restoreClipboard).toBe(true)
  })

  it('offers no chip at all with an empty clipboard and no selection', () => {
    expect(resolveCapture({ before: '', after: '', prevHash: null })).toEqual({
      context: null, restoreClipboard: false,
    })
  })

  it('arms a selection even when the clipboard was empty before', () => {
    const r = resolveCapture({ before: '', after: 'picked this up', prevHash: null })
    expect(r.context).toMatchObject({ kind: 'selection', armed: true })
    expect(r.restoreClipboard).toBe(true)
  })
})

describe('quick-ask auto-capture setting', () => {
  it('defaults ON when nothing is stored', () => {
    expect(isAutoCaptureEnabled()).toBe(true)
    expect(buildShownPayload().autoCapture).toBe(true)
  })

  it('reads a stored OFF value', () => {
    env.settings = { quickAskAutoCapture: false }
    expect(isAutoCaptureEnabled()).toBe(false)
  })

  it('persists the toggle through settings-store', () => {
    expect(setAutoCaptureEnabled(false)).toBe(false)
    expect(vi.mocked(saveSettings)).toHaveBeenCalledWith({ quickAskAutoCapture: false })
    expect(isAutoCaptureEnabled()).toBe(false)
  })

  it('skips the disk write in private mode but still applies for the session', () => {
    env.privacy = 'private'
    expect(setAutoCaptureEnabled(false)).toBe(false)
    expect(vi.mocked(saveSettings)).not.toHaveBeenCalled()
    expect(isAutoCaptureEnabled()).toBe(false)
  })
})

describe('quick-ask shown payload', () => {
  it('carries no context until a summon computes one', () => {
    const p = buildShownPayload()
    expect(p.context).toBeNull()
    expect(p).toMatchObject({ turns: [], pinned: false, busy: false, autoCapture: true })
  })
})
