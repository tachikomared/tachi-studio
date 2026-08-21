// packages/core/src/design/theme-extract.ts
//
// "Claude Design mockup -> living app theme", step 1: pull a palette out of a
// generated HTML document (or a bare .css file) and re-emit it as ONE scoped
// custom-property block the app can inject at runtime.
//
// The contract is apps/desktop/src/themes/tachi-dark.css — 24 variables in six
// groups (5 bg · 5 accent · 3 text · 2 border · 5 semantic · 4 shadow/geometry).
// A mockup never ships all 24 under our names, so this module does three
// things:
//
//   1. MAP    — take a declaration whose name matches ours, or one of the
//               well-known aliases a design tool emits (--background,
//               --foreground, --primary, --muted-foreground, ...).
//   2. SYNTH  — derive what's missing from what's present, with the rules the
//               research doc pinned down: --destructive is LITERALLY
//               `var(--danger)`, shadows come off the darkest background,
//               --border-width defaults to 2px, --accent-muted/--accent-text
//               are derived from --accent.
//   3. SCOPE  — emit everything inside `:root[data-theme="custom:<id>"]` and
//               nothing else, so the sheet is inert until that theme is active.
//
// Everything a mockup declares OUTSIDE those custom properties is dropped by
// extractTheme's palette pass: that pass produces a PALETTE, never structure.
// That is also what keeps the generated CSS safe (see SANITIZER below) — a
// value that could break out of the block, smuggle a `cursor:` past the
// theme-sheet guard (apps/desktop/test/unit/resizeCursor.test.ts) or pull in a
// remote URL is rejected rather than escaped.
//
// The geometry a mockup carries is NOT lost, it just travels in a second,
// separately-guarded sheet — see "Structure layer" at the foot of this file.
//
// Pure functions only — no DOM, no fs. theme-validate.ts double-checks the
// output; the two are deliberately independent implementations of the rules.

import {
  contrastRatio,
  isDark,
  mix,
  parseColor,
  relativeLuminance,
  rotateHue,
  shade,
  suggestContrastFix,
  toHex,
  type Rgb,
} from './theme-color.js'

// ── The 24-variable contract ────────────────────────────────────────────────

/** Every variable a theme sheet must define, in emission order. */
export const THEME_VAR_NAMES = [
  // backgrounds (5)
  '--bg-base',
  '--bg-surface',
  '--bg-elevated',
  '--bg-inset',
  '--bg-sidebar',
  // accent (5)
  '--accent',
  '--accent-hover',
  '--accent-alt',
  '--accent-muted',
  '--accent-text',
  // text (3)
  '--text-primary',
  '--text-muted',
  '--text-dim',
  // borders (2)
  '--border',
  '--border-strong',
  // semantic (5)
  '--destructive',
  '--success',
  '--warning',
  '--danger',
  '--info',
  // shadow / geometry (4)
  '--shadow-hard',
  '--shadow-hard-lg',
  '--shadow-soft',
  '--border-width',
] as const

export type ThemeVarName = (typeof THEME_VAR_NAMES)[number]

/**
 * Alias table: names a design tool/mockup commonly uses for each of our slots.
 * Deliberately conservative — a wrong alias silently produces a wrong theme,
 * which is worse than reporting the slot as synthesized. Notably absent:
 * shadcn's `--primary-foreground` (text ON the accent) is NOT our
 * `--accent-text` (accent-tinted text on the base background).
 */
