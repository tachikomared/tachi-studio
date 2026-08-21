// Tests for the key-change event bus (key-events.ts).
//
// Audit 2026-06-12 (dimension 5 / HIGH, root cause): there was NO signal when a
// key was rotated/deleted, so live sidecars kept using the stale copy. This bus
// is the signal; keychain mutators emit it and sidecar-manager subscribes.

import { describe, it, expect, vi } from 'vitest'
import { onKeyChange, emitKeyChange } from '../../electron/services/key-events'

describe('key-events bus', () => {
  it('delivers the changed keyId to subscribers', () => {
    const seen: string[] = []
    const off = onKeyChange(id => seen.push(id))
    emitKeyChange('google')
    emitKeyChange('darksol-wallet:main')
    off()
    expect(seen).toEqual(['google', 'darksol-wallet:main'])
  })

  it('stops delivering after unsubscribe', () => {
    const fn = vi.fn()
    const off = onKeyChange(fn)
    off()
    emitKeyChange('groq')
    expect(fn).not.toHaveBeenCalled()
  })

  it('a throwing listener does not break emit or other listeners', () => {
    const good = vi.fn()
    const offBad = onKeyChange(() => { throw new Error('boom') })
    const offGood = onKeyChange(good)
    expect(() => emitKeyChange('mistral')).not.toThrow()
    expect(good).toHaveBeenCalledWith('mistral')
    offBad(); offGood()
  })
})
