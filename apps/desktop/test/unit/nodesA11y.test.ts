// apps/desktop/test/unit/nodesA11y.test.ts
//
// BATCH34 · a11y wave 1 for the NODES surface — a SOURCE SWEEP, not a snapshot.
//
// The nodes canvas is the one surface in this app that cannot be driven in the
// node-only test env (ReactFlow needs a real DOM + layout), so the a11y contract
// is pinned by reading src/pages/nodes/**/*.tsx the same way tachiappSurface /
// codexCardWiring pin their one-line wirings. The point is REGRESSION: someone
// adding a new glyph button, or a new `onClick` on a <div>, fails here instead
// of shipping a control no keyboard can reach.
//
// Four contracts:
//   1. NAMES   — every <button> has an accessible name (aria-label, a t() child,
//                a bound label, or literal text). A bare "×" fails.
//   2. REACH   — every onClick on a NON-interactive element is either keyboard
//                reachable (role=button + tabIndex + onKeyDown) or explicitly
//                decorative (aria-hidden / role=presentation / a
//                stopPropagation-only guard).
//   3. FOCUS   — the two canvas context menus, the quick-add menu and the
//                blueprint dialog all go through useDialog (trap + Escape +
//                focus restore), and useDialog still DOES those three things.
//                Escape closes everything that click-outside closes.
//   4. LIVE    — result cards announce TERMINAL states only. The per-step
//                "running 3/7" line must never become a live region (a 20-node
//                flow would fire 20 interruptions).
// Plus: every aria-label key used here exists, non-empty, in all 8 locales with
// matching interpolation placeholders.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP     = path.resolve(__dirname, '../..')
const NODES   = path.join(APP, 'src/pages/nodes')
const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

/** Every .tsx under src/pages/nodes, repo-relative, sorted. */
function nodesTsx(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx')) out.push(path.relative(APP, p).split(path.sep).join('/'))
    }
  }
  walk(NODES)
  return out.sort()
}

/**
 * Drop comments before scanning. Without this a `<button>` written inside an
 * explanatory `//` comment is parsed as markup (it happened while writing this
 * file). Only whole-line `//` comments are removed so string literals that
 * contain `//` — e.g. the `tachi-media://` URL builder — survive intact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

// ── JSX element scanning ─────────────────────────────────────────────────────
//
// Not a parser — a brace-depth walk that finds the end of an opening tag (a `>`
// at brace depth 0, so `style={{ a: '>' }}` cannot terminate it early) and then
// the matching close tag. Enough for these files, which are plain JSX.

interface ElementHit { file: string; line: number; tag: string; open: string; inner: string }

function endOfOpenTag(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return src.length - 1
}

/** All `<button …>…</button>` occurrences in one file. */
function scanButtons(file: string): ElementHit[] {
  const src = stripComments(read(file))
  const hits: ElementHit[] = []
  let pos = 0
  for (;;) {
    const start = src.indexOf('<button', pos)
    if (start === -1) break
    const openEnd = endOfOpenTag(src, start)
    const open = src.slice(start, openEnd + 1)
    let inner = ''
    let next = openEnd + 1
    if (!open.trimEnd().endsWith('/>')) {
      // Walk to the matching </button>, counting nested <button (never happens
      // today, but a nested one would otherwise steal the close tag).
      let k = openEnd + 1
      let level = 1
      for (;;) {
        const nb = src.indexOf('<button', k)
        const ce = src.indexOf('</button>', k)
        if (ce === -1) { inner = src.slice(openEnd + 1); next = src.length; break }
        if (nb !== -1 && nb < ce) { level++; k = nb + 7; continue }
        level--
        if (level === 0) { inner = src.slice(openEnd + 1, ce); next = ce + 9; break }
        k = ce + 9
      }
    }
    hits.push({ file, line: src.slice(0, start).split('\n').length, tag: 'button', open, inner })
    pos = next
  }
  return hits
}