const ALIASES: Record<ThemeVarName, readonly string[]> = {
  '--bg-base': ['--background', '--bg', '--bg-primary', '--color-bg', '--body-bg', '--base'],
  '--bg-surface': ['--surface', '--bg-secondary', '--panel', '--card', '--color-surface'],
  '--bg-elevated': ['--elevated', '--bg-tertiary', '--popover', '--card-elevated', '--surface-2'],
  '--bg-inset': ['--inset', '--bg-sunken', '--well', '--surface-sunken'],
  '--bg-sidebar': ['--sidebar', '--sidebar-bg', '--nav-bg', '--sidebar-background'],
  '--accent': ['--primary', '--brand', '--color-primary', '--accent-color', '--brand-primary'],
  '--accent-hover': ['--primary-hover', '--brand-hover', '--accent-hovered', '--primary-600'],
  '--accent-alt': ['--secondary', '--accent-2', '--brand-secondary', '--accent-secondary'],
  '--accent-muted': ['--primary-muted', '--accent-bg', '--primary-subtle', '--accent-subtle'],
  '--accent-text': ['--accent-fg', '--accent-foreground', '--link', '--link-color'],
  '--text-primary': ['--foreground', '--text', '--fg', '--color-text', '--text-color', '--body-color'],
  '--text-muted': ['--muted-foreground', '--text-secondary', '--muted-text', '--text-muted-color'],
  '--text-dim': ['--text-tertiary', '--text-disabled', '--text-faint', '--text-subtle'],
  '--border': ['--border-color', '--divider', '--rule', '--stroke', '--outline'],
  '--border-strong': ['--border-heavy', '--divider-strong', '--border-emphasis', '--stroke-strong'],
  // --destructive is never taken from source: the contract pins it to var(--danger).
  '--destructive': [],
  '--success': ['--green', '--positive', '--ok', '--success-color'],
  '--warning': ['--yellow', '--amber', '--caution', '--warn', '--warning-color'],
  '--danger': ['--error', '--red', '--negative', '--destructive', '--danger-color'],
  '--info': ['--blue', '--informational', '--info-color'],
  '--shadow-hard': ['--shadow', '--box-shadow', '--shadow-md'],
  '--shadow-hard-lg': ['--shadow-lg', '--shadow-large', '--shadow-xl'],
  '--shadow-soft': ['--shadow-sm', '--shadow-small'],
  '--border-width': ['--stroke-width', '--border-size'],
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ThemeExtractReport {
  /** Variables taken straight from the source (own name or alias). */
  mapped: ThemeVarName[]
  /** Variables derived from other variables by the synthesis rules. */
  synthesized: ThemeVarName[]
  /** Variables that could be neither mapped nor derived — the theme is incomplete. */
  missing: ThemeVarName[]
  /** Source declarations dropped by the sanitizer, with the reason. */
  rejected: Array<{ name: string; value: string; reason: string }>
}

export interface ExtractedTheme {
  /** Slug WITHOUT the prefix — the persisted CustomTheme.id. */
  slug: string
  /** The value written to `data-theme` / AppSettings.theme. */
  themeId: `custom:${string}`
  label: string
  /** A complete, scoped `:root[data-theme="custom:<slug>"] { … }` block. */
  css: string
  /**
   * The rescoped structure layer, present ONLY when the import carried usable
   * geometry. Persisted as CustomTheme.structureCss and injected right after
   * `css`; an import without one is a palette-only theme, exactly as before.
   */
  structureCss?: string
  /** What the structure pass found, kept and refused — always present. */
  structure: StructureExtractResult
  /** Resolved value per emitted variable (swatch previews read this). */
  vars: Partial<Record<ThemeVarName, string>>
  report: ThemeExtractReport
}

export interface ExtractThemeOptions {
  /** Raw id; slugified. Falls back to the label, then to "imported". */
  id?: string
  /** Human label shown in Settings. Falls back to the id. */
  label?: string
  /**
   * An optional companion structure sheet picked alongside the mockup (a real
   * Claude Design handoff ships `<id>.css` + `<id>-structure.css`). Merged with
   * whatever structural CSS `source` itself carries.
   */
  structureSource?: string
  /** Set false to import the palette only. Defaults to true. */
  includeStructure?: boolean
}

// ── CSS reading ─────────────────────────────────────────────────────────────

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Walk top-level rules of a stylesheet. At-rules are reported with their own
 * selector (`@media (…)`) AND recursed into, so `:root` inside `@media` is
 * still seen by the extractor and still flagged by the validator.
 */
export function forEachRule(css: string, visit: (selector: string, body: string) => void): void {
  const src = stripComments(css)
  let i = 0
  let selStart = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      const selector = src.slice(selStart, i).trim()
      let depth = 1
      let j = i + 1
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        j++
      }
      const body = src.slice(i + 1, depth === 0 ? j - 1 : src.length)
      visit(selector, body)
      if (selector.startsWith('@') && body.includes('{')) forEachRule(body, visit)
      i = j
      selStart = i
    } else if (ch === '}') {
      i++
      selStart = i
    } else {
      i++
    }
  }
}

/** `prop: value` pairs of a declaration body (nested rules are skipped). */
export function parseDeclarations(body: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = []
  // Drop nested blocks entirely — their declarations belong to another rule.
  const flat = body.replace(/\{[^{}]*\}/g, '')
  for (const chunk of flat.split(';')) {
    const idx = chunk.indexOf(':')
    if (idx === -1) continue
    const prop = chunk.slice(0, idx).trim()
    const value = chunk.slice(idx + 1).trim()
    if (!prop || !value) continue
    if (/[{}]/.test(prop)) continue
    out.push({ prop, value })
  }
  return out
}

/** `:root`, `html`, `body`, optionally with ONE attribute filter. */
const ROOT_SELECTOR = /^(:root|html|body)(\s*\[[^\]]*\])?$/

const isRootSelector = (selector: string) =>
  selector
    .split(',')
    .map((s) => s.trim())
    .some((s) => ROOT_SELECTOR.test(s))

/** `<style>` block contents; the whole input when it has none (a .css file). */
export function collectStyleSheets(source: string): string[] {
  const blocks: string[] = []
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) blocks.push(m[1] ?? '')
  if (blocks.length > 0) return blocks
  // No <style> at all: treat the input as a stylesheet, unless it is clearly a
  // document (an HTML file whose styling lives in attributes/classes only).
  // Comments are stripped before the probe — a .css file is allowed to MENTION
  // `<div>` in a comment without being mistaken for markup.
  const probe = stripComments(source).replace(/<!--[\s\S]*?-->/g, '')
  return /<html|<body|<div|<main|<section/i.test(probe) ? [] : [source]
}

