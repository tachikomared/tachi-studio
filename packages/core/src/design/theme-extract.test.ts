// packages/core/src/design/theme-extract.test.ts
//
// The mockup -> theme extractor. Covers the four behaviours the pipeline is
// built on: MAPPING (own names + aliases + the cascade), SYNTHESIS (each rule
// from the research doc), SCOPING (one block, one selector) and SANITIZING
// (breakout / cursor / url attempts never reach the emitted CSS).

import { describe, it, expect } from 'vitest'
import {
  collectRootVariables,
  extractStructureCss,
  extractTheme,
  MAX_STRUCTURE_CSS_CHARS,
  rescopeSelector,
  slugifyThemeId,
  splitTopLevel,
  THEME_VAR_NAMES,
  forEachRule,
  resolveValue,
} from './theme-extract.js'
import { contrastRatio, parseColor } from './theme-color.js'

/** A realistic Claude-Design-style document: full palette under :root. */
const FULL_MOCKUP = `<!doctype html>
<html><head><style>
  :root {
    --bg-base: #0f0f0f;
    --bg-surface: #111111;
    --bg-elevated: #141414;
    --bg-inset: #0a0a0a;
    --bg-sidebar: #141414;
    --accent: #6b38d4;
    --accent-hover: #8455ef;
    --accent-alt: #d43f00;
    --accent-muted: #1e1530;
    --accent-text: #d0bcff;
    --text-primary: #f5f5f0;
    --text-muted: #888888;
    --text-dim: #444444;
    --border: #2a2a2a;
    --border-strong: #3a3a3a;
    --success: #52c41a;
    --warning: #faad14;
    --danger: #ff5252;
    --info: #60a5fa;
  }
  body { background: var(--bg-base); }
</style></head><body><div class="app"></div></body></html>`

/** A sparse mockup: only the three roots, everything else must be synthesized. */
const SPARSE_MOCKUP = `<style>
  :root { --background: #101014; --primary: #7c5cff; --foreground: #f2f2f7; }
</style>`

describe('slugifyThemeId', () => {
  it('lower-cases, collapses punctuation and trims dashes', () => {
    expect(slugifyThemeId('  Neo Brutal — Pass 2!! ')).toBe('neo-brutal-pass-2')
  })

  it('never returns an empty slug', () => {
    expect(slugifyThemeId('***')).toBe('imported')
    expect(slugifyThemeId('')).toBe('imported')
  })

  it('caps the length', () => {
    expect(slugifyThemeId('a'.repeat(200)).length).toBe(48)
  })
})

describe('forEachRule / resolveValue', () => {
  it('walks nested at-rules and reports the at-rule itself', () => {
    const seen: string[] = []
    forEachRule('@media (min-width:600px) { :root { --a: 1px } } .x { color: red }', (sel) => seen.push(sel))
    expect(seen).toContain('@media (min-width:600px)')
    expect(seen).toContain(':root')
    expect(seen).toContain('.x')
  })

  it('resolves var() chains and honours fallbacks', () => {
    const pool = { '--a': 'var(--b)', '--b': '#123456' }
    expect(resolveValue('var(--a)', pool)).toBe('#123456')
    expect(resolveValue('var(--nope, #eee)', pool)).toBe('#eee')
  })
})

