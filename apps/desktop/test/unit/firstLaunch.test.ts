// apps/desktop/test/unit/firstLaunch.test.ts
//
// The first-launch LEARN landing decision core (src/utils/firstLaunch.ts). The
// predicate is PURE — a plain input→boolean assertion with no I/O — so we prove:
//   • flag already set   → false (never re-show; existing/handled user)
//   • truly fresh install → true (flag unset, zero chats, zero flows)
//   • any prior data      → false (existing user; caller records the flag)
//   • the predicate has NO side effect (never writes the localStorage flag)

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  shouldShowFirstLaunch,
  FIRST_LAUNCH_KEY,
  type FirstLaunchInput,
} from '../../src/utils/firstLaunch'

const fresh: FirstLaunchInput = { flag: null, conversationCount: 0, savedFlowCount: 0 }

describe('shouldShowFirstLaunch — flag gate', () => {
  it('returns false when the done-flag is set, regardless of data', () => {
    expect(shouldShowFirstLaunch({ ...fresh, flag: '1' })).toBe(false)
    expect(shouldShowFirstLaunch({ flag: '1', conversationCount: 5, savedFlowCount: 3 })).toBe(false)
    // Any non-null string counts as set, even an empty string.
    expect(shouldShowFirstLaunch({ ...fresh, flag: '' })).toBe(false)
  })

  it('treats null AND undefined flag as unset', () => {
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 0, savedFlowCount: 0 })).toBe(true)
    expect(shouldShowFirstLaunch({ flag: undefined, conversationCount: 0, savedFlowCount: 0 })).toBe(true)
  })
})

describe('shouldShowFirstLaunch — fresh install', () => {
  it('returns true only when flag unset AND zero chats AND zero flows', () => {
    expect(shouldShowFirstLaunch(fresh)).toBe(true)
  })
})

describe('shouldShowFirstLaunch — existing user (prior data)', () => {
  it('returns false when there are chat conversations', () => {
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 1, savedFlowCount: 0 })).toBe(false)
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 42, savedFlowCount: 0 })).toBe(false)
  })

  it('returns false when there are saved flows', () => {
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 0, savedFlowCount: 1 })).toBe(false)
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 0, savedFlowCount: 7 })).toBe(false)
  })

  it('returns false when both chats and flows exist', () => {
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 3, savedFlowCount: 2 })).toBe(false)
  })

  it('fails CLOSED on a bad (negative / NaN) count — never hijacks', () => {
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: -1, savedFlowCount: 0 })).toBe(false)
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: NaN, savedFlowCount: 0 })).toBe(false)
    expect(shouldShowFirstLaunch({ flag: null, conversationCount: 0, savedFlowCount: NaN })).toBe(false)
  })
})

describe('shouldShowFirstLaunch — purity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never writes the localStorage flag (side effect stays OUT of the predicate)', () => {
    const setItem = vi.fn()
    const getItem = vi.fn(() => null)
    // Stub a localStorage so we can prove the predicate never touches it.
    vi.stubGlobal('localStorage', { setItem, getItem, removeItem: vi.fn() })

    shouldShowFirstLaunch(fresh)
    shouldShowFirstLaunch({ ...fresh, flag: '1' })
    shouldShowFirstLaunch({ flag: null, conversationCount: 9, savedFlowCount: 9 })

    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
    // The predicate references neither the key constant at runtime nor storage.
    expect(FIRST_LAUNCH_KEY).toBe('tachi:first-launch-done')
  })

  it('is deterministic — identical input yields identical output', () => {
    for (let i = 0; i < 5; i++) {
      expect(shouldShowFirstLaunch(fresh)).toBe(true)
      expect(shouldShowFirstLaunch({ flag: null, conversationCount: 1, savedFlowCount: 0 })).toBe(false)
    }
  })
})