/** Non-interactive tags that must never carry a bare onClick. */
const NON_INTERACTIVE = [
  'div', 'span', 'li', 'td', 'tr', 'section', 'p', 'label', 'img', 'ul', 'ol',
  'header', 'footer', 'article', 'aside', 'pre', 'code', 'h1', 'h2', 'h3',
]

/** Opening tags of non-interactive elements that carry an onClick. */
function scanClickableNonInteractive(file: string): ElementHit[] {
  const src = stripComments(read(file))
  const hits: ElementHit[] = []
  const re = new RegExp(`<(${NON_INTERACTIVE.join('|')})(?=[\\s>/])`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const openEnd = endOfOpenTag(src, m.index)
    const open = src.slice(m.index, openEnd + 1)
    if (!open.includes('onClick')) continue
    hits.push({ file, line: src.slice(0, m.index).split('\n').length, tag: m[1], open, inner: '' })
  }
  return hits
}

// ── Accessible-name rules ────────────────────────────────────────────────────

const hasAriaLabel = (open: string) => /aria-label(?:ledby)?\s*=/.test(open)

/**
 * Does the button's CONTENT carry a name?
 *   · a t(…) call            → a translated visible label
 *   · `{label}` / `{f.name}` → a bound label
 *   · literal letters/digits → plain text ("MAIN", "Ctrl+D")
 * A lone glyph ("×", "⇩", "▸") is none of those and needs an aria-label.
 */
function contentHasName(inner: string): boolean {
  if (/\bt\(/.test(inner)) return true
  if (/\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/.test(inner)) return true
  const literal = inner.replace(/<[^>]*>/g, ' ').replace(/\{[^{}]*\}/g, ' ')
  return /[\p{L}\p{N}]/u.test(literal)
}

// Deliberate exceptions, "file:line — why". EMPTY on purpose: nothing in this
// surface is allowed to ship an unnamed control today. Add an entry only with a
// reason, never to silence the sweep.
const KNOWN_UNNAMED_BUTTONS: readonly string[] = []

// ── 1. NAMES ─────────────────────────────────────────────────────────────────

describe('nodes a11y · every button has an accessible name', () => {
  const files = nodesTsx()

  it('finds the surface (guards against a silently-empty sweep)', () => {
    expect(files.length).toBeGreaterThan(25)
    expect(files).toContain('src/pages/nodes/NodesPage.tsx')
    expect(files).toContain('src/pages/nodes/canvas/FlowCanvas.tsx')
    expect(files).toContain('src/pages/nodes/sidebar/FlowsRail.tsx')
    // …and actually parses buttons out of them.
    expect(files.flatMap(scanButtons).length).toBeGreaterThan(60)
  })

  it('no icon-only button ships without aria-label', () => {
    const unnamed = files
      .flatMap(scanButtons)
      .filter(h => !hasAriaLabel(h.open) && !contentHasName(h.inner))
      .map(h => `${h.file}:${h.line}`)
      .filter(id => !KNOWN_UNNAMED_BUTTONS.includes(id))
    expect(unnamed).toEqual([])
  })

  it('the classifier actually classifies (self-test)', () => {
    expect(contentHasName('×')).toBe(false)
    expect(contentHasName('⇩')).toBe(false)
    expect(contentHasName('<span aria-hidden="true">▾</span>')).toBe(false)
    expect(contentHasName("{t('flowsRail.rename')}")).toBe(true)
    expect(contentHasName('{f.name}')).toBe(true)
    expect(contentHasName('{label}')).toBe(true)
    expect(contentHasName('MAIN')).toBe(true)
    expect(hasAriaLabel('<button aria-label={x}>')).toBe(true)
    expect(hasAriaLabel('<button title={x}>')).toBe(false)
  })

  it('the row actions in the flows rail are named per FLOW, not five times the same', () => {
    const s = read('src/pages/nodes/sidebar/FlowsRail.tsx')
    expect(s).toContain("t('flowsRail.rowActionAria'")
    for (const key of ['exportAria', 'scheduleAria', 'revisions.openAria', 'renameAria', 'deleteAria', 'confirmDeleteAria', 'openAria']) {
      expect(s).toContain(`rowAria(t('flowsRail.${key}'`)
    }
    // …and the revisions drawer does the same for its repeated "restore".
    expect(read('src/pages/nodes/sidebar/RevisionsDrawer.tsx')).toContain("t('flowsRail.rowActionAria'")
  })

  it('the repair banner names WHICH node each identical Fix button repairs', () => {
    const s = read('src/pages/nodes/RepairBanner.tsx')
    expect(s).toContain("aria-label={t('repair.fixAria'")
    expect(s).toContain('label: issue.label')
  })

  it('the canvas is a named landmark and its toolbar is translated', () => {
    const s = read('src/pages/nodes/canvas/FlowCanvas.tsx')
    expect(s).toContain('role="region"')
    expect(s).toContain("aria-label={t('canvas.aria'")
    // Undo/Redo used to ship hardcoded English aria-labels.
    expect(s).toContain("aria-label={t('canvas.undo'")
    expect(s).toContain("aria-label={t('canvas.redo'")
    expect(s).not.toContain('aria-label="Undo"')
    expect(s).not.toContain('aria-label="Redo"')
    expect(s).toContain("aria-label={t('search.aria'")
  })

  it('the side panels are named landmarks', () => {
    expect(read('src/pages/nodes/sidebar/NodePalette.tsx')).toContain("aria-label={t('palette.aria'")
    expect(read('src/pages/nodes/sidebar/FlowsRail.tsx')).toContain("aria-label={t('flowsRail.aria'")
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).toContain("aria-label={t('runPanel.aria'")
    expect(page).toContain("aria-label={t('chatPanel.aria'")
    expect((page.match(/role="complementary"/g) ?? []).length).toBe(2)
  })

  it('every text entry field carries a name (placeholders are not names)', () => {
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).toContain("aria-label={t('runPanel.initialMessage')}")
    expect(page).toContain("aria-label={t('runPanel.budgetLabel'")
    expect(page).toContain("aria-label={t('chatPanel.inputPlaceholder')}")
    expect(read('src/pages/nodes/sidebar/FlowsRail.tsx'))
      .toContain("aria-label={rowAria(t('flowsRail.renameAria'")
  })
})

