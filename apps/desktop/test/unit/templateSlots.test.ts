// apps/desktop/test/unit/templateSlots.test.ts
//
// FILL-IN-THE-BLANKS ({{var}} chips in the composer) — batch36.
//
// Two halves, on purpose:
//
//   1. REAL behaviour for the pure slot logic in @tachi/core. This is where the
//      feature actually lives — the alignment of the highlight layer and the
//      correctness of Tab both reduce to these functions, so they are exercised
//      with real inputs rather than pinned against source.
//
//   2. SOURCE ASSERTIONS for the React wiring, the house idiom (see
//      chatA11y.test.ts): this repo's test env is node-only, so the InputBar
//      contract is pinned against its own text. The assertions are written to
//      catch the specific ways this feature can silently rot — the typing path
//      acquiring an editor layer, a chip gaining a border and smearing the
//      glyphs behind it, the gate arming on plain typing, or the rejected
//      tiptap dependency arriving later through a side door.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  findSlots, nextSlot, segmentBySlots, extractVariables, AUTO_VARIABLES,
} from '@tachi/core/src/prompts/template'

const APP = path.resolve(__dirname, '../..')
const REPO = path.resolve(APP, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const INPUT_BAR = 'src/pages/chat/InputBar.tsx'
const LAYER = 'src/pages/chat/TemplateSlotLayer.tsx'
const PICKER = 'src/components/PromptPicker.tsx'
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

/** Drop comments so an assertion about CODE is never satisfied by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ── 1. The slot model ────────────────────────────────────────────────────────

describe('findSlots: every occurrence is its own blank', () => {
  it('locates a slot at an exact, sliceable range', () => {
    const text = 'Hello {{name}}!'
    const [s] = findSlots(text)
    expect(s).toMatchObject({ name: 'name', auto: false })
    expect(text.slice(s.start, s.end)).toBe('{{name}}')
  })

  it('keeps DUPLICATES — extractVariables de-dupes, findSlots must not', () => {
    // Two {{text}} in a body are two separate boxes on screen; collapsing them
    // would paint one and leave the other as bare braces.
    const body = 'A {{text}} then B {{text}} end'
    expect(extractVariables(body)).toEqual(['text'])
    expect(findSlots(body).map(s => s.name)).toEqual(['text', 'text'])
    const [a, b] = findSlots(body)
    expect(a.start).toBeLessThan(b.start)
    expect(body.slice(b.start, b.end)).toBe('{{text}}')
  })

  it('flags auto-vars but still reports them as blanks', () => {
    // buildAutoVariableValues yields '' for an unknown model and renderTemplate
    // keeps empty values literal, so {{model}} really can survive an insert. A
    // literal {{model}} reaching the provider is exactly as wrong as {{text}}.
    const slots = findSlots('run {{model}} on {{topic}}')
    expect(slots.map(s => s.name)).toEqual(['model', 'topic'])
    expect(slots[0].auto).toBe(true)
    expect(slots[1].auto).toBe(false)
    expect(AUTO_VARIABLES.has('model')).toBe(true)
  })

  it('tolerates inner whitespace and spans the whole literal', () => {
    const text = 'x {{  spaced  }} y'
    const [s] = findSlots(text)
    expect(s.name).toBe('spaced')
    expect(text.slice(s.start, s.end)).toBe('{{  spaced  }}')
  })

  it('ignores braces that are not identifiers — JSON/code bodies stay clean', () => {
    expect(findSlots('{{ 123 }} {{}} { {x} } {{a b}} {"k": {"n": 1}}')).toEqual([])
  })

  it('returns nothing for ordinary prose', () => {
    expect(findSlots('just a normal message')).toEqual([])
  })
})

describe('segmentBySlots: the alignment invariant', () => {
  // The layer is painted UNDER a transparent textarea. If segmentation ever
  // drops or adds a single character, every glyph after it shifts and the whole
  // message smears. Concatenation must reproduce the input byte-for-byte.
  const CASES = [
    '',
    'no slots here',
    '{{a}}',
    '{{a}}{{b}}',
    'lead {{a}} mid {{b}} tail',
    'Summarize in {{bullets}} bullets:\n\n{{text}}',
    '{{a}} }} {{ {{b}}',
    'unicode ✓ Ж 日本語 {{имя_нет}} {{ok}} end',
    'trailing newline {{x}}\n',
  ]

  for (const text of CASES) {
    it(`round-trips exactly: ${JSON.stringify(text.slice(0, 32))}`, () => {
      expect(segmentBySlots(text).map(p => p.text).join('')).toBe(text)
    })
  }

  it('marks exactly the slot runs and nothing else', () => {
    const segs = segmentBySlots('lead {{a}} tail')
    expect(segs.map(s => [s.text, s.slot ? s.slot.name : null])).toEqual([
      ['lead ', null],
      ['{{a}}', 'a'],
      [' tail', null],
    ])
  })

  it('emits no empty run between adjacent slots', () => {
    // An empty span would be a stray React child with no purpose; more to the
    // point it signals an off-by-one in the slicing.
    expect(segmentBySlots('{{a}}{{b}}').every(s => s.text.length > 0)).toBe(true)
    expect(segmentBySlots('{{a}}{{b}}').map(s => s.text)).toEqual(['{{a}}', '{{b}}'])
  })
})

describe('nextSlot: Tab always advances', () => {
  const text = 'a {{one}} b {{two}} c {{three}}'
  const slots = findSlots(text)

  it('finds the first blank from before the text', () => {
    expect(nextSlot(slots, -1)?.name).toBe('one')
  })

  it('ADVANCES from the slot you are standing on (the >= regression)', () => {
    // Selecting a slot parks the caret at its own `start`. With `start >= caret`
    // Tab would re-select the same blank forever; this is that guard.
    expect(nextSlot(slots, slots[0].start)?.name).toBe('two')
    expect(nextSlot(slots, slots[1].start)?.name).toBe('three')
  })

  it('wraps forward past the last blank', () => {
    expect(nextSlot(slots, slots[2].start)?.name).toBe('one')
  })

  it('walks backward and wraps', () => {
    expect(nextSlot(slots, slots[2].start, -1)?.name).toBe('two')
    expect(nextSlot(slots, slots[1].start, -1)?.name).toBe('one')
    expect(nextSlot(slots, slots[0].start, -1)?.name).toBe('three')
  })

  it('is null when there is nothing to fill', () => {
    expect(nextSlot([], 0)).toBeNull()
    expect(nextSlot([], 5, -1)).toBeNull()
  })

  it('cycles every blank exactly once before repeating', () => {
    const seen: string[] = []
    let caret = -1
    for (let i = 0; i < slots.length; i++) {
      const s = nextSlot(slots, caret)!
      seen.push(s.name)
      caret = s.start
    }
    expect(seen).toEqual(['one', 'two', 'three'])
    expect(nextSlot(slots, caret)!.name).toBe('one')
  })
})

// ── 2. The gate that rejected tiptap ─────────────────────────────────────────

describe('bundle gate: no rich-text editor entered the tree', () => {
  const REJECTED = ['@tiptap/', 'prosemirror-', 'slate', 'lexical', 'quill', 'draft-js']

  it('no rejected editor dependency in any workspace package.json', () => {
    const pkgs = [
      'apps/desktop/package.json',
      'packages/core/package.json',
      'package.json',
    ].filter(p => fs.existsSync(path.join(REPO, p)))
    // Anti-vacuity: the list of files we actually checked must be non-trivial.
    expect(pkgs.length).toBeGreaterThanOrEqual(2)
    for (const rel of pkgs) {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')) as Record<string, unknown>
      const deps = Object.keys({
        ...(pkg.dependencies as object ?? {}),
        ...(pkg.devDependencies as object ?? {}),
      })
      for (const bad of REJECTED) {
        expect(deps.filter(d => d.startsWith(bad)), `${rel} must not depend on ${bad}`).toEqual([])
      }
    }
  })

  it('the blanks feature imports nothing beyond the pure core helpers', () => {
    // Comments are stripped: the file's header NAMES the rejected libraries on
    // purpose (that rationale is the point of the gate) and must not be mistaken
    // for a dependency on them.
    const s = stripComments(read(LAYER))
    for (const bad of REJECTED) expect(s).not.toContain(bad)
    expect(s).toContain("from '@tachi/core/src/prompts/template'")
    // Anti-vacuity: stripComments must not have eaten the code too.
    expect(s).toContain('segmentBySlots')
  })
})

// ── 3. The typing path is untouched ──────────────────────────────────────────

describe('InputBar: normal typing does not pass through any new layer', () => {
  const src = () => stripComments(read(INPUT_BAR))

  it('the textarea is still a plain controlled textarea', () => {
    const s = src()
    expect(s).toContain('<textarea')
    expect(s).toContain('onChange={e => setText(e.target.value)}')
    // No contentEditable anywhere: that is the other light path, and shipping
    // both was explicitly out of scope.
    expect(s).not.toContain('contentEditable')
    expect(s).not.toContain('contenteditable')
  })

  it('the highlight layer only mounts while blanks are armed', () => {
    expect(src()).toContain('{blanksActive && <TemplateSlotLayer')
  })

  it('the textarea keeps its own background unless the layer is showing', () => {
    // If this ever became unconditionally transparent, the composer would go
    // see-through for every user who never touches a template.
    expect(src()).toContain("background: blanksActive ? 'transparent' : 'var(--bg-inset)'")
  })

  it('the IME composition guard wraps the new key handling', () => {
    // Tab and Escape belong to the candidate window while composing
    // Japanese/Chinese/Korean — all three are shipped locales.
    expect(src()).toContain('blanksActive && !e.nativeEvent.isComposing')
  })
})

describe('InputBar: the gate arms only on a template insert', () => {
  const src = () => stripComments(read(INPUT_BAR))

  it('setSlotsArmed(true) is never called from a typing path', () => {
    const s = src()
    // The only place that can arm is insertTemplate, and it arms from a
    // computed boolean rather than a literal `true`.
    expect(s).not.toContain('setSlotsArmed(true)')
    expect(s).toContain('const armed = findSlots(next).length > 0')
    expect(s).toContain('setSlotsArmed(armed)')
  })

  it('arming is reachable only through the picker callback', () => {
    const s = src()
    expect(s).toContain('onInsert={insertTemplate}')
    // Exactly one definition of the insert path.
    expect(s.match(/const insertTemplate = /g)?.length).toBe(1)
  })

  it('the picker is told the composer can hold blanks', () => {
    expect(src()).toContain('supportsBlanks')
  })

  it('disarms when the composer is emptied by a successful send', () => {
    const s = src()
    expect(s).toMatch(/setText\(''\)\s*\n\s*setSlotsArmed\(false\)/)
  })

  it('Escape disarms so the text can be sent verbatim', () => {
    const s = src()
    expect(s).toContain("if (e.key === 'Escape')")
    expect(s.match(/setSlotsArmed\(false\)/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('InputBar: the send gate', () => {
  const src = () => stripComments(read(INPUT_BAR))

  it('blocks a send that still has blanks and parks the caret on the first', () => {
    const s = src()
    expect(s).toMatch(/if \(!override && blanksActive\) \{\s*\n\s*selectSlot\(-1\)\s*\n\s*return\s*\n\s*\}/)
  })

  it('runs BEFORE slash-command interception', () => {
    const s = src()
    const gate = s.indexOf('if (!override && blanksActive)')
    const slash = s.indexOf('parseCommandInput(composed')
    expect(gate).toBeGreaterThan(-1)
    expect(slash).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(slash)
  })

  it('never blocks an internal override send', () => {
    // /search and friends compose their own text; they are not armed and must
    // not be able to trip a gate meant for the human composer.
    expect(src()).toContain('!override && blanksActive')
  })

  it('sits after the media-mode short-circuit, leaving media sends untouched', () => {
    const s = src()
    expect(s.indexOf('if (isMediaMode) { sendMedia(); return }'))
      .toBeLessThan(s.indexOf('if (!override && blanksActive)'))
  })
})

// ── 4. The layer cannot smear the text it sits under ─────────────────────────

describe('TemplateSlotLayer: pixel contract', () => {
  const src = () => read(LAYER)

  it('shares ONE set of type metrics with the textarea', () => {
    // Two independently-typed boxes would drift the moment either is restyled.
    const layer = src()
    const bar = read(INPUT_BAR)
    expect(layer).toContain('export const SLOT_TYPE_METRICS')
    expect(bar).toContain('SLOT_TYPE_METRICS')
    for (const prop of ['padding', 'fontFamily', 'fontSize', 'lineHeight']) {
      expect(bar, `textarea must take ${prop} from SLOT_TYPE_METRICS`)
        .toContain(`SLOT_TYPE_METRICS.${prop}`)
    }
  })

  it('the textarea is POSITIONED so it paints above the absolute layer', () => {
    // Site driver, 2026-07-27: the layer is position:absolute with an opaque
    // background; an absolutely-positioned box paints OVER a static sibling
    // regardless of DOM order, so under bankr the armed composer hid every
    // glyph. The textarea must be positioned (and later in the DOM) to win.
    const bar = read(INPUT_BAR)
    expect(bar).toMatch(/position: 'relative' as const/)
    const layerIdx = bar.indexOf('<TemplateSlotLayer')
    const textareaIdx = bar.indexOf('ref={textareaRef}')
    expect(layerIdx).toBeGreaterThan(-1)
    expect(textareaIdx).toBeGreaterThan(layerIdx)
  })

  it('chip spans are layout-neutral — background/radius/shadow only', () => {
    // A border or padding on a chip advances every glyph after it. This is the
    // single most likely way to break the overlay, so it is pinned by shape:
    // the chip style object is extracted and checked property by property.
    const m = src().match(/style=\{\{\s*\n\s*background: 'var\(--accent-muted\)',([\s\S]*?)\}\}/)
    expect(m, 'chip style block not found — did the chip span change shape?').toBeTruthy()
    const chipStyle = m![1]
    for (const banned of ['border:', 'borderWidth', 'padding', 'margin', 'fontWeight', 'fontSize', 'letterSpacing', 'fontFamily']) {
      expect(chipStyle, `chip style must not set ${banned}`).not.toContain(banned)
    }
    expect(chipStyle).toContain('boxShadow')
  })

  it('paints backgrounds only — the glyphs come from the textarea', () => {
    expect(src()).toContain("color: 'transparent'")
  })

  it('wraps exactly like a textarea', () => {
    const s = src()
    expect(s).toContain("whiteSpace: 'pre-wrap'")
    expect(s).toContain("overflowWrap: 'break-word'")
  })

  it('reserves the trailing line a textarea reserves', () => {
    // Without this the layer scrolls a line short of the textarea.
    expect(src()).toContain("{'\\n'}")
  })

  it('is decorative to assistive tech — the textarea carries the real text', () => {
    expect(src()).toContain('aria-hidden="true"')
    expect(src()).toContain("pointerEvents: 'none'")
  })

  it('the wrapper cannot stretch taller than the textarea', () => {
    // As a stretched flex item the wrapper would grow to the row height and the
    // layer (inset:0) would paint past the textarea's bottom border.
    expect(stripComments(read(INPUT_BAR))).toContain("alignSelf: 'flex-start'")
  })

  it('keeps the scroll of the two boxes in step', () => {
    expect(read(INPUT_BAR)).toContain('onScroll=')
    expect(src()).toContain('scrollTop')
  })
})

// ── 5. The Nodes prompt node is not dragged along ────────────────────────────

describe('PromptPicker: the blanks route is opt-in', () => {
  const src = () => read(PICKER)

  it('defaults off, so the Nodes Prompt node keeps its inline form', () => {
    const s = src()
    expect(s).toContain('supportsBlanks?: boolean')
    expect(s).toContain('vars.length === 0 || props.supportsBlanks')
    // The inline fill form must still exist for the caller that has no composer.
    expect(s).toContain('setOpenId(tpl.id)')
    expect(s).toContain('insertWithValues')
  })

  it('the Nodes caller passes no such flag', () => {
    const node = fs.readFileSync(
      path.join(APP, 'src/pages/nodes/canvas/nodeTypes/PromptNode.tsx'), 'utf8')
    expect(node).toContain('<PromptPicker')
    expect(node).not.toContain('supportsBlanks')
  })

  it('auto-vars are still resolved before the body travels', () => {
    expect(src()).toContain('renderTemplate(tpl.body, autoValues())')
  })
})

// ── 6. Motion + i18n ─────────────────────────────────────────────────────────

describe('reduced motion', () => {
  it('the arm animation is registered in the reduce block', () => {
    const css = read('src/globals.css')
    expect(css).toContain('.tachi-slot-layer { animation: tachi-slot-arm')
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toContain('.tachi-slot-layer')
  })

  it('animates opacity only — a moving layer would smear the text under it', () => {
    const css = read('src/globals.css')
    const kf = css.slice(css.indexOf('@keyframes tachi-slot-arm'), css.indexOf('.tachi-slot-layer {'))
    expect(kf).toContain('opacity')
    for (const banned of ['transform', 'translate', 'scale', 'margin', 'padding']) {
      expect(kf, `arm keyframes must not animate ${banned}`).not.toContain(banned)
    }
  })
})

describe('i18n: the blanks strings ship in all 8 locales', () => {
  const KEYS = ['blanksHint', 'blanksDismiss'] as const

  for (const lang of LANGS) {
    it(`${lang} has every key, non-empty`, () => {
      const ns = JSON.parse(
        fs.readFileSync(path.join(APP, 'src/i18n/locales', lang, 'chat.json'), 'utf8'),
      ) as { composer: Record<string, string> }
      for (const k of KEYS) {
        expect(typeof ns.composer[k], `${lang}/chat.json composer.${k}`).toBe('string')
        expect(ns.composer[k].trim().length).toBeGreaterThan(0)
      }
    })
  }

  it('the hint interpolates `n`, not `count` (no plural forms to translate)', () => {
    for (const lang of LANGS) {
      const ns = JSON.parse(
        fs.readFileSync(path.join(APP, 'src/i18n/locales', lang, 'chat.json'), 'utf8'),
      ) as { composer: Record<string, string> }
      expect(ns.composer.blanksHint, `${lang} must carry the {{n}} placeholder`).toContain('{{n}}')
      expect(ns.composer.blanksHint).not.toContain('{{count}}')
    }
    expect(stripComments(read(INPUT_BAR))).toContain('n: slots.length')
  })

  it('the hint is a live region, not decoration — it teaches the Esc hatch', () => {
    const s = stripComments(read(INPUT_BAR))
    expect(s).toContain('role="status"')
    expect(s).toContain("t('composer.blanksHint'")
    expect(s).toContain("t('composer.blanksDismiss'")
  })
})