describe('collectRootVariables', () => {
  it('reads :root, :root[data-theme], html and body — and ignores other rules', () => {
    const css = `<style>
      :root { --a: 1 }
      :root[data-theme="x"] { --b: 2 }
      html { --c: 3 }
      body { --d: 4 }
      .card { --nope: 5 }
      @media print { .p { --also-nope: 6 } }
    </style>`
    const { vars } = collectRootVariables(css)
    expect(vars).toEqual({ '--a': '1', '--b': '2', '--c': '3', '--d': '4' })
  })

  it('lets a later declaration win (cascade order)', () => {
    const { vars } = collectRootVariables('<style>:root{--accent:#111}</style><style>:root{--accent:#222}</style>')
    expect(vars['--accent']).toBe('#222')
  })

  it('treats a bare stylesheet (no <style>) as CSS', () => {
    const { vars } = collectRootVariables(':root { --accent: #abcdef; }')
    expect(vars['--accent']).toBe('#abcdef')
  })

  it('is not fooled by markup MENTIONED in a stylesheet comment', () => {
    // The app derives its built-in theme swatches by running the shipped
    // themes/*.css through here; a sheet documenting `<div>` in a comment must
    // still parse as CSS.
    const { vars } = collectRootVariables('/* applies to every <div> in the app */\n:root { --accent: #abcdef; }')
    expect(vars['--accent']).toBe('#abcdef')
  })

  it('returns nothing for a document whose styling is inline attributes only', () => {
    const { vars } = collectRootVariables('<html><body><div style="color:red">hi</div></body></html>')
    expect(vars).toEqual({})
  })

  it('strips !important', () => {
    const { vars } = collectRootVariables(':root { --accent: #abcdef !important; }')
    expect(vars['--accent']).toBe('#abcdef')
  })

  it('rejects remote urls, smuggled cursors, at-rules and script vectors', () => {
    const { vars, rejected } = collectRootVariables(
      ':root { --bad1: url(https://x/y.png); --bad2: cursor: pointer; --bad3: @import "evil.css";' +
        ' --bad4: expression(alert(1)); --ok: #fff }',
    )
    for (const bad of ['--bad1', '--bad2', '--bad3', '--bad4']) expect(vars[bad], bad).toBeUndefined()
    expect(vars['--ok']).toBe('#fff')
    expect(rejected.map((r) => r.name)).toEqual(['--bad1', '--bad2', '--bad3', '--bad4'])
  })

  it('rejects an over-long value', () => {
    const { rejected } = collectRootVariables(`:root { --x: ${'a'.repeat(500)} }`)
    expect(rejected[0]?.reason).toMatch(/longer than/)
  })
})

describe('extractTheme — mapping', () => {
  const out = extractTheme(FULL_MOCKUP, { id: 'Neo Brutal', label: 'Neo Brutal' })

  it('slugs the id and prefixes the theme id', () => {
    expect(out.slug).toBe('neo-brutal')
    expect(out.themeId).toBe('custom:neo-brutal')
  })

  it('maps the 19 declared variables straight through', () => {
    expect(out.report.mapped).toContain('--bg-base')
    expect(out.report.mapped).toContain('--danger')
    expect(out.vars['--accent']).toBe('#6b38d4')
    expect(out.vars['--text-dim']).toBe('#444444')
  })

  it('never reports a missing variable when the palette is complete', () => {
    expect(out.report.missing).toEqual([])
    expect(Object.keys(out.vars).sort()).toEqual([...THEME_VAR_NAMES].sort())
  })

  it('understands the common design-tool aliases', () => {
    const aliased = extractTheme(SPARSE_MOCKUP, { id: 'aliased' })
    expect(aliased.vars['--bg-base']).toBe('#101014')
    expect(aliased.vars['--accent']).toBe('#7c5cff')
    expect(aliased.vars['--text-primary']).toBe('#f2f2f7')
    expect(aliased.report.mapped).toEqual(['--bg-base', '--accent', '--text-primary'])
  })

  it('accepts --destructive in the source as the DANGER colour (never as itself)', () => {
    const out2 = extractTheme(':root{--background:#0b0b0b;--primary:#7c5cff;--foreground:#fff;--destructive:#ef4444}', {
      id: 'd',
    })
    expect(out2.vars['--danger']).toBe('#ef4444')
    expect(out2.vars['--destructive']).toBe('var(--danger)')
  })
})

