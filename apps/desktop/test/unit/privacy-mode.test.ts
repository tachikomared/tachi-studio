// Tests for the pure privacy-mode helpers (privacy-mode.ts).
//
// Audit 2026-06-12 (dimension 6 / MEDIUM): the main-process privacy mirror
// defaulted 'open' and coerced malformed payloads to 'open' — fail-OPEN in two
// ways for a privacy control. These helpers make the policy fail-CLOSED and let
// main initialise from the persisted setting (no cold-start window).

import { describe, it, expect } from 'vitest'
import { coerceMode, startupModeFromStrict } from '../../electron/ipc/privacy-mode'

describe('coerceMode (fail-closed)', () => {
  it('passes through the two valid modes', () => {
    expect(coerceMode('open')).toBe('open')
    expect(coerceMode('private')).toBe('private')
  })
  it('fails CLOSED (private) on anything malformed', () => {
    expect(coerceMode(undefined)).toBe('private')
    expect(coerceMode(null)).toBe('private')
    expect(coerceMode('OPEN')).toBe('private')
    expect(coerceMode(42)).toBe('private')
    expect(coerceMode({})).toBe('private')
  })
})

describe('startupModeFromStrict', () => {
  it('maps the persisted strictPrivacyMode flag to a mode', () => {
    expect(startupModeFromStrict(true)).toBe('private')
    expect(startupModeFromStrict(false)).toBe('open')
    expect(startupModeFromStrict(undefined)).toBe('open') // never enabled → open
  })
})
