// apps/desktop/test/unit/mediaChipAria.test.ts
//
// DRIVER CHECKPOINT A, FINDING 3: SELECTION WAS STYLE-ONLY FOR ASSISTIVE TECH.
//
// The modality chips (IMAGE/VIDEO/MUSIC/…) and the media-provider chips
// (Surplus/Venice/Local/imgnAI) in MediaPage each render as a row of plain
// <button>s whose only signal of "this one is selected" was a border/
// background colour swap driven by the same `active` boolean already in
// scope — nothing a screen reader can read. Switch.tsx already set the house
// precedent for this exact class of bug (role="switch" + aria-checked
// instead of colour alone, see its own header comment); these chip groups
// get the native-button equivalent: aria-pressed tracking that same `active`
// flag, no new role needed since a <button> already has one.
//
// Scope: ONLY these two chip groups (the finding names them explicitly).
// Other MediaPage chip-style controls (the local TTS engine toggle, preset
// pickers, …) belong to other lanes and are untouched here.
//
// No testing-library in this suite (vitest env: node) — asserted against
// SOURCE, the idiom mediaStopToastA11y.test.ts / audioOverviewRun.test.ts use.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const src = () => read('src/pages/media/MediaPage.tsx')

describe('MediaPage: the modality chips expose their selected state to AT', () => {
  it('the modality button carries aria-pressed alongside its onClick', () => {
    const s = src()
    const idx = s.indexOf('onClick={() => setModality(m.id)}')
    expect(idx).toBeGreaterThan(-1)
    expect(s.slice(idx, idx + 300)).toMatch(/aria-pressed=\{active\}/)
  })
})

describe('MediaPage: the media-provider chips expose their selected state to AT', () => {
  it('the provider button carries aria-pressed alongside its onClick', () => {
    const s = src()
    const idx = s.indexOf('onClick={() => setMediaProvider(p)}')
    expect(idx).toBeGreaterThan(-1)
    expect(s.slice(idx, idx + 300)).toMatch(/aria-pressed=\{active\}/)
  })
})

describe('both fixes land on the SAME active flag the visual style already reads', () => {
  it('aria-pressed appears at least twice — once per chip group, not invented once and forgotten', () => {
    const count = (src().match(/aria-pressed=\{active\}/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })
})
