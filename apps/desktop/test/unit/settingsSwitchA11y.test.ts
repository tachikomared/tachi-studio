// apps/desktop/test/unit/settingsSwitchA11y.test.ts
//
// THE PRIVATE-MODE TOGGLE WAS NOT A CONTROL — a SOURCE SWEEP, in the
// nodesA11y / civitaiCatalogTab idiom (vitest.config.ts pins the node
// environment; there is no DOM here to mount Settings into).
//
// Driver finding (Civitai phase-1 verify): the Private Mode toggle had no
// `role`, no `aria-checked` and no input of any kind. The handler sat on an
// INNER <div>, wrapped in a <label> that labelled nothing — so a screen reader
// announced a shape, the keyboard could not reach it at all, and clicking the
// "OFF" text (the part a <label> exists to make clickable) did nothing.
//
// The shape was copy-pasted twice more. The scrub toggle was identical; the
// context-recall toggle had picked up role + aria-checked but still no
// tabIndex and no key handler — the WORST of the three, because it announces
// itself as an operable switch and then refuses the keyboard.
//
// One shared <Switch> (a real <button role="switch">) replaces all three. What
// is pinned here:
//   1. the component IS a button, carries aria-checked, and never hand-rolls
//      the keyboard (Space/Enter are the element's own),
//   2. every settings toggle goes through it — no new hand-rolled 36x18 track,
//   3. every one of them is NAMED (a visible heading via aria-labelledby, or an
//      explicit label),
//   4. the visual did not move: this was an accessibility fix, not a redesign.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

/**
 * Source with COMMENTS REMOVED. Every file here documents the bug it fixes by
 * quoting it ("role=\"switch\" on a <div> with no tabIndex"), so a sweep that
 * greps raw text finds the prose and reports the fix as the failure.
 */
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ 	]*\/\/.*$/gm, '')
const code = (rel: string) => strip(read(rel))

const SWITCH  = 'src/components/Switch.tsx'
const PRIVACY = 'src/pages/settings/PrivacySection.tsx'
const RECALL  = 'src/pages/settings/ContextRecallSection.tsx'

/** Every .tsx under src/pages/settings, repo-relative. */
function settingsTsx(): string[] {
  const dir = path.join(APP, 'src/pages/settings')
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tsx'))
    .map(f => `src/pages/settings/${f}`)
    .sort()
}

// ─── 1. the control itself ───────────────────────────────────────────────────