// ── 2. REACH ─────────────────────────────────────────────────────────────────

describe('nodes a11y · onClick on a non-interactive element is reachable or decorative', () => {
  /** A handler that ONLY stops propagation is a guard, not an action. */
  const isPropagationGuard = (open: string) =>
    /onClick=\{\s*\(?\s*\w*\s*\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\)\s*;?\s*\}?\s*\}/.test(open)

  const isDecorative = (open: string) =>
    /aria-hidden\s*=\s*["{]?\s*true/.test(open) ||
    /role="presentation"/.test(open) ||
    /role="dialog"/.test(open) ||
    // Explicit, greppable opt-out: the click duplicates a control that IS
    // keyboard-reachable (today: the result-card header bar, whose collapse
    // control is the title span inside it). Anything wearing this marker is
    // audited by the assertion further down.
    /data-a11y="mouse-shortcut"/.test(open) ||
    isPropagationGuard(open)

  // role may be conditional — `role={collapsible ? 'button' : undefined}`.
  const declaresButtonRole = (open: string) =>
    /role="button"/.test(open) || /role=\{[^}]*'button'/.test(open)

  const isKeyboardReachable = (open: string) =>
    declaresButtonRole(open) && /tabIndex/.test(open) && /onKeyDown/.test(open)

  it('the sweep finds the known set (so a zero-hit refactor cannot hide a regression)', () => {
    const hits = nodesTsx().flatMap(scanClickableNonInteractive)
    // Six today: two blueprint-dialog guards, the templates backdrop, the
    // quick-add root guard, the result-card header, the result-card actions slot.
    expect(hits.length).toBeGreaterThanOrEqual(6)
  })

  it('no clickable div/span is mouse-only', () => {
    const offenders = nodesTsx()
      .flatMap(scanClickableNonInteractive)
      .filter(h => !isDecorative(h.open) && !isKeyboardReachable(h.open))
      .map(h => `${h.file}:${h.line} <${h.tag}>`)
    expect(offenders).toEqual([])
  })

  it('the result-card collapse is a real button contract, not just role="button"', () => {
    const s = read('src/pages/nodes/canvas/ResultCardChrome.tsx')
    expect(s).toContain("role={collapsible ? 'button' : undefined}")
    expect(s).toContain('tabIndex={collapsible ? 0 : undefined}')
    expect(s).toContain('onKeyDown={collapsible ? onHeaderKeyDown : undefined}')
    // Enter AND Space both activate.
    expect(s).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/)
    // …and a control that can take focus must become VISIBLE when it does,
    // otherwise a sighted keyboard user focuses an invisible control.
    expect(s).toContain('.rcc-root:focus-within .rcc-header')
  })

  it('role="button" is NOT on the bar that hosts the action buttons', () => {
    // ARIA gives role="button" presentational children: parking it on the whole
    // header bar hid the PIN / × / REGEN actions rendered into the actions slot.
    // The role belongs to the title span; the bar keeps only a mouse shortcut.
    const s = read('src/pages/nodes/canvas/ResultCardChrome.tsx')
    // `rcc-chevron` also appears up in CHROME_CSS — anchor the search AFTER the
    // JSX header so the slice is the markup, not the stylesheet.
    const start = s.indexOf('className="rcc-header"')
    expect(start).toBeGreaterThan(0)
    const headerBar = s.slice(start, s.indexOf('rcc-chevron', start))
    expect(headerBar).toContain('data-a11y="mouse-shortcut"')
    expect(headerBar.slice(0, headerBar.indexOf('<span'))).not.toContain('role=')
  })

  it('the only mouse-shortcut opt-out in the surface is that header bar', () => {
    const marked = nodesTsx()
      .filter(f => stripComments(read(f)).includes('data-a11y="mouse-shortcut"'))
    expect(marked).toEqual(['src/pages/nodes/canvas/ResultCardChrome.tsx'])
  })
})

