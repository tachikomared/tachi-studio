// packages/core/src/design/theme-validate.ts
//
// "Claude Design mockup -> living app theme", step 2: judge a generated theme
// sheet BEFORE it is injected into the running app.
//
// Deliberately independent of theme-extract.ts: the extractor is supposed to
// produce something that passes, so the validator re-derives every rule from
// the CSS TEXT rather than from the extractor's internal state. If the two ever
// disagree, the theme is not applied — which is the point of having two.
//
// Rules
//   contrast        (error)   WCAG 2.x 4.5:1 for the text pairs, with a
//                             nearest-hue fix suggestion.
//   contrast-large  (warning) 3:1 for large/non-text pairs (accent fills,
//                             borders). A WARNING on purpose: the shipped
//                             tachi-dark's #2a2a2a hairline on #0f0f0f is 1.3:1
//                             and is a deliberate design choice, so making this
//                             an error would reject our own house style.
//   completeness    (error)   all 24 contract variables present.
//   cursor          (error)   a theme may never set `cursor` — the resize
//                             affordance belongs to globals.css
//                             (apps/desktop/test/unit/resizeCursor.test.ts).
//   ghost-shadow    (error)   `filter: drop-shadow()` on a <button> rule that
//                             does not exclude transparent-background (ghost)
//                             buttons traces the GLYPHS instead of the box —
//                             the "doubled text" defect the structure themes
//                             shipped (structureSheets.test.ts).
//   scope           (error)   every rule must live under
//                             `:root[data-theme="custom:<id>"]`, and no at-rule
//                             (@import/@media) may appear at all.
//
// Also usable as a design-lint over ANY generated stylesheet — nothing here
// touches the DOM or the filesystem.

import { forEachRule, parseDeclarations, resolveValue, THEME_VAR_NAMES, type ThemeVarName } from './theme-extract.js'
import { contrastRatio, parseColor, suggestContrastFix } from './theme-color.js'

export type ThemeIssueLevel = 'error' | 'warning'

export type ThemeIssueRule =
  | 'completeness'
  | 'contrast'
  | 'contrast-large'
  | 'cursor'
  | 'ghost-shadow'
  | 'scope'

export interface ThemeIssue {
  level: ThemeIssueLevel
  rule: ThemeIssueRule
  /** Human-readable, already carries the numbers — safe to render verbatim. */
  message: string
  /** Variables the issue is about (contrast pairs are [foreground, background]). */
  vars?: string[]
  /** Selector the issue was found on, for the CSS-shape rules. */
  selector?: string
  ratio?: number
  required?: number
  /** Nearest-hue replacement for the FOREGROUND that would pass. */
  suggestion?: string
}

export interface ContrastCheck {
  fg: ThemeVarName
  bg: ThemeVarName
  ratio: number
  required: number
  passes: boolean
}

export interface ThemeValidation {
  /** No errors. Warnings never block. */
  ok: boolean
  errors: ThemeIssue[]
  warnings: ThemeIssue[]
  /** Every issue in discovery order (errors and warnings interleaved). */
  issues: ThemeIssue[]
  /** Contract variables found in the sheet, `var()` chains resolved. */
  vars: Partial<Record<ThemeVarName, string>>
  /** Every contrast pair that could be measured. */
  contrast: ContrastCheck[]
}

/** 4.5:1 — body text on its background. Failure is an ERROR. */
export const TEXT_CONTRAST_PAIRS: ReadonlyArray<readonly [ThemeVarName, ThemeVarName]> = [
  ['--text-primary', '--bg-base'],
  ['--text-primary', '--bg-surface'],
  ['--text-primary', '--bg-elevated'],
  ['--text-primary', '--bg-sidebar'],
  ['--text-muted', '--bg-base'],
  ['--text-muted', '--bg-surface'],
  ['--accent-text', '--accent-muted'],
  ['--danger', '--bg-surface'],
  ['--success', '--bg-surface'],
  ['--warning', '--bg-surface'],
  ['--info', '--bg-surface'],
]

/**
 * 3:1 — large text, accent fills and borders. Failure is a WARNING.
 * `--text-dim` is intentionally absent: it is the disabled/decorative tier and
 * is below 3:1 by design in every shipped theme.
 */
export const LARGE_CONTRAST_PAIRS: ReadonlyArray<readonly [ThemeVarName, ThemeVarName]> = [
  ['--accent', '--bg-base'],
  ['--accent', '--bg-surface'],
  ['--border', '--bg-base'],
  ['--border', '--bg-surface'],
  ['--border-strong', '--bg-surface'],
]

const TEXT_TARGET = 4.5
const LARGE_TARGET = 3

const CONTRACT = new Set<string>(THEME_VAR_NAMES)

export interface ValidateThemeOptions {
  /**
   * The theme id every rule must be scoped to (`custom:<slug>`). When omitted
   * it is inferred from the first `[data-theme="custom:…"]` selector found; if
   * there is none, the scope rule fails.
   */
  themeId?: string
}