// ── Sanitizer ───────────────────────────────────────────────────────────────

/**
 * A custom-property value is only allowed to be a colour/length/shadow-ish
 * token list. Everything below either breaks OUT of the generated block, drags
 * in remote content, or smuggles a declaration the theme guards forbid:
 *
 *   `}` `{`   — closes our rule and starts an unscoped one
 *   `;`       — cannot occur in a parsed declaration, belt-and-braces
 *   `@`       — @import / at-rule injection
 *   `<` `>`   — `</style>` breakout when the sheet is injected as text
 *   url( )    — remote fetch from a theme file (CSP + privacy)
 *   cursor:   — the theme-sheet cursor ban (resizeCursor.test.ts)
 *   expression(/javascript: — legacy script vectors
 */
const UNSAFE_VALUE = /[{}<>;@]|url\s*\(|expression\s*\(|javascript\s*:|cursor\s*:|\/\*/i

const MAX_VALUE_LEN = 200

function sanitizeValue(value: string): { ok: true; value: string } | { ok: false; reason: string } {
  const v = value.trim().replace(/\s*!important\s*$/i, '')
  if (!v) return { ok: false, reason: 'empty value' }
  if (v.length > MAX_VALUE_LEN) return { ok: false, reason: `value longer than ${MAX_VALUE_LEN} chars` }
  const bad = UNSAFE_VALUE.exec(v)
  if (bad) return { ok: false, reason: `value contains a forbidden token (${bad[0].trim()})` }
  return { ok: true, value: v }
}

// ── Variable collection ─────────────────────────────────────────────────────

export interface CollectedVars {
  /** Sanitised custom properties declared on a root selector, last wins. */
  vars: Record<string, string>
  rejected: Array<{ name: string; value: string; reason: string }>
}

/**
 * Collect custom-property declarations from `:root` / `:root[data-theme=…]` /
 * `html` / `body` rules across every `<style>` block of the document.
 * Source order decides: a later declaration overwrites an earlier one, which
 * mirrors the cascade for equal-specificity rules.
 */
export function collectRootVariables(source: string): CollectedVars {
  const vars: Record<string, string> = {}
  const rejected: Array<{ name: string; value: string; reason: string }> = []
  for (const sheet of collectStyleSheets(source)) {
    forEachRule(sheet, (selector, body) => {
      if (selector.startsWith('@')) return
      if (!isRootSelector(selector)) return
      for (const { prop, value } of parseDeclarations(body)) {
        if (!prop.startsWith('--')) continue
        const clean = sanitizeValue(value)
        if (!clean.ok) {
          rejected.push({ name: prop, value, reason: clean.reason })
          continue
        }
        vars[prop] = clean.value
      }
    })
  }
  return { vars, rejected }
}

/** Resolve `var(--x, fallback)` chains against the collected pool. */
export function resolveValue(value: string, pool: Record<string, string>, depth = 0): string {
  if (depth > 8 || !value.includes('var(')) return value
  const replaced = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_all, name: string, fallback?: string) => {
    const hit = pool[name]
    if (hit !== undefined) return hit
    return (fallback ?? '').trim()
  })
  if (replaced === value) return value
  return resolveValue(replaced, pool, depth + 1)
}

// ── Slug ────────────────────────────────────────────────────────────────────

/** Lower-case, `[a-z0-9-]`, max 48 chars, never empty. Mirrors the zod guard. */
export function slugifyThemeId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'imported'
}

// ── Extraction ──────────────────────────────────────────────────────────────

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** Semantic defaults, chosen per polarity so they pass 4.5:1 on the base bg. */
const SEMANTIC_DEFAULTS = {
  dark: { '--success': '#52c41a', '--warning': '#faad14', '--danger': '#ff5252', '--info': '#60a5fa' },
  light: { '--success': '#1f7a1f', '--warning': '#8a5a00', '--danger': '#c62828', '--info': '#1565c0' },
} as const

/**
 * Map + synthesize a mockup's palette into the 24-variable contract and emit a
 * single scoped block.
 *
 * Synthesis rules (all documented in the research doc, all deterministic):
 *  - surfaces step off `--bg-base` (3%/6% away from the palette's polarity);
 *    `--bg-inset` is the sunken tier and always goes DARKER; `--bg-sidebar`
 *    mirrors `--bg-elevated`.
 *  - `--accent-hover` = accent one step brighter (dark) / darker (light).
 *  - `--accent-alt` = accent hue rotated 150° (a distinguishable secondary).
 *  - `--accent-muted` = 15% accent over `--bg-base` (matches tachi-dark's
 *    #1e1530 from #6b38d4 over #0f0f0f).
 *  - `--accent-text` = accent nudged in lightness (hue preserved) until it
 *    clears 4.5:1 on `--bg-base`.
 *  - text/border tiers are `--text-primary` blended toward `--bg-base`
 *    (45% / 75% / 87% / 80%).
 *  - semantic colours fall back to polarity defaults, then get the same
 *    hue-preserving contrast nudge.
 *  - `--destructive` is LITERALLY `var(--danger)` — one semantic red.
 *  - shadows are built from the DARKEST resolved background:
 *    `2px 2px 0 <ink>`, `6px 6px 0 <ink>`, `2px 2px 0 rgba(<ink>,0.3)`.
 *  - `--border-width` defaults to `2px`.
 */