// ── 3. FOCUS ─────────────────────────────────────────────────────────────────

describe('nodes a11y · focus trap + restore wiring', () => {
  it('useDialog still traps, closes on Escape, and RESTORES focus', () => {
    // Everything below leans on this hook; if it silently loses one of the three
    // behaviours the menus lose it too, with no other test noticing.
    const s = read('src/hooks/useDialog.ts')
    expect(s).toContain("if (e.key === 'Escape')")
    expect(s).toContain("if (e.key === 'Tab')")
    expect(s).toContain('prevFocus?.focus?.()')
    expect(s).toContain('const prevFocus = (document.activeElement as HTMLElement | null)')
  })

  it('both canvas context menus go through useDialog', () => {
    const s = read('src/pages/nodes/canvas/FlowCanvas.tsx')
    expect(s).toContain("import { useDialog } from '../../../hooks/useDialog'")
    // One per menu (NodeContextMenu + PaneContextMenu).
    expect((s.match(/useDialog<HTMLDivElement>\(onClose\)/g) ?? []).length).toBe(2)
    // Both still render as labelled menus with menuitems.
    expect((s.match(/role="menu"/g) ?? []).length).toBe(2)
    expect(s).toContain("aria-label={t('nodeMenu.aria')}")
    expect(s).toContain("aria-label={t('paneMenu.aria')}")
    // The hand-rolled Escape listeners are GONE — useDialog owns Escape now, and
    // two handlers racing on one key is how double-close bugs start.
    expect(s).not.toMatch(/if \(e\.key === 'Escape'\) onClose\(\)/)
  })

  it('the quick-add menu traps while open and releases when it closes', () => {
    const s = read('src/pages/nodes/canvas/QuickAddPlus.tsx')
    expect(s).toContain("import { useDialog } from '../../../hooks/useDialog'")
    expect(s).toContain('useDialog<HTMLDivElement>(() => setOpen(false), open)')
    expect(s).toContain('ref={menuRef}')
    // Outside-click dismissal survives alongside it.
    expect(s).toContain("document.addEventListener('mousedown', onDocClick)")
  })

  it('hover-revealed affordances also reveal on FOCUS (no invisible tab stops)', () => {
    // Both of these paint at opacity 0 until :hover while staying in the tab
    // order — without a :focus-within twin a keyboard user lands on a control
    // they cannot see.
    expect(read('src/pages/nodes/canvas/QuickAddPlus.tsx')).toContain('.tachi-quickadd:focus-within')
    expect(read('src/pages/nodes/canvas/ResultCardChrome.tsx')).toContain('.rcc-root:focus-within .rcc-header')
  })

  it('the blueprint dialog keeps its trap (regression guard)', () => {
    const s = read('src/pages/nodes/BlueprintImportDialog.tsx')
    expect(s).toContain('useDialog<HTMLDivElement>(onClose, open)')
    expect(s).toContain('aria-modal="true"')
  })

  it('Escape closes whatever click-outside closes', () => {
    // Templates dropdown: had an outside-click backdrop and no key handler at
    // all, so a keyboard user could open it and never dismiss it.
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).toContain('const closeTemplates = useCallback(')
    expect(page).toContain('templatesBtnRef.current?.focus()')
    expect(page).toMatch(/if \(e\.key === 'Escape'\).*closeTemplates\(\)/s)
    expect(page).toContain('onClick={closeTemplates}')

    // The how-to tour: Escape exits the same way the × does (canvas restored).
    // Deliberately NOT trapped — it is a non-modal coach panel over a canvas the
    // user is told to click, so a trap would break the lesson.
    const howto = read('src/pages/nodes/NodesHowTo.tsx')
    expect(howto).toContain("if (e.key !== 'Escape') return")
    expect(howto).toContain('openerRef.current?.focus?.()')
    expect(howto).not.toContain('useDialog')
  })

  it('the inline flow rename restores focus to the row it replaced', () => {
    const s = read('src/pages/nodes/sidebar/FlowsRail.tsx')
    expect(s).toContain('const renameReturnRef = useRef<HTMLElement | null>(null)')
    expect(s).toContain('const restoreRenameFocus = useCallback(')
    expect(s).toContain('data-flow-row={f.filename}')
    // Both exits — commit and Escape — go back.
    expect(s).toMatch(/const commitRename[\s\S]{0,200}restoreRenameFocus\(f\.filename\)/)
    expect(s).toMatch(/const cancelRename[\s\S]{0,120}restoreRenameFocus\(f\.filename\)/)
    expect(s).toContain("else if (e.key === 'Escape') { e.preventDefault(); cancelRename(f) }")
  })
})

