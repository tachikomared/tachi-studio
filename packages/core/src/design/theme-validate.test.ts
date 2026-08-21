// packages/core/src/design/theme-validate.test.ts
//
// One describe per rule, plus a PASSING fixture (the shipped tachi-dark palette
// re-scoped as a custom theme) so a future tightening of the rules that would
// reject our own house style fails here first.

import { describe, it, expect } from 'vitest'
import { validateThemeCss, TEXT_CONTRAST_PAIRS, LARGE_CONTRAST_PAIRS } from './theme-validate.js'
import { extractTheme, THEME_VAR_NAMES } from './theme-extract.js'
import { parseColor, rgbToHsl } from './theme-color.js'

/** apps/desktop/src/themes/tachi-dark.css, verbatim values, custom-scoped. */
const TACHI_DARK = `:root[data-theme="custom:house"] {
  --bg-base:       #0f0f0f;
  --bg-surface:    #111111;
  --bg-elevated:   #141414;
  --bg-inset:      #0a0a0a;
  --bg-sidebar:    #141414;
  --accent:        #6b38d4;
  --accent-hover:  #8455ef;
  --accent-alt:    #d43f00;
  --accent-muted:  #1e1530;
  --accent-text:   #d0bcff;
  --text-primary:  #f5f5f0;
  --text-muted:    #888888;
  --text-dim:      #444444;
  --border:        #2a2a2a;
  --border-strong: #3a3a3a;
  --destructive:   var(--danger);
  --success:       #52c41a;
  --warning:       #faad14;
  --danger:        #ff5252;
  --info:          #60a5fa;
  --shadow-hard:   2px 2px 0 #000000;
  --shadow-hard-lg: 6px 6px 0 #000000;
  --shadow-soft:   2px 2px 0 rgba(0,0,0,0.3);
  --border-width:  2px;
}`

const withVar = (css: string, name: string, value: string) =>
  css.replace(new RegExp(`(${name}:\\s*)([^;]+);`), `$1${value};`)

