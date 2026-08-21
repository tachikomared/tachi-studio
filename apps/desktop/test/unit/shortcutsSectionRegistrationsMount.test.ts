// apps/desktop/test/unit/shortcutsSectionRegistrationsMount.test.ts
//
// Source-assertion guard for ShortcutsSection.tsx: window.tachi.hotkeys
// .registrations() must be loaded exactly ONCE, on mount, via a bare
// `useEffect(..., [])` — no polling (setInterval / repeated calls / a
// non-empty dependency array that would re-fire the load). This is a plain
// text/regex check on the component source rather than a React Testing
// Library render, since the project's existing hotkey coverage (see
// hotkeyRegistrations.test.ts) is source/behavior-level, not component-render
// level, and there is no jsdom + RTL harness wired for .tsx elsewhere in
// test/unit.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SOURCE = path.resolve(__dirname, '../../src/pages/settings/ShortcutsSection.tsx')
const src = fs.readFileSync(SOURCE, 'utf8')

describe('ShortcutsSection: registrations() mount-load (no polling)', () => {
  it('calls window.tachi.hotkeys.registrations() exactly once in the source', () => {
    const matches = src.match(/window\.tachi\.hotkeys\.registrations\(\)/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('the registrations() call sits inside its own useEffect(..., []) — mount-only', () => {
    // Grab the useEffect block that contains the registrations() call.
    const idx = src.indexOf('window.tachi.hotkeys.registrations()')
    expect(idx).toBeGreaterThan(-1)

    const before = src.slice(0, idx)
    const effectStart = before.lastIndexOf('useEffect(')
    expect(effectStart).toBeGreaterThan(-1)

    // The effect body is short; find its closing `}, [` deps array on the
    // next few lines and assert it is empty (mount-only, never re-runs).
    const after = src.slice(idx, idx + 400)
    const depsMatch = after.match(/\},\s*(\[[^\]]*\])\s*\)/)
    expect(depsMatch).not.toBeNull()
    expect(depsMatch![1].replace(/\s/g, '')).toBe('[]')
  })

  it('never polls: no setInterval/setTimeout anywhere near the registrations load', () => {
    expect(src).not.toMatch(/setInterval/)
    // registrations() itself must not be inside a setTimeout retry/poll loop.
    const idx = src.indexOf('window.tachi.hotkeys.registrations()')
    const windowBefore = src.slice(Math.max(0, idx - 200), idx)
    expect(windowBefore).not.toMatch(/setTimeout/)
  })

  it('does not call registrations() from any button handler or interval — mount effect only', () => {
    // Every occurrence of the call must be preceded (within a small window)
    // by the useEffect(() => { opening, not by an onClick/onChange handler.
    const idx = src.indexOf('window.tachi.hotkeys.registrations()')
    const windowBefore = src.slice(Math.max(0, idx - 120), idx)
    expect(windowBefore).toMatch(/useEffect\(\(\)\s*=>\s*\{/)
  })
})