// ── 4. LIVE ──────────────────────────────────────────────────────────────────

describe('nodes a11y · live regions announce completion, not streaming', () => {
  it('a result card announces its TERMINAL state only', () => {
    const s = read('src/pages/nodes/canvas/NodeRunUI.tsx')
    expect(s).toContain('role="status" aria-live="polite" aria-atomic="true"')
    expect(s).toContain("t('runUI.statusDone'")
    expect(s).toContain("t('runUI.statusError'")
    // The region is empty for idle/running — that ternary is the whole
    // anti-chatter guarantee, so it is pinned literally.
    expect(s).toMatch(/run\.kind === 'done'[\s\S]{0,240}run\.kind === 'error'[\s\S]{0,240}: ''/)
    // The streaming text preview itself is NOT a live region.
    expect(s).not.toMatch(/<pre[\s\S]{0,200}aria-live/)
  })

  it('the live region is off-screen, never display:none (which would silence it)', () => {
    const s = read('src/pages/nodes/a11y.ts')
    expect(s).toContain("position: 'absolute'")
    expect(s).toContain("clip: 'rect(0 0 0 0)'")
    expect(s).not.toContain("display: 'none'")
    expect(s).not.toContain("visibility: 'hidden'")
  })

  it('the run panel announces completion once and never the per-step counter', () => {
    const s = read('src/pages/nodes/NodesPage.tsx')
    expect(s).toContain("t('runPanel.doneAria'")
    // Failure is announced by the alert box, not a second time by the status.
    expect(s).toContain('<div role="alert"')
    // The visible "running {{step}}/{{total}}" paragraph stays silent.
    const runningBlock = s.slice(s.indexOf("status.kind === 'running' && ("), s.indexOf("status.kind === 'error' && ("))
    expect(runningBlock).not.toContain('aria-live')
    expect(runningBlock).not.toContain('role="status"')
  })

  it('exactly one polite live region per surface — no accidental duplicates', () => {
    const all = nodesTsx().map(f => ({ f, n: (stripComments(read(f)).match(/aria-live=/g) ?? []).length }))
    const total = all.reduce((a, b) => a + b.n, 0)
    // NodeRunUI (result card) + NodesPage (run complete) + the pre-existing
    // retry stepper readout in NodeConfigPanel.
    expect(total).toBe(3)
  })
})