describe('Switch — a real, operable switch', () => {
  const src = code(SWITCH)

  it('is a <button type="button">, so Space/Enter and focus come for free', () => {
    expect(src).toMatch(/<button/)
    expect(src).toMatch(/type="button"/)
  })

  it('announces itself: role=switch + aria-checked bound to the state', () => {
    expect(src).toMatch(/role="switch"/)
    expect(src).toMatch(/aria-checked=\{checked\}/)
  })

  it('hand-rolls NO keyboard handling — the element already has it', () => {
    // A key handler here would be a second, drifting implementation of what a
    // <button> does natively (and the exact thing the old div was missing).
    expect(src).not.toMatch(/onKeyDown|onKeyPress|onKeyUp|tabIndex/)
  })

  it('is named, and prefers the VISIBLE heading over an invented string', () => {
    expect(src).toMatch(/aria-labelledby=\{labelledBy\}/)
    // aria-label only when nothing visible names it — never both at once, which
    // would make the announced name and the on-screen text two separate truths.
    expect(src).toMatch(/aria-label=\{labelledBy \? undefined : label\}/)
  })

  it('the ON/OFF text is INSIDE the button — clicking it toggles', () => {
    // The original bug: that text lived in a <label> with no control, so it was
    // the one part of the toggle that looked clickable and was not.
    expect(src).toMatch(/\{checked \? onLabel : offLabel\}/)
    expect(src.indexOf('{checked ? onLabel : offLabel}')).toBeGreaterThan(src.indexOf('<button'))
    expect(src.indexOf('{checked ? onLabel : offLabel}')).toBeLessThan(src.indexOf('</button>'))
  })

  it('the decorative track does not re-announce the state', () => {
    expect(src).toMatch(/aria-hidden="true"/)
  })

  it('respects disabled at BOTH ends (the attribute and the handler)', () => {
    expect(src).toMatch(/disabled=\{disabled\}/)
    expect(src).toMatch(/if \(!disabled\) onChange\(!checked\)/)
  })

  it('keeps the brutalist look byte-for-byte — 36x18, 2px, 12px knob', () => {
    expect(src).toMatch(/width: 36/)
    expect(src).toMatch(/height: 18/)
    expect(src).toMatch(/2px solid \$\{checked \? 'var\(--accent\)' : 'var\(--border\)'\}/)
    expect(src).toMatch(/left: checked \? 'calc\(100% - 14px\)' : 1/)
    expect(src).toMatch(/transition: 'left 0\.15s'/)
  })

  it('does not strip the focus ring it just made reachable', () => {
    expect(src).not.toMatch(/outline:\s*['"]?none/)
  })
})

// ─── 2. every settings toggle goes through it ────────────────────────────────

describe('settings a11y — no hand-rolled toggle survives', () => {
  it('PrivacySection drives both switches through <Switch>', () => {
    const src = code(PRIVACY)
    expect((src.match(/<Switch\b/g) ?? []).length).toBe(2)
    // The two failure shapes, gone: a click handler on a bare div, and a
    // <label> wrapping no control.
    expect(src).not.toMatch(/<div\s+onClick=/)
    expect(src).not.toMatch(/<label/)
  })

  it('ContextRecallSection too — announced-but-unreachable is also a failure', () => {
    const src = code(RECALL)
    expect(src).toMatch(/<Switch\b/)
    expect(src).not.toMatch(/<div\s*\n?\s*role="switch"/)
    expect(src).not.toMatch(/<label/)
  })

  it('no settings file re-invents the 36x18 track outside the component', () => {
    const offenders = settingsTsx().filter(f => /width: 36,? height: 18|width: 36,\s*\n\s*height: 18/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('role="switch" appears in exactly one place in the whole renderer', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p, out)
        else if (e.name.endsWith('.tsx')) out.push(p)
      }
      return out
    }
    const withRole = walk(path.join(APP, 'src'))
      .filter(p => /role="switch"/.test(strip(fs.readFileSync(p, 'utf8'))))
      .map(p => path.relative(APP, p).split(path.sep).join('/'))
    expect(withRole).toEqual([SWITCH])
  })
})

// ─── 3. every switch is NAMED ────────────────────────────────────────────────

describe('settings a11y — every switch has an accessible name', () => {
  /** Each `<Switch ... />` element, with its props blob. */
  function switches(rel: string): string[] {
    return [...read(rel).matchAll(/<Switch\b[\s\S]*?\/>/g)].map(m => m[0])
  }

  it('finds the switches it is meant to be checking', () => {
    expect(switches(PRIVACY)).toHaveLength(2)
    expect(switches(RECALL)).toHaveLength(1)
  })

  it('names every one of them', () => {
    const nameless = [PRIVACY, RECALL]
      .flatMap(f => switches(f).map(s => ({ f, s })))
      .filter(({ s }) => !/labelledBy=|label=/.test(s))
    expect(nameless.map(x => `${x.f}: ${x.s.slice(0, 60)}`)).toEqual([])
  })

  it('the ids the privacy switches point at exist on the VISIBLE headings', () => {
    const src = code(PRIVACY)
    for (const id of ['PRIVATE_MODE_LABEL_ID', 'SCRUB_LABEL_ID']) {
      expect(src).toMatch(new RegExp(`labelledBy=\\{${id}\\}`))
      expect(src).toMatch(new RegExp(`id=\\{${id}\\}`))
    }
  })

  it('both privacy toggles still change the same state they always did', () => {
    const src = code(PRIVACY)
    expect(src).toMatch(/onChange=\{v => \{ void toggle\(v\) \}\}/)
    expect(src).toMatch(/onChange=\{v => \{ void toggleScrub\(v\) \}\}/)
  })
})

// ── AND A SELECTED OPTION MUST BE READABLE THE INSTANT IT IS SELECTED ───────
//
// Measured on the installed build (2026-08-03) by reading computed styles right
// after a click on the KV-cache control:
//
//   Full     aria-checked=false   background rgb(107,56,212)   ← still accent
//   Smaller  aria-checked=true    background rgb(252,249,248)
//                                 color      rgb(252,249,248)  ← same as its bg
//
// globals.css eases `background-color` on every button and does NOT ease
// `color`, so on selection the label flips to the on-accent colour immediately
// while the background is still easing — white on white — and the PREVIOUS
// choice is still painted accent for the same 120 ms. Two buttons look picked
// and the real one cannot be read.
//
// TWO fixes, at two altitudes, because there are two defects:
//   READABILITY, app-wide — globals.css now eases `color` alongside
//     `background-color`, so a label can never again be the same colour as its
//     own background. Four surfaces flip both together and all four are covered.
//   AMBIGUITY, here only — for the length of any ease, the option you left is
//     still partly lit while the one you picked is only partly lit. A
//     radiogroup's whole promise is that exactly one option is chosen, so this
//     control opts out of the colour easing entirely and swaps instantly.
// Any future segmented control has to make the same second choice, which is
// what this pins.
describe('a segmented control swaps its selection atomically', () => {
  const SEGMENTED = 'src/pages/settings/LocalEngineSection.tsx'

  it('re-declares the transition without background-color', () => {
    const src = code(SEGMENTED)
    const m = src.match(/transition: '([^']+)'/)
    expect(m, 'the control must state its own transition').toBeTruthy()
    // The press feel survives…
    expect(m![1]).toContain('transform')
    expect(m![1]).toContain('box-shadow')
    // …and the thing that made the label vanish does not.
    expect(m![1]).not.toContain('background')
  })

  it('still colours BOTH the background and the text from the same condition', () => {
    // The bug is only invisible-text if exactly one of the pair animates. Both
    // must keep reading the same `value === c`, or a later edit could reopen it
    // from the other side.
    const src = code(SEGMENTED)
    expect(src).toMatch(/background: value === c \? 'var\(--accent\)'/)
    expect(src).toMatch(/color: value === c \? 'var\(--accent-fg/)
  })

  it('globals.css eases color WITH background-color, app-wide', () => {
    // The altitude that fixes every other selected-state control. If `color`
    // ever leaves this list again, a label somewhere goes invisible for 120ms
    // and no test but this one would notice.
    // Read RAW: the rule carries a long comment explaining itself, and `code()`
    // strips comments — but here the property list is what matters, not prose.
    const css = read('src/globals.css')
    const from = css.indexOf('button:not(:disabled)')
    const block = css.slice(from, from + css.slice(from).indexOf('}'))
    expect(block).toContain('background-color 120ms')
    expect(block, 'color must ease with the background it is paired to').toContain('color 120ms')
  })
})