export function extractTheme(source: string, options: ExtractThemeOptions = {}): ExtractedTheme {
  const slug = slugifyThemeId(options.id || options.label || 'imported')
  const themeId = `custom:${slug}` as const
  const label = (options.label || options.id || slug).trim().slice(0, 64) || slug

  const { vars: pool, rejected } = collectRootVariables(source)

  const mapped: ThemeVarName[] = []
  const synthesized: ThemeVarName[] = []
  const missing: ThemeVarName[] = []
  const out: Partial<Record<ThemeVarName, string>> = {}

  /** Source value for a slot: own name first, then aliases, left to right. */
  const fromSource = (name: ThemeVarName): string | null => {
    const candidates = [name, ...ALIASES[name]]
    for (const candidate of candidates) {
      const raw = pool[candidate]
      if (raw === undefined) continue
      const resolved = resolveValue(raw, pool).trim()
      if (!resolved || resolved.includes('var(')) continue
      return resolved
    }
    return null
  }

  const rgbOf = (name: ThemeVarName): Rgb | null => {
    const v = out[name]
    return v ? parseColor(v) : null
  }

  /**
   * Nudge a SYNTHESIZED foreground until it clears `target` against every
   * background it is checked on (theme-validate's pairs), hue preserved. Two
   * passes because a fix for one background can cost a little contrast on
   * another; the backgrounds involved are within a few percent luminance of
   * each other, so it converges immediately in practice.
   */
  const ensureContrast = (candidate: Rgb, backgrounds: Array<Rgb | null>, target: number): string => {
    let current = candidate
    for (let pass = 0; pass < 2; pass++) {
      for (const bg of backgrounds) {
        if (!bg || contrastRatio(current, bg) >= target) continue
        const fixed = suggestContrastFix(current, bg, target)
        const parsed = fixed ? parseColor(fixed) : null
        if (parsed) current = parsed
      }
    }
    return toHex(current)
  }

  /** Take the source value when present, otherwise fall back to `derive()`. */
  const resolve = (name: ThemeVarName, derive: () => string | null): void => {
    const src = fromSource(name)
    if (src !== null) {
      out[name] = src
      mapped.push(name)
      return
    }
    const derived = derive()
    if (derived !== null) {
      out[name] = derived
      synthesized.push(name)
      return
    }
    missing.push(name)
  }

  // 1. Backgrounds — everything hangs off --bg-base.
  resolve('--bg-base', () => null)
  const base = rgbOf('--bg-base')
  const dark = base ? isDark(base) : true
  /**
   * Elevation steps AWAY from the palette's own polarity (lighter on a dark
   * base, darker on a light one) so every tier stays visible; `--bg-inset` is
   * the sunken tier and is DARKER in both polarities — which is what both
   * shipped themes do (tachi-dark #0a0a0a under #0f0f0f, bankr #ebe7e7 under
   * #fcf9f8). `distinct` flips the direction in the degenerate case (pure
   * black / pure white base) so a tier is never a no-op.
   */
  const distinct = (candidate: Rgb, from: Rgb, flipped: Rgb): string =>
    toHex(candidate.r === from.r && candidate.g === from.g && candidate.b === from.b ? flipped : candidate)
  resolve('--bg-surface', () => (base ? distinct(shade(base, 0.03, dark), base, shade(base, 0.03, !dark)) : null))
  resolve('--bg-elevated', () => (base ? distinct(shade(base, 0.06, dark), base, shade(base, 0.06, !dark)) : null))
  // Degenerate flip: a pure-black base cannot sink further, so the inset goes
  // 1.5% up — still distinct from --bg-surface's 3% step.
  resolve('--bg-inset', () =>
    base ? distinct(shade(base, dark ? 0.03 : 0.09, false), base, shade(base, 0.015, true)) : null,
  )
  resolve('--bg-sidebar', () => out['--bg-elevated'] ?? null)

  // 2. Accent family.
  resolve('--accent', () => null)
  const accent = rgbOf('--accent')
  resolve('--accent-hover', () => (accent ? toHex(shade(accent, 0.14, dark)) : null))
  resolve('--accent-alt', () => (accent ? toHex(rotateHue(accent, 150)) : null))
  resolve('--accent-muted', () => (accent && base ? toHex(mix(accent, base, 0.85)) : null))
  resolve('--accent-text', () => {
    if (!accent) return null
    if (!base) return toHex(accent)
    // Checked by theme-validate against --accent-muted, and used as body-ish
    // text over --bg-base, so it must clear 4.5:1 on BOTH.
    return ensureContrast(accent, [base, rgbOf('--accent-muted')], 4.5)
  })

  // 3. Text tiers.
  resolve('--text-primary', () => (base ? toHex(dark ? WHITE : BLACK) : null))
  const text = rgbOf('--text-primary')
  resolve('--text-muted', () =>
    text && base ? ensureContrast(mix(text, base, 0.45), [base, rgbOf('--bg-surface')], 4.5) : null,
  )
  resolve('--text-dim', () => (text && base ? toHex(mix(text, base, 0.75)) : null))

  // 4. Borders.
  resolve('--border', () => (text && base ? toHex(mix(text, base, 0.87)) : null))
  resolve('--border-strong', () => (text && base ? toHex(mix(text, base, 0.8)) : null))

  // 5. Semantics. --destructive is pinned to var(--danger) — never sourced.
  const semantic = (name: '--success' | '--warning' | '--danger' | '--info') =>
    resolve(name, () => {
      const fallback = SEMANTIC_DEFAULTS[dark ? 'dark' : 'light'][name]
      const surface = rgbOf('--bg-surface') ?? base
      const rgb = parseColor(fallback)
      if (!surface || !rgb) return fallback
      if (contrastRatio(rgb, surface) >= 4.5) return fallback
      return suggestContrastFix(rgb, surface, 4.5) ?? fallback
    })
  // Emission order keeps --destructive first (contract order), but --danger must
  // resolve first, so compute the four real colours before the alias.
  semantic('--success')
  semantic('--warning')
  semantic('--danger')
  semantic('--info')
  if (out['--danger']) {
    out['--destructive'] = 'var(--danger)'
    synthesized.push('--destructive')
  } else {
    missing.push('--destructive')
  }

  // 6. Shadows + geometry, built off the darkest resolved background.
  const backgrounds = (['--bg-inset', '--bg-base', '--bg-surface', '--bg-elevated', '--bg-sidebar'] as const)
    .map((n) => rgbOf(n))
    .filter((c): c is Rgb => c !== null)
  const ink = backgrounds.length
    ? backgrounds.reduce((a, b) => (relativeLuminance(a) <= relativeLuminance(b) ? a : b))
    : null
  resolve('--shadow-hard', () => (ink ? `2px 2px 0 ${toHex(ink)}` : null))
  resolve('--shadow-hard-lg', () => (ink ? `6px 6px 0 ${toHex(ink)}` : null))
  resolve('--shadow-soft', () => (ink ? `2px 2px 0 rgba(${ink.r},${ink.g},${ink.b},0.3)` : null))
  resolve('--border-width', () => '2px')

  // 7. Structure layer — the geometry the palette pass throws away, rescoped
  //    under the same theme id and guarded separately (see below).
  const structure =
    options.includeStructure === false
      ? emptyStructureResult()
      : extractStructureCss([source, options.structureSource ?? ''], { themeId, label })

  return {
    slug,
    themeId,
    label,
    css: renderThemeBlock(themeId, label, out, { mapped, synthesized, missing, rejected }),
    ...(structure.ok && structure.css ? { structureCss: structure.css } : {}),
    structure,
    vars: out,
    report: { mapped, synthesized, missing, rejected },
  }
}