describe('extractTheme — synthesis rules', () => {
  const out = extractTheme(SPARSE_MOCKUP, { id: 'sparse', label: 'Sparse' })

  it('fills every one of the 24 contract variables', () => {
    expect(out.report.missing).toEqual([])
    for (const name of THEME_VAR_NAMES) expect(out.vars[name], name).toBeTruthy()
  })

  it('pins --destructive to the literal var(--danger) alias', () => {
    expect(out.vars['--destructive']).toBe('var(--danger)')
    expect(out.report.synthesized).toContain('--destructive')
  })

  it('builds both hard shadows off the DARKEST background', () => {
    const backgrounds = ['--bg-base', '--bg-surface', '--bg-elevated', '--bg-inset', '--bg-sidebar'] as const
    const darkest = backgrounds
      .map((n) => parseColor(out.vars[n]!)!)
      .reduce((a, b) => (a.r + a.g + a.b <= b.r + b.g + b.b ? a : b))
    const ink = `#${[darkest.r, darkest.g, darkest.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
    expect(out.vars['--shadow-hard']).toBe(`2px 2px 0 ${ink}`)
    expect(out.vars['--shadow-hard-lg']).toBe(`6px 6px 0 ${ink}`)
    expect(out.vars['--shadow-soft']).toBe(`2px 2px 0 rgba(${darkest.r},${darkest.g},${darkest.b},0.3)`)
  })

  it('defaults --border-width to 2px', () => {
    expect(out.vars['--border-width']).toBe('2px')
  })

  it('derives --accent-muted as 15% accent over the base background', () => {
    // #7c5cff at 15% over #101014 → (28,26,45)-ish. Assert the maths, not a
    // hand-copied hex: 0.15*accent + 0.85*base per channel.
    const accent = parseColor('#7c5cff')!
    const base = parseColor('#101014')!
    const expected = {
      r: Math.round(accent.r * 0.15 + base.r * 0.85),
      g: Math.round(accent.g * 0.15 + base.g * 0.85),
      b: Math.round(accent.b * 0.15 + base.b * 0.85),
    }
    expect(parseColor(out.vars['--accent-muted']!)).toEqual(expected)
  })

  it('derives --accent-text so it clears 4.5:1 on the base background', () => {
    const fg = parseColor(out.vars['--accent-text']!)!
    const bg = parseColor(out.vars['--bg-base']!)!
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it('derives --text-muted so it clears 4.5:1 on base AND surface', () => {
    const fg = parseColor(out.vars['--text-muted']!)!
    expect(contrastRatio(fg, parseColor(out.vars['--bg-base']!)!)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(fg, parseColor(out.vars['--bg-surface']!)!)).toBeGreaterThanOrEqual(4.5)
  })

  const sum = (v: string) => {
    const c = parseColor(v)!
    return c.r + c.g + c.b
  }

  it('elevates surfaces and sinks the inset on a DARK palette', () => {
    expect(sum(out.vars['--bg-surface']!)).toBeGreaterThan(sum(out.vars['--bg-base']!))
    expect(sum(out.vars['--bg-elevated']!)).toBeGreaterThan(sum(out.vars['--bg-surface']!))
    expect(sum(out.vars['--bg-inset']!)).toBeLessThan(sum(out.vars['--bg-base']!))
    expect(out.vars['--bg-sidebar']).toBe(out.vars['--bg-elevated'])
  })

  it('flips the elevation direction for a LIGHT palette, inset still sinks', () => {
    const light = extractTheme(':root{--background:#f0ece4;--primary:#3b2fd4;--foreground:#141414}', { id: 'light' })
    expect(sum(light.vars['--bg-surface']!)).toBeLessThan(sum(light.vars['--bg-base']!))
    expect(sum(light.vars['--bg-elevated']!)).toBeLessThan(sum(light.vars['--bg-surface']!))
    expect(sum(light.vars['--bg-inset']!)).toBeLessThan(sum(light.vars['--bg-elevated']!))
  })

  it('keeps every tier distinct even on a pure-black base', () => {
    const black = extractTheme(':root{--background:#000000;--primary:#7c5cff;--foreground:#ffffff}', { id: 'black' })
    const tiers = ['--bg-base', '--bg-surface', '--bg-elevated', '--bg-inset'] as const
    expect(new Set(tiers.map((t) => black.vars[t])).size).toBe(tiers.length)
  })

  it('reports everything it could not derive when the source has no palette', () => {
    const empty = extractTheme('<html><body><div>no styles here</div></body></html>', { id: 'empty' })
    expect(empty.report.mapped).toEqual([])
    // Only the palette-independent slots survive: the four semantic defaults,
    // their --destructive alias, and the 2px border width.
    expect([...empty.report.synthesized].sort()).toEqual(
      ['--border-width', '--danger', '--destructive', '--info', '--success', '--warning'].sort(),
    )
    expect(empty.report.missing.length).toBe(THEME_VAR_NAMES.length - 6)
    expect(empty.vars['--border-width']).toBe('2px')
  })
})

describe('extractTheme — emitted CSS', () => {
  const out = extractTheme(FULL_MOCKUP, { id: 'neo', label: 'Neo' })

  it('emits exactly one rule, scoped to the custom theme id', () => {
    const selectors: string[] = []
    forEachRule(out.css, (sel) => selectors.push(sel))
    expect(selectors).toEqual([':root[data-theme="custom:neo"]'])
  })

  it('carries a header comment with the report counts', () => {
    expect(out.css).toContain('/* Custom theme "Neo" — custom:neo')
    expect(out.css).toMatch(/\d+ mapped · \d+ synthesized · \d+ missing\./)
  })

  it('emits the variables in contract order', () => {
    const order = [...out.css.matchAll(/^\s{2}(--[\w-]+):/gm)].map((m) => m[1])
    expect(order).toEqual(THEME_VAR_NAMES.filter((n) => out.vars[n] !== undefined))
  })

  it('never emits a cursor declaration, a url() or an unscoped rule', () => {
    const hostile = extractTheme(
      ':root{--background:#0b0b0b;--primary:#7c5cff;--foreground:#fff;--bg-surface:url(http://evil/x.png);--border: red} .evil{color:red}',
      { id: 'hostile' },
    )
    expect(hostile.css).not.toMatch(/cursor\s*:/)
    expect(hostile.css).not.toMatch(/url\s*\(/)
    expect(hostile.css).not.toContain('.evil')
    // The hostile --border value closed the block early: it is rejected, not emitted.
    expect(hostile.report.rejected.map((r) => r.name)).toContain('--bg-surface')
  })

  it('strips a comment-terminator smuggled into the label', () => {
    const out2 = extractTheme(SPARSE_MOCKUP, { id: 'x', label: 'evil*/ body{display:none} /*' })
    const selectors: string[] = []
    forEachRule(out2.css, (sel) => selectors.push(sel))
    expect(selectors).toEqual([':root[data-theme="custom:x"]'])
  })
})

// ── Structure layer ─────────────────────────────────────────────────────────
// The SECOND sheet a Claude Design handoff ships: geometry, texture and
// keyframes. Three things have to hold before it may sit next to every other
// imported theme in the one shared <style> element — RESCOPE, RENAME, REFUSE
// (see the "Structure layer" header in theme-extract.ts).

/** A miniature of the shipped themes/<id>-structure.css handoffs. */
const STRUCTURE_SHEET = `
/* structure layer */
:root[data-theme="tachi-opus5"] button:not(:disabled) {
  clip-path: polygon(9px 0, 100% 0, 0 100%);
}
:root[data-theme="tachi-opus5"] button:not(
    [style*="background: transparent"],
    [style*="background: none"]
  ) {
  filter: drop-shadow(3px 3px 0 var(--accent));
}
.tachi-run-dot { animation: opus5-signal 1.4s ease-out infinite, tachi-pulse 1.2s ease-in-out infinite; }
@keyframes opus5-signal { 0% { opacity: 1; } 100% { opacity: 0.2; } }
@media (prefers-reduced-motion: reduce) {
  .tachi-run-dot { animation: none !important; }
}
`

const structure = (css: string, themeId = 'custom:neo') => extractStructureCss(css, { themeId })

describe('rescopeSelector', () => {
  it('retargets an existing data-theme filter, whatever it was authored against', () => {
    expect(rescopeSelector(':root[data-theme="tachi-opus5"] button', 'custom:neo'))
      .toBe(':root[data-theme="custom:neo"] button')
    expect(rescopeSelector(":root[data-theme='comic'] .card", 'custom:neo'))
      .toBe(':root[data-theme="custom:neo"] .card')
  })

  it('grows the attribute onto a bare :root / html, and prefixes everything else', () => {
    expect(rescopeSelector(':root', 'custom:neo')).toBe(':root[data-theme="custom:neo"]')
    expect(rescopeSelector('html body', 'custom:neo')).toBe(':root[data-theme="custom:neo"] body')
    expect(rescopeSelector('body', 'custom:neo')).toBe(':root[data-theme="custom:neo"] body')
    expect(rescopeSelector('button.primary', 'custom:neo')).toBe(':root[data-theme="custom:neo"] button.primary')
  })

  it('scopes every branch of a comma list', () => {
    expect(rescopeSelector('button, .card, :root .rail', 'custom:neo').split(',\n')).toEqual([
      ':root[data-theme="custom:neo"] button',
      ':root[data-theme="custom:neo"] .card',
      ':root[data-theme="custom:neo"] .rail',
    ])
  })

  it('does not cut inside :not(a, b) — the shipped ghost-button exclusion', () => {
    const out = rescopeSelector('button:not([style*="background: transparent"], [style*="background: none"])', 'custom:neo')
    expect(splitTopLevel(out, ',')).toHaveLength(1)
    expect(out).toContain('background: none')
  })
})

describe('extractStructureCss — rescoping', () => {
  const out = structure(STRUCTURE_SHEET)

  it('accepts the sheet and scopes every rule to the custom theme', () => {
    expect(out.ok).toBe(true)
    expect(out.rules).toBeGreaterThan(3)
    forEachRule(out.css, (sel) => {
      if (sel.startsWith('@')) return
      if (/^(\d|from\b|to\b)/.test(sel)) return // keyframe steps are not selectors
      for (const part of splitTopLevel(sel, ',')) expect(part).toContain('[data-theme="custom:neo"]')
    })
  })

  it('rescopes rules nested inside @media and keeps the at-rule itself', () => {
    expect(out.css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:root\[data-theme="custom:neo"\] \.tachi-run-dot/)
  })

  it('leaves the original theme behind — nothing paints under the old id', () => {
    expect(out.css).not.toContain('tachi-opus5')
  })

  it('returns an EMPTY (not failed) result for a palette-only source', () => {
    const none = structure(':root { --bg-base: #000; --accent: #7c5cff; }')
    expect(none.ok).toBe(true)
    expect(none.css).toBe('')
    expect(none.rules).toBe(0)
  })
})

describe('extractStructureCss — keyframe prefixing', () => {
  const out = structure(STRUCTURE_SHEET)

  it('prefixes the names the sheet DEFINES, per theme', () => {
    expect(out.keyframes).toEqual(['custom-neo-opus5-signal'])
    expect(out.css).toContain('@keyframes custom-neo-opus5-signal')
  })

  it('rewrites the animation references to the prefixed name', () => {
    expect(out.css).toContain('custom-neo-opus5-signal 1.4s ease-out infinite')
  })

  it('leaves a name the sheet does NOT define alone (globals.css owns it)', () => {
    expect(out.css).toContain('tachi-pulse 1.2s')
    expect(out.css).not.toContain('custom-neo-tachi-pulse')
  })

  it('gives two themes importing the SAME sheet different keyframe names', () => {
    expect(structure(STRUCTURE_SHEET, 'custom:a').keyframes).toEqual(['custom-a-opus5-signal'])
    expect(structure(STRUCTURE_SHEET, 'custom:b').keyframes).toEqual(['custom-b-opus5-signal'])
  })
})

describe('extractStructureCss — refusals', () => {
  it('REFUSES the whole layer on a </style> breakout', () => {
    const out = structure('.a { color: red } /* </style><script>x()</script> */')
    expect(out.ok).toBe(false)
    expect(out.css).toBe('')
    expect(out.errors.join(' ')).toContain('</style')
  })

  it('REFUSES an oversized sheet', () => {
    const out = structure('.a { color: red }'.padEnd(MAX_STRUCTURE_CSS_CHARS + 1, ' '))
    expect(out.ok).toBe(false)
    expect(out.css).toBe('')
    expect(out.errors.join(' ')).toContain('over the')
  })

  it('strips @import instead of pulling in a remote stylesheet', () => {
    const out = structure('@import url("https://evil.example/x.css");\n.a { color: red }')
    expect(out.ok).toBe(true)
    expect(out.css).not.toContain('@import')
    expect(out.css).toContain('color: red')
    expect(out.dropped.join(' ')).toContain('another stylesheet')
  })

  it('strips declarations reaching for an external url(), in every shape', () => {
    const out = structure(`
      .a { background-image: url(https://evil.example/x.png); color: red }
      .b { background: url("//evil.example/y.png") }
      .c { background: url('http://evil.example/z.png') }
    `)
    expect(out.css).not.toMatch(/evil\.example/)
    expect(out.css).toContain('color: red')
    expect(out.dropped).toHaveLength(3)
  })

  it('keeps a data: URI — the only scheme a theme may reach for', () => {
    const out = structure('.a { background-image: url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=") }')
    expect(out.ok).toBe(true)
    expect(out.css).toContain('data:image/svg+xml;base64,')
    expect(out.dropped).toEqual([])
  })

  it('strips a cursor declaration — globals.css owns the resize affordance', () => {
    const out = structure('.a { cursor: pointer; color: red }')
    expect(out.css).not.toMatch(/cursor\s*:/)
    expect(out.css).toContain('color: red')
    expect(out.dropped.join(' ')).toContain('cursor')
  })

  it('strips legacy script vectors', () => {
    const out = structure('.a { width: expression(alert(1)); background: javascript:void(0); color: red }')
    expect(out.css).not.toMatch(/expression\s*\(|javascript\s*:/)
    expect(out.css).toContain('color: red')
  })

  it('strips at-rules that cannot be scoped to one theme', () => {
    const out = structure('@font-face { font-family: X; src: url(x.woff2) }\n@property --p { syntax: "color" }\n.a{color:red}')
    expect(out.css).not.toContain('@font-face')
    expect(out.css).not.toContain('@property')
    expect(out.dropped.filter((d) => d.includes('cannot be scoped'))).toHaveLength(2)
  })

  it('drops the 24 palette variables (the palette block owns them), keeps the rest', () => {
    const out = structure(':root { --bg-base: #000; --accent: #7c5cff; --opus-bite-offset: 3px }')
    expect(out.css).toContain('--opus-bite-offset: 3px')
    expect(out.css).not.toContain('--bg-base')
    expect(out.css).not.toContain('--accent:')
    expect(out.dropped.join(' ')).toContain('palette variable')
  })
})

describe('extractTheme — structure integration', () => {
  it('picks up the structural CSS a mockup carries beyond the palette', () => {
    const out = extractTheme(FULL_MOCKUP, { id: 'neo' })
    expect(out.structureCss).toContain(':root[data-theme="custom:neo"] body')
    expect(out.css).not.toContain('body') // the palette block is still palette-only
  })

  it('merges a companion structure sheet with the mockup', () => {
    const out = extractTheme(SPARSE_MOCKUP, { id: 'neo', structureSource: STRUCTURE_SHEET })
    expect(out.structure.ok).toBe(true)
    expect(out.structureCss).toContain('@keyframes custom-neo-opus5-signal')
    expect(out.structureCss).toContain('/* Structure layer for "neo" — custom:neo')
  })

  it('leaves structureCss undefined for a palette-only import (the legacy shape)', () => {
    const out = extractTheme(SPARSE_MOCKUP, { id: 'neo' })
    expect(out.structureCss).toBeUndefined()
    expect(out.structure).toMatchObject({ ok: true, css: '', errors: [], rules: 0, keyframes: [] })
    // The mockup's palette declarations went to the palette block, not here.
    expect(out.structure.dropped.join(' ')).toContain('palette variable')
  })

  it('leaves structureCss undefined when the layer is REFUSED — never half-applied', () => {
    const out = extractTheme(SPARSE_MOCKUP, { id: 'neo', structureSource: '.a{color:red} /* </style> */' })
    expect(out.structure.ok).toBe(false)
    expect(out.structureCss).toBeUndefined()
    expect(out.structure.errors).toHaveLength(1)
  })

  it('honours includeStructure: false (palette-only import)', () => {
    const out = extractTheme(SPARSE_MOCKUP, { id: 'neo', structureSource: STRUCTURE_SHEET, includeStructure: false })
    expect(out.structureCss).toBeUndefined()
    expect(out.structure.rules).toBe(0)
  })
})