// ── 5. i18n ──────────────────────────────────────────────────────────────────

/** The keys this wave introduced, in "group.key" form. */
const NEW_KEYS = [
  'canvas.aria', 'canvas.undo', 'canvas.undoTitle', 'canvas.redo', 'canvas.redoTitle',
  'search.aria',
  'resultCard.toggleAria',
  'runUI.statusDone', 'runUI.statusError',
  'flowsRail.aria', 'flowsRail.rowActionAria', 'flowsRail.openAria',
  'flowsRail.renameAria', 'flowsRail.deleteAria', 'flowsRail.confirmDeleteAria',
  'palette.aria',
  'toolbar.templatesMenuAria',
  'runPanel.aria', 'runPanel.doneAria',
  'chatPanel.aria',
  'repair.fixAria',
] as const

function localeNodes(lang: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'nodes.json'), 'utf8'))
}

function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort()

describe('nodes a11y · i18n parity for the new keys', () => {
  it('every new key exists, non-empty, in all 8 locales', () => {
    const missing: string[] = []
    for (const lang of LANGS) {
      const ns = localeNodes(lang)
      for (const key of NEW_KEYS) {
        const v = lookup(ns, key)
        if (typeof v !== 'string' || v.trim() === '') missing.push(`${lang}/${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('interpolation placeholders match English in every locale', () => {
    const en = localeNodes('en')
    const drift: string[] = []
    for (const key of NEW_KEYS) {
      const want = placeholders(String(lookup(en, key)))
      if (want.length === 0) continue
      for (const lang of LANGS) {
        const got = placeholders(String(lookup(localeNodes(lang), key)))
        if (got.join(',') !== want.join(',')) drift.push(`${lang}/${key}: ${got.join(',')} != ${want.join(',')}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('every literal aria-label t() key used in the nodes surface resolves in en', () => {
    const en = localeNodes('en')
    const unresolved: string[] = []
    for (const file of nodesTsx()) {
      const src = stripComments(read(file))
      for (const m of src.matchAll(/aria-label=\{(?:rowAria\()?t\('([A-Za-z0-9_.]+)'/g)) {
        if (typeof lookup(en, m[1]) !== 'string') unresolved.push(`${file} → ${m[1]}`)
      }
    }
    expect(unresolved).toEqual([])
  })
})