/** Render the single scoped block, header comment included. */
export function renderThemeBlock(
  themeId: string,
  label: string,
  vars: Partial<Record<ThemeVarName, string>>,
  report: ThemeExtractReport,
): string {
  const width = THEME_VAR_NAMES.reduce((w, n) => Math.max(w, n.length), 0) + 2
  const lines = THEME_VAR_NAMES.filter((n) => vars[n] !== undefined).map(
    (n) => `  ${(n + ':').padEnd(width)}${vars[n]};`,
  )
  const header = [
    `/* Custom theme "${label.replace(/\*\//g, '')}" — ${themeId}`,
    `   Extracted from an imported design document by the Tachi theme extractor.`,
    `   ${report.mapped.length} mapped · ${report.synthesized.length} synthesized · ${report.missing.length} missing.`,
    `   Generated file: re-import the document instead of hand-editing. */`,
  ].join('\n')
  return `${header}\n:root[data-theme="${themeId}"] {\n${lines.join('\n')}\n}\n`
}

// ── Structure layer ─────────────────────────────────────────────────────────
//
// A real Claude Design handoff ships TWO sheets: the palette above, and a
// companion STRUCTURE sheet (themes/<id>-structure.css) carrying the chassis —
// clip-paths, gradients, textures, @keyframes, a prefers-reduced-motion block.
// Imported themes used to drop all of it, which is why an import could only
// ever be a recolour. This pass keeps it, on three conditions:
//
//   RESCOPE  every selector is rewritten to `:root[data-theme="custom:<slug>"]`
//            whatever it was authored against — a bare `button`, a
//            `:root[data-theme="tachi-opus5"]`, a rule nested in @media.
//   RENAME   @keyframes get a per-theme prefix. Every custom theme shares ONE
//            <style> element and keyframe names are GLOBAL, so two imports each
//            defining `pulse` would silently fight over it. References to names
//            this sheet does NOT define (globals.css' `tachi-pulse`) are left
//            alone on purpose.
//   REFUSE   fail-closed on anything that can escape the sheet — a `</style`
//            sequence or an oversized payload kills the whole layer; @import,
//            external url(), `expression()`/`javascript:` and any unscopable
//            at-rule are stripped with a reason. The standing `cursor` ban
//            (globals.css owns the resize affordance —
//            apps/desktop/test/unit/resizeCursor.test.ts) applies here too.
//
// The 24 contract variables are stripped as well: they belong to the palette
// block, and a structure sheet redefining them is a palette edit in disguise.
// Every OTHER custom property survives — `--opus-bite-offset` and friends are
// what the geometry is built out of.