describe('passing fixture', () => {
  const result = validateThemeCss(TACHI_DARK)

  it('accepts the shipped house palette', () => {
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('resolves --destructive through the var(--danger) alias', () => {
    const pair = result.contrast.find((c) => c.fg === '--danger' && c.bg === '--bg-surface')
    expect(pair?.passes).toBe(true)
    expect(result.vars['--destructive']).toBe('var(--danger)')
  })

  it('still WARNS about the deliberately low-contrast hairline border', () => {
    const border = result.warnings.find((w) => w.vars?.[0] === '--border')
    expect(border?.rule).toBe('contrast-large')
    expect(border?.ratio).toBeLessThan(3)
    expect(border?.suggestion).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('measures every declared pair', () => {
    expect(result.contrast.length).toBe(TEXT_CONTRAST_PAIRS.length + LARGE_CONTRAST_PAIRS.length)
  })
})

describe('completeness', () => {
  it('errors listing every missing contract variable', () => {
    const result = validateThemeCss(':root[data-theme="custom:x"] { --bg-base: #000; }')
    const issue = result.errors.find((e) => e.rule === 'completeness')
    expect(issue).toBeDefined()
    expect(issue!.vars).toHaveLength(THEME_VAR_NAMES.length - 1)
    expect(issue!.message).toContain('--accent')
    expect(result.ok).toBe(false)
  })

  it('errors on an empty sheet', () => {
    const result = validateThemeCss('/* nothing here */')
    expect(result.errors.some((e) => e.message.includes('empty'))).toBe(true)
  })
})

describe('contrast', () => {
  it('errors on text below 4.5:1 and suggests a same-hue fix', () => {
    const css = withVar(TACHI_DARK, '--text-muted', '#3a3a3a')
    const result = validateThemeCss(css)
    const issue = result.errors.find((e) => e.rule === 'contrast' && e.vars?.[0] === '--text-muted')
    expect(issue).toBeDefined()
    expect(issue!.required).toBe(4.5)
    expect(issue!.ratio).toBeLessThan(4.5)
    // The suggestion keeps the (grey) hue and lightens until it passes.
    const fixed = validateThemeCss(withVar(TACHI_DARK, '--text-muted', issue!.suggestion!))
    expect(fixed.errors.filter((e) => e.vars?.[0] === '--text-muted')).toEqual([])
  })

  it('warns (never errors) when a large/border pair is below 3:1', () => {
    const css = withVar(TACHI_DARK, '--accent', '#1a1035')
    const result = validateThemeCss(css)
    expect(result.warnings.some((w) => w.rule === 'contrast-large' && w.vars?.[0] === '--accent')).toBe(true)
    expect(result.errors.some((e) => e.rule === 'contrast-large')).toBe(false)
  })

  it('skips a pair it cannot parse instead of inventing a ratio', () => {
    const result = validateThemeCss(withVar(TACHI_DARK, '--bg-elevated', 'transparent'))
    expect(result.contrast.some((c) => c.bg === '--bg-elevated')).toBe(false)
    expect(result.errors.filter((e) => e.rule === 'contrast')).toEqual([])
  })

  it('keeps the HUE in the suggested fix (it is a lightness nudge, not a recolour)', () => {
    const result = validateThemeCss(withVar(TACHI_DARK, '--info', '#0d1a4f'))
    const issue = result.errors.find((e) => e.vars?.[0] === '--info')
    expect(issue?.suggestion).toMatch(/^#[0-9a-f]{6}$/)
    const hue = (hex: string) => rgbToHsl(parseColor(hex)!).h
    expect(Math.abs(hue(issue!.suggestion!) - hue('#0d1a4f'))).toBeLessThan(3)
  })
})

describe('cursor', () => {
  it('errors on a cursor declaration anywhere in the sheet', () => {
    const css = `${TACHI_DARK}\n:root[data-theme="custom:house"] button { cursor: pointer; }`
    const result = validateThemeCss(css)
    expect(result.errors.some((e) => e.rule === 'cursor')).toBe(true)
  })

  it('errors when a cursor is smuggled inside a custom-property value', () => {
    const css = TACHI_DARK.replace('--border-width:  2px;', '--border-width:  2px; --x: cursor: pointer;')
    expect(validateThemeCss(css).errors.some((e) => e.rule === 'cursor')).toBe(true)
  })
})

describe('ghost-shadow', () => {
  const rule = (selector: string) => `${TACHI_DARK}\n${selector} { filter: drop-shadow(2px 2px 0 #000); }`

  it('errors when a button drop-shadow rule does not exclude ghost buttons', () => {
    const result = validateThemeCss(rule(':root[data-theme="custom:house"] button'))
    expect(result.errors.some((e) => e.rule === 'ghost-shadow')).toBe(true)
  })

  it('accepts the rule once BOTH transparent-background exclusions are present', () => {
    const selector =
      ':root[data-theme="custom:house"] button:not([style*="background: transparent"]):not([style*="background: none"])'
    const result = validateThemeCss(rule(selector))
    expect(result.errors.some((e) => e.rule === 'ghost-shadow')).toBe(false)
  })

  it('ignores drop-shadows on non-button selectors', () => {
    const result = validateThemeCss(rule(':root[data-theme="custom:house"] .card'))
    expect(result.errors.some((e) => e.rule === 'ghost-shadow')).toBe(false)
  })
})

describe('scope', () => {
  it('errors on a rule that is not scoped to the custom theme', () => {
    const result = validateThemeCss(`${TACHI_DARK}\nbody { background: red; }`)
    const issue = result.errors.find((e) => e.rule === 'scope')
    expect(issue?.selector).toBe('body')
  })

  it('errors on a selector list where only SOME parts are scoped', () => {
    const result = validateThemeCss(`${TACHI_DARK}\n:root[data-theme="custom:house"] .a, .b { color: red; }`)
    expect(result.errors.some((e) => e.rule === 'scope')).toBe(true)
  })

  it('errors on any at-rule', () => {
    const result = validateThemeCss(`@import url("evil.css");\n${TACHI_DARK}`)
    expect(result.errors.some((e) => e.rule === 'scope' && e.selector?.startsWith('@'))).toBe(true)
  })

  it('errors when the sheet is scoped to a DIFFERENT theme id than expected', () => {
    const result = validateThemeCss(TACHI_DARK, { themeId: 'custom:other' })
    expect(result.errors.some((e) => e.rule === 'scope')).toBe(true)
  })

  it('errors when nothing is scoped under a custom data-theme at all', () => {
    const result = validateThemeCss(':root { --bg-base: #000; }')
    expect(result.errors.some((e) => e.rule === 'scope')).toBe(true)
  })
})

describe('extractor output validates clean', () => {
  const cases: Array<[string, string]> = [
    ['dark, sparse', ':root{--background:#101014;--primary:#7c5cff;--foreground:#f2f2f7}'],
    ['light, sparse', ':root{--background:#f7f5f0;--primary:#3b2fd4;--foreground:#141414}'],
    ['light, near-white', ':root{--background:#ffffff;--primary:#8a2be2;--foreground:#111111}'],
    ['dark, black', ':root{--background:#000000;--primary:#00e5a0;--foreground:#e8e8e8}'],
  ]

  for (const [name, source] of cases) {
    it(`${name}: extract -> validate produces no errors`, () => {
      const theme = extractTheme(source, { id: name })
      const result = validateThemeCss(theme.css, { themeId: theme.themeId })
      expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([])
    })
  }
})