/**
 * Validate a generated theme stylesheet. Never throws: malformed input simply
 * produces errors.
 */
export function validateThemeCss(css: string, options: ValidateThemeOptions = {}): ThemeValidation {
  const issues: ThemeIssue[] = []
  const declared: Record<string, string> = {}

  const inferred = /\[data-theme=["']?(custom:[A-Za-z0-9._-]+)["']?\]/.exec(css)
  const themeId = options.themeId ?? inferred?.[1]
  const scopeToken = themeId ? `[data-theme="${themeId}"]` : null

  let sawRule = false

  forEachRule(css, (selector, body) => {
    sawRule = true

    // ── scope ───────────────────────────────────────────────────────────────
    if (selector.startsWith('@')) {
      issues.push({
        level: 'error',
        rule: 'scope',
        selector,
        message: `at-rules are not allowed in a custom theme (found "${selector.slice(0, 60)}")`,
      })
      return
    }
    const scoped = scopeToken
      ? selector.split(',').every((s) => s.includes(scopeToken))
      : false
    if (!scoped) {
      issues.push({
        level: 'error',
        rule: 'scope',
        selector,
        message: scopeToken
          ? `rule "${selector.slice(0, 60)}" is not scoped under ${scopeToken} — it would leak into every theme`
          : `rule "${selector.slice(0, 60)}" is not scoped under a :root[data-theme="custom:…"] selector`,
      })
    }

    const decls = parseDeclarations(body)

    // ── cursor ──────────────────────────────────────────────────────────────
    for (const { prop, value } of decls) {
      if (/^cursor$/i.test(prop) || /cursor\s*:/i.test(value)) {
        issues.push({
          level: 'error',
          rule: 'cursor',
          selector,
          message: `"${selector.slice(0, 40)}" sets a cursor — themes must not; the resize affordance is owned by globals.css`,
        })
      }
    }

    // ── ghost-shadow ────────────────────────────────────────────────────────
    if (/\bbutton\b/.test(selector) && body.includes('drop-shadow(')) {
      const excludesGhosts =
        selector.includes('[style*="background: transparent"]') &&
        selector.includes('[style*="background: none"]')
      if (!excludesGhosts) {
        issues.push({
          level: 'error',
          rule: 'ghost-shadow',
          selector,
          message:
            `"${selector.slice(0, 60)}" drop-shadows buttons without excluding transparent-background (ghost) ` +
            'buttons — the shadow traces the TEXT instead of the box',
        })
      }
    }

    // ── collect contract variables (last declaration wins) ──────────────────
    for (const { prop, value } of decls) {
      if (CONTRACT.has(prop)) declared[prop] = value
    }
  })

  if (!sawRule) {
    issues.push({
      level: 'error',
      rule: 'scope',
      message: 'no CSS rule found — the theme sheet is empty',
    })
  }

  // ── completeness ──────────────────────────────────────────────────────────
  const vars: Partial<Record<ThemeVarName, string>> = {}
  for (const name of THEME_VAR_NAMES) {
    if (declared[name] !== undefined) vars[name] = declared[name]
  }
  const missing = THEME_VAR_NAMES.filter((n) => vars[n] === undefined)
  if (missing.length > 0) {
    issues.push({
      level: 'error',
      rule: 'completeness',
      vars: [...missing],
      message: `${missing.length} of ${THEME_VAR_NAMES.length} theme variables are missing: ${missing.join(', ')}`,
    })
  }

  // ── contrast ──────────────────────────────────────────────────────────────
  const contrast: ContrastCheck[] = []
  const colorOf = (name: ThemeVarName) => {
    const raw = vars[name]
    if (raw === undefined) return null
    return parseColor(resolveValue(raw, declared))
  }

  const checkPairs = (
    pairs: ReadonlyArray<readonly [ThemeVarName, ThemeVarName]>,
    required: number,
    level: ThemeIssueLevel,
    rule: ThemeIssueRule,
  ) => {
    for (const [fgName, bgName] of pairs) {
      const fg = colorOf(fgName)
      const bg = colorOf(bgName)
      if (!fg || !bg) continue
      const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100
      const passes = ratio >= required
      contrast.push({ fg: fgName, bg: bgName, ratio, required, passes })
      if (passes) continue
      const suggestion = suggestContrastFix(fg, bg, required) ?? undefined
      issues.push({
        level,
        rule,
        vars: [fgName, bgName],
        ratio,
        required,
        suggestion,
        message:
          `${fgName} on ${bgName} is ${ratio}:1, below the ${required}:1 minimum` +
          (suggestion ? ` — nearest fix keeping the hue: ${suggestion}` : ' — no same-hue lightness fixes it'),
      })
    }
  }

  checkPairs(TEXT_CONTRAST_PAIRS, TEXT_TARGET, 'error', 'contrast')
  checkPairs(LARGE_CONTRAST_PAIRS, LARGE_TARGET, 'warning', 'contrast-large')

  const errors = issues.filter((i) => i.level === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')
  return { ok: errors.length === 0, errors, warnings, issues, vars, contrast }
}