/** Hard cap on a structure sheet; a real one is ~18 KB. */
export const MAX_STRUCTURE_CSS_CHARS = 200_000

export interface StructureExtractResult {
  /** False = fail-closed refusal; nothing may be injected. */
  ok: boolean
  /** The rescoped sheet, or '' when refused / when there was no structure. */
  css: string
  /** Hard failures — the whole layer is refused. Rendered in the import UI. */
  errors: string[]
  /** Rules/declarations stripped from an otherwise-usable sheet, with reasons. */
  dropped: string[]
  /** How many rules survived (the "this theme has a chassis" signal). */
  rules: number
  /** Keyframe names defined by the sheet, already prefixed. */
  keyframes: string[]
}

function emptyStructureResult(): StructureExtractResult {
  return { ok: true, css: '', errors: [], dropped: [], rules: 0, keyframes: [] }
}

/** `</style`, in any spacing HTML would still accept as a close tag. */
const STYLE_BREAKOUT = /<\/\s*style/i

/** At-rules whose BODY is a list of rules we can rescope one by one. */
const NESTING_AT_RULE = /^@(media|supports|container)\b/i
const KEYFRAMES_AT_RULE = /^@(-[a-z]+-)?keyframes\s+(.+)$/i
const ANIMATION_PROP = /^(-[a-z]+-)?animation(-name)?$/i

/** Any `[data-theme=…]` filter, whatever quoting/operator it was written with. */
const DATA_THEME_ATTR = /\[\s*data-theme\s*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]\s]*)\s*\]/gi

/**
 * Split a comma list without cutting inside `:not(a, b)` or an attribute value.
 * The shipped structure sheets rely on this: their ghost-button exclusions are
 * `:not([style*="background: transparent"], [style*="background: none"])`.
 */
export function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quote) {
      if (c === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === separator && depth === 0) {
      out.push(input.slice(start, i))
      start = i + 1
    }
  }
  out.push(input.slice(start))
  return out
}

export interface CssRule {
  /** Selector list, or an at-rule prelude (`@media (min-width: 40em)`). */
  selector: string
  /** Block contents, verbatim (comments already stripped). */
  body: string
  /** False for a statement at-rule (`@import …;`), which has no block. */
  block: boolean
}

/**
 * Top-level rules of a stylesheet, in source order — the rebuilding
 * counterpart of forEachRule (which recurses and reports, but cannot round-trip
 * a sheet). Statement at-rules are reported with `block: false` so a caller can
 * refuse them instead of silently swallowing an @import.
 */
export function parseTopLevelRules(css: string): CssRule[] {
  const src = stripComments(css)
  const out: CssRule[] = []
  let i = 0
  let start = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      const selector = src.slice(start, i).trim()
      let depth = 1
      let j = i + 1
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        j++
      }
      out.push({ selector, body: src.slice(i + 1, depth === 0 ? j - 1 : src.length), block: true })
      i = j
      start = i
    } else if (ch === ';') {
      const statement = src.slice(start, i).trim()
      if (statement.startsWith('@')) out.push({ selector: statement, body: '', block: false })
      i++
      start = i
    } else if (ch === '}') {
      i++
      start = i
    } else {
      i++
    }
  }
  return out
}

/** Declarations of a rule body, quote- and paren-safe (a data: URI has `;`). */
function parseStructureDeclarations(body: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = []
  const flat = body.replace(/\{[^{}]*\}/g, '')
  for (const chunk of splitTopLevel(flat, ';')) {
    const idx = chunk.indexOf(':')
    if (idx === -1) continue
    const prop = chunk.slice(0, idx).trim()
    const value = chunk.slice(idx + 1).trim()
    if (!prop || !value || /[{}]/.test(prop)) continue
    out.push({ prop, value })
  }
  return out
}

/** `data:` is the only scheme a theme may reach for; relative paths pass. */
function isExternalUrl(target: string): boolean {
  const t = target.trim()
  if (t.startsWith('//')) return true // protocol-relative
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)
  return scheme ? !/^data$/i.test(scheme[1]!) : false
}

function externalUrlIn(value: string): string | null {
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const target = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (isExternalUrl(target)) return target.slice(0, 60)
  }
  return null
}

/**
 * Rewrite ONE selector so it can only ever match while `scope` is the active
 * theme. Three shapes, in order: an existing `[data-theme=…]` filter is
 * retargeted (that is what a handoff sheet authored against its own built-in id
 * looks like); a leading `:root`/`html` grows the attribute; anything else is
 * prefixed as a descendant.
 */
export function rescopeSelector(selector: string, themeId: string): string {
  const attr = `[data-theme="${themeId}"]`
  const parts: string[] = []
  for (const raw of splitTopLevel(selector, ',')) {
    const part = raw.trim()
    if (!part) continue
    const retargeted = part.replace(DATA_THEME_ATTR, attr)
    if (retargeted !== part) {
      parts.push(retargeted)
      continue
    }
    if (/^:root\b/.test(part)) parts.push(part.replace(/^:root/, `:root${attr}`))
    else if (/^html\b/.test(part)) parts.push(part.replace(/^html/, `:root${attr}`))
    else parts.push(`:root${attr} ${part}`)
  }
  return parts.join(',\n')
}

/**
 * Custom properties the PALETTE pass already owns: the 24 contract names plus
 * every alias it maps from. Re-emitting them in the structure layer would be a
 * second, unvalidated copy of the palette — the geometry gets the resolved
 * contract variables instead. Anything else (`--opus-bite-offset`, the private
 * tokens a chassis is built out of) survives untouched.
 */
const PALETTE_OWNED_VARS = new Set<string>([
  ...THEME_VAR_NAMES,
  ...Object.values(ALIASES).flatMap((a) => [...a]),
])

interface StructureContext {
  themeId: string
  /** Original keyframe name -> prefixed name. */
  renames: Map<string, string>
  dropped: string[]
  /** Contract variables seen (reported once, not once per declaration). */
  paletteVars: number
  rules: number
  /** Prefixed names of the keyframe blocks that actually survived. */
  keyframes: string[]
}

/**
 * Filter a declaration list down to what a theme is allowed to say, rewriting
 * animation references to the prefixed keyframe names on the way through.
 */
function renderDeclarations(body: string, ctx: StructureContext, indent: string): string[] {
  const lines: string[] = []
  for (const { prop, value } of parseStructureDeclarations(body)) {
    if (PALETTE_OWNED_VARS.has(prop)) {
      ctx.paletteVars++
      continue
    }
    if (/^(-[a-z]+-)?cursor$/i.test(prop)) {
      ctx.dropped.push(`"${prop}" removed — themes must not set a cursor (globals.css owns it)`)
      continue
    }
    if (/[{}]/.test(value) || STYLE_BREAKOUT.test(value)) {
      ctx.dropped.push(`"${prop}" removed — the value could break out of the sheet`)
      continue
    }
    if (/expression\s*\(|javascript\s*:/i.test(value)) {
      ctx.dropped.push(`"${prop}" removed — legacy script vector`)
      continue
    }
    const external = externalUrlIn(value)
    if (external) {
      ctx.dropped.push(`"${prop}" removed — remote url(${external}) is not allowed in a theme`)
      continue
    }
    const out = ANIMATION_PROP.test(prop) ? rewriteAnimationNames(value, ctx.renames) : value
    lines.push(`${indent}${prop}: ${out};`)
  }
  return lines
}

/** Swap only the keyframe names THIS sheet defines; globals keep theirs. */
function rewriteAnimationNames(value: string, renames: Map<string, string>): string {
  if (renames.size === 0) return value
  return value.replace(/[A-Za-z_-][\w-]*/g, (word) => renames.get(word) ?? word)
}

/** Render a rule list (top level, or the inside of an @media), recursively. */
function renderRules(rules: CssRule[], ctx: StructureContext, indent: string): string[] {
  const blocks: string[] = []
  for (const rule of rules) {
    if (!rule.block) {
      ctx.dropped.push(`"${rule.selector.slice(0, 60)}" removed — a theme may not pull in another stylesheet`)
      continue
    }
    if (rule.selector.startsWith('@')) {
      if (NESTING_AT_RULE.test(rule.selector)) {
        const inner = renderRules(parseTopLevelRules(rule.body), ctx, `${indent}  `)
        if (inner.length > 0) blocks.push(`${indent}${rule.selector} {\n${inner.join('\n')}\n${indent}}`)
        continue
      }
      const keyframes = KEYFRAMES_AT_RULE.exec(rule.selector)
      if (keyframes) {
        // Steps (`0%`, `from`) are NOT selectors — they must not be scoped.
        const steps: string[] = []
        for (const step of parseTopLevelRules(rule.body)) {
          if (!step.block || step.selector.startsWith('@')) continue
          const decls = renderDeclarations(step.body, ctx, `${indent}    `)
          if (decls.length > 0) steps.push(`${indent}  ${step.selector} {\n${decls.join('\n')}\n${indent}  }`)
        }
        const name = keyframes[2]!.trim()
        const renamed = ctx.renames.get(name)
        if (steps.length > 0 && renamed) {
          blocks.push(`${indent}@keyframes ${renamed} {\n${steps.join('\n')}\n${indent}}`)
          ctx.keyframes.push(renamed)
          ctx.rules++
        }
        continue
      }
      // @font-face / @property / @layer / @page: global by construction, so
      // they would leak out of the theme no matter how they were rewritten.
      ctx.dropped.push(`"${rule.selector.slice(0, 60)}" removed — it cannot be scoped to one theme`)
      continue
    }
    const decls = renderDeclarations(rule.body, ctx, `${indent}  `)
    if (decls.length === 0) continue
    const selector = rescopeSelector(rule.selector, ctx.themeId)
    if (!selector) continue
    blocks.push(`${indent}${selector} {\n${decls.join('\n')}\n${indent}}`)
    ctx.rules++
  }
  return blocks
}

export interface ExtractStructureOptions {
  /** `custom:<slug>` — the scope every rule is rewritten to. */
  themeId: string
  /** Human label, for the header comment only. */
  label?: string
}

/**
 * Turn whatever structural CSS an import carries into ONE sheet that can only
 * paint while `themeId` is active. Never throws: refusals come back as
 * `errors` (fail-closed, nothing injected) and `dropped` (this rule went, the
 * rest stands), both already human-readable for the import UI.
 *
 * `sources` may mix full HTML mockups and bare stylesheets — each is run
 * through collectStyleSheets first, so a `<style>` block and a companion
 * `-structure.css` merge into the same layer, in the order given.
 */
export function extractStructureCss(
  sources: string | ReadonlyArray<string>,
  options: ExtractStructureOptions,
): StructureExtractResult {
  const { themeId } = options
  const sheets = (Array.isArray(sources) ? sources : [sources as string])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .flatMap((s) => collectStyleSheets(s))
  const input = sheets.join('\n')
  if (input.trim() === '') return emptyStructureResult()

  // Fail-closed gates, before anything is parsed.
  if (input.length > MAX_STRUCTURE_CSS_CHARS) {
    return {
      ...emptyStructureResult(),
      ok: false,
      errors: [`structure sheet is ${input.length} characters, over the ${MAX_STRUCTURE_CSS_CHARS} limit`],
    }
  }
  if (STYLE_BREAKOUT.test(input)) {
    return {
      ...emptyStructureResult(),
      ok: false,
      errors: ['structure sheet contains a "</style" sequence — it could break out of the injected element'],
    }
  }

  // Pass 1: every keyframe name the sheet DEFINES, prefixed per theme.
  const prefix = themeId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'custom'
  const renames = new Map<string, string>()
  const collectKeyframes = (rules: CssRule[]): void => {
    for (const rule of rules) {
      if (!rule.block || !rule.selector.startsWith('@')) continue
      if (NESTING_AT_RULE.test(rule.selector)) {
        collectKeyframes(parseTopLevelRules(rule.body))
        continue
      }
      const m = KEYFRAMES_AT_RULE.exec(rule.selector)
      if (!m) continue
      const name = m[2]!.trim()
      if (name && !renames.has(name)) renames.set(name, `${prefix}-${name}`)
    }
  }
  const top = parseTopLevelRules(input)
  collectKeyframes(top)

  // Pass 2: rescope, rename, filter.
  const ctx: StructureContext = { themeId, renames, dropped: [], paletteVars: 0, rules: 0, keyframes: [] }
  const blocks = renderRules(top, ctx, '')
  if (ctx.paletteVars > 0) {
    ctx.dropped.push(`${ctx.paletteVars} palette variable declaration(s) removed — they belong to the palette block`)
  }
  if (blocks.length === 0) {
    return { ok: true, css: '', errors: [], dropped: ctx.dropped, rules: 0, keyframes: [] }
  }

  const label = (options.label ?? themeId).replace(/\*\//g, '')
  const kept = ctx.keyframes
  const header = [
    `/* Structure layer for "${label}" — ${themeId}`,
    `   Rescoped from an imported design document by the Tachi theme extractor.`,
    `   ${ctx.rules} rule(s) · ${kept.length} keyframe animation(s) · ${ctx.dropped.length} removed.`,
    `   Generated file: re-import the document instead of hand-editing. */`,
  ].join('\n')
  const css = `${header}\n${blocks.join('\n')}\n`

  // The output is what actually gets injected, so it is gated again.
  if (css.length > MAX_STRUCTURE_CSS_CHARS || STYLE_BREAKOUT.test(css)) {
    return {
      ...emptyStructureResult(),
      ok: false,
      errors: ['the rescoped structure sheet failed the final safety check'],
    }
  }
  return { ok: true, css, errors: [], dropped: ctx.dropped, rules: ctx.rules, keyframes: kept }
}
