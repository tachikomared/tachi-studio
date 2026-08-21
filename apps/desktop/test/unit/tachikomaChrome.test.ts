// apps/desktop/test/unit/tachikomaChrome.test.ts
//
// Guards for the TK-05 CHASSIS (src/components/TachikomaChrome.tsx + its
// helpers + the `[data-chassis]` block in globals.css). Same conventions as
// structureSheets.test.ts: pure helpers are exercised directly, and everything
// that only exists as CSS/JSX is checked at the SOURCE level — the test env is
// node with no DOM, so there is no getComputedStyle to lean on.
//
// The four defects these tests exist to prevent, all of which have SHIPPED in
// this app before:
//   1. Chrome that disappears on a narrow window (the retired crab theme's claws
//      hid below 1180px, so at the owner's ~1068px daily size that theme lost
//      its whole signature). The chassis must RESTAGE, never hide.
//   2. `filter: drop-shadow()` on a transparent element that holds text — it
//      traces alpha, so it paints a ghost copy of the glyphs.
//   3. A decorative layer that eats clicks (missing pointer-events: none).
//   4. A theme-level `cursor` declaration killing the resize affordance
//      (see resizeCursor.test.ts).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  TK_THEME,
  TK_BEZEL,
  TK_BEZEL_MIN,
  TK_FEATURES,
  TK_STAGE_WIDE_MIN_PX,
  TK_STAGE_MID_MIN_PX,
  isTachikomaTheme,
  chassisStage,
  chassisBezel,
  chassisLayout,
  chassisChamferPx,
  chassisKeySizePx,
  chassisBoltPx,
  chassisWheelPx,
  chassisCaptionMode,
  chassisStatusMode,
  chassisLinkLabel,
  hasChassisFeature,
  TK_CAPTION_MIN_PX,
  TK_STATUS_STACK_MIN_PX,
  TK_STATUS_LINE_MIN_PX,
  TK_DEFAULT_API_PORT,
  TK_MOCK_W,
  TK_MOCK_H,
  TK_RESIZE_EDGE_PX,
  chassisDragBandPx,
  chassisSlabInsets,
  chassisSlabPolygon,
  chassisLampLit,
  type ChassisStage,
  type ChassisLampSource,
} from '../../src/components/tachikoma/tachikomaChrome.helpers'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** Strip block comments (incl. JSX `{/* … *\/}`) and line comments. Every source
 *  guard below runs on the stripped text: these files DOCUMENT the defects they
 *  must not contain ("no drop-shadow", "no cursor"), so an un-stripped scan
 *  would fail on the prose that explains the rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every `@media` rule in a sheet, with its own braces matched — a naive
 *  `split('@media')` would swallow every rule that FOLLOWS the query too, which
 *  is exactly how a "the chassis is not in a max-width block" assertion would
 *  accidentally read the chassis rule that sits after it. */
function mediaBlocks(css: string): Array<{ query: string; body: string }> {
  const out: Array<{ query: string; body: string }> = []
  const re = /@media([^{]*)\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    out.push({ query: m[1].trim(), body: css.slice(start, i - 1) })
  }
  return out
}

const STAGES: ChassisStage[] = ['wide', 'mid', 'narrow', 'flush']

/** Window sizes we support: minWidth/minHeight are 900×600 (electron/main.ts),
 *  1068 is the owner's daily width, 1400×900 is the default window. */
const VIEWPORTS = [
  { width: 900, height: 600 },
  { width: 1024, height: 700 },
  { width: 1068, height: 720 },
  { width: 1180, height: 800 },
  { width: 1280, height: 800 },
  { width: 1400, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

describe('isTachikomaTheme (mount predicate)', () => {
  it('is true only for the chassis theme id', () => {
    expect(TK_THEME).toBe('tachikoma-red')
    expect(isTachikomaTheme(TK_THEME)).toBe(true)
  })
  it('is false for every other theme and for nullish input', () => {
    for (const other of ['tachi-dark', 'tachi-neon', 'comic', 'tachi-opus5', 'bankr', '', 'custom:x']) {
      expect(isTachikomaTheme(other)).toBe(false)
    }
    expect(isTachikomaTheme(null)).toBe(false)
    expect(isTachikomaTheme(undefined)).toBe(false)
  })
})

// ── THE headline contract ────────────────────────────────────────────────────
describe('the chassis never disappears (restage, do not hide)', () => {
  it('maps EVERY viewport width to a stage — there is no null / hidden case', () => {
    for (const w of [320, 640, 899, 900, 1067, 1068, 1179, 1180, 1399, 1400, 4096]) {
      expect(chassisStage({ width: w, maximized: false })).toBeTruthy()
      // Owner directive 2026-07-27: maximized no longer collapses the SLAB -
      // width decides, so a maximized 2560px window keeps the full body.
      expect(chassisStage({ width: w, maximized: true })).toBe(chassisStage({ width: w, maximized: false }))
    }
  })

  it('keeps a POSITIVE bezel on both axes at every stage and every viewport', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = chassisBezel(stage, vp)
        expect(b.x, `${stage} @ ${vp.width}`).toBeGreaterThanOrEqual(TK_BEZEL_MIN.x)
        expect(b.y, `${stage} @ ${vp.height}`).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
      }
    }
  })

  it('is still on screen at the owner\'s ~1068px daily width', () => {
    // The exact regression the retired crab chrome shipped: at 1068px it
    // rendered nothing at all.
    const layout = chassisLayout({ theme: TK_THEME, width: 1068, height: 720, maximized: false })
    expect(layout).not.toBeNull()
    expect(layout!.stage).toBe('narrow')
    expect(layout!.bezel.x).toBeGreaterThan(0)
    expect(layout!.bezel.y).toBeGreaterThan(0)
    // …and it is still the same object: bars, keys, LEDs and bolts all present.
    for (const f of ['bars', 'keys', 'leds', 'bolts'] as const) {
      expect(hasChassisFeature('narrow', f), f).toBe(true)
    }
  })

  it('draws the slab itself in EVERY stage', () => {
    for (const stage of STAGES) expect(hasChassisFeature(stage, 'bars')).toBe(true)
  })

  it('mounts the window KEYS in EVERY stage — they are the only controls on screen', () => {
    // The structure sheet hides the TitleBar's own −□✕ row whenever the
    // chassis mounts its keys ([data-chassis-keys] interlock), so a stage
    // without 'keys' would strand the operator with ZERO window controls.
    // Live-found at maximized: flush lacked 'keys' while the (now working)
    // !important hide removed the TitleBar row — no minimize, no close.
    for (const stage of STAGES) {
      expect(hasChassisFeature(stage, 'keys'), `stage ${stage} must mount keys`).toBe(true)
    }
    // And the key edge still fits the thinnest flank: flush bezel.x is 14px,
    // the key minimum is 14px — edge-to-edge, never zero, never overflowing
    // by more than the design allows.
    expect(chassisKeySizePx(chassisBezel('flush', { width: 2560, height: 1400 }).x)).toBeGreaterThanOrEqual(14)
  })

  it('returns null ONLY for a foreign theme', () => {
    expect(chassisLayout({ theme: 'tachi-dark', width: 1600, height: 900, maximized: false })).toBeNull()
    expect(chassisLayout({ theme: null, width: 1600, height: 900, maximized: false })).toBeNull()
    // Same size, right theme → a layout.
    expect(chassisLayout({ theme: TK_THEME, width: 400, height: 300, maximized: false })).not.toBeNull()
  })
})

describe('chassisStage (staging thresholds)', () => {
  it('steps wide → mid → narrow as the window shrinks', () => {
    expect(chassisStage({ width: TK_STAGE_WIDE_MIN_PX, maximized: false })).toBe('wide')
    expect(chassisStage({ width: TK_STAGE_WIDE_MIN_PX - 1, maximized: false })).toBe('mid')
    expect(chassisStage({ width: TK_STAGE_MID_MIN_PX, maximized: false })).toBe('mid')
    expect(chassisStage({ width: TK_STAGE_MID_MIN_PX - 1, maximized: false })).toBe('narrow')
  })
  it('maximized stages by WIDTH on the red theme (owner: "only opus goes thin") - flush needs the explicit opt-in', () => {
    for (const w of [900, 1180, 1400, 2560]) {
      expect(chassisStage({ width: w, maximized: true })).toBe(chassisStage({ width: w, maximized: false }))
      expect(chassisStage({ width: w, maximized: true, flushOnMaximized: true })).toBe('flush')
    }
  })
  it('keeps the 1180px breakpoint the retired crab chrome hid at', () => {
    // Same number, opposite behaviour — this is the point of the whole exercise:
    // where that theme vanished, the chassis restages inward.
    expect(TK_STAGE_MID_MIN_PX).toBe(1180)
  })
})

describe('chassisBezel (adaptive plate inset)', () => {
  it('shrinks monotonically from wide to flush', () => {
    expect(TK_BEZEL.wide.x).toBeGreaterThan(TK_BEZEL.mid.x)
    expect(TK_BEZEL.mid.x).toBeGreaterThan(TK_BEZEL.narrow.x)
    expect(TK_BEZEL.narrow.x).toBeGreaterThan(TK_BEZEL.flush.x)
    expect(TK_BEZEL.wide.y).toBeGreaterThan(TK_BEZEL.mid.y)
    expect(TK_BEZEL.mid.y).toBeGreaterThan(TK_BEZEL.narrow.y)
    expect(TK_BEZEL.narrow.y).toBeGreaterThan(TK_BEZEL.flush.y)
  })

  it('keeps the flanks thicker than the rails (the flanks carry the hardware)', () => {
    for (const stage of STAGES) expect(TK_BEZEL[stage].x).toBeGreaterThan(TK_BEZEL[stage].y)
  })

  it('never spends more than a fifth of either axis on decoration', () => {
    for (const vp of VIEWPORTS) {
      const stage = chassisStage({ width: vp.width, maximized: false })
      const b = chassisBezel(stage, vp)
      expect(2 * b.x, `x @ ${vp.width}`).toBeLessThanOrEqual(vp.width * 0.2)
      expect(2 * b.y, `y @ ${vp.height}`).toBeLessThanOrEqual(vp.height * 0.22)
    }
  })

  it('clamps the nominal bezel down on a small window instead of overflowing it', () => {
    // A 'wide' stage forced onto a short window must not eat 124px of height.
    const b = chassisBezel('wide', { width: 1400, height: 600 })
    expect(b.y).toBeLessThan(TK_BEZEL.wide.y)
    expect(b.y).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
  })

  it('emits whole pixels (a half-pixel seam blurs the counterbore)', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = chassisBezel(stage, vp)
        expect(Number.isInteger(b.x)).toBe(true)
        expect(Number.isInteger(b.y)).toBe(true)
      }
    }
  })

  it('returns the nominal bezel when no viewport is supplied', () => {
    for (const stage of STAGES) expect(chassisBezel(stage)).toEqual(TK_BEZEL[stage])
  })
})

describe('derived hardware sizes', () => {
  it('never cuts a chamfer deeper than the rail it sits in', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        expect(chassisChamferPx(stage, bezel)).toBeLessThan(bezel.y + 1)
        expect(chassisChamferPx(stage, bezel)).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the window keys inside the flank they are mounted on', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        // flush: the 14px flank takes the 14px minimum key EDGE-TO-EDGE —
        // clearance is deliberately zero there (keys are the only window
        // controls; shrinking the flank must never delete them). Every wider
        // stage still keeps the ~7px key-well clearance per side.
        if (stage === 'flush') {
          expect(chassisKeySizePx(bezel.x), `flush @ ${vp.width}`).toBeLessThanOrEqual(bezel.x)
          continue
        }
        // The key well adds ~7px of clearance per side.
        expect(chassisKeySizePx(bezel.x) + 12, `${stage} @ ${vp.width}`).toBeLessThanOrEqual(bezel.x)
      }
    }
  })

  it('keeps a key big enough to read as a physical key', () => {
    expect(chassisKeySizePx(TK_BEZEL.wide.x)).toBeGreaterThanOrEqual(20)
    expect(chassisKeySizePx(TK_BEZEL.narrow.x)).toBeGreaterThanOrEqual(14)
  })

  it('shrinks the bolt heads on the narrow stage', () => {
    expect(chassisBoltPx('narrow')).toBeLessThan(chassisBoltPx('wide'))
  })
})

describe('feature staging (less hardware, never no hardware)', () => {
  it('drops the loudest pieces first as the window narrows', () => {
    expect(TK_FEATURES.wide.length).toBeGreaterThan(TK_FEATURES.mid.length)
    expect(TK_FEATURES.mid.length).toBeGreaterThan(TK_FEATURES.narrow.length)
    expect(TK_FEATURES.narrow.length).toBeGreaterThan(TK_FEATURES.flush.length)
  })
  it('is a strict subset chain — nothing appears only on a smaller stage', () => {
    const chain: ChassisStage[] = ['wide', 'mid', 'narrow', 'flush']
    for (let i = 1; i < chain.length; i++) {
      for (const f of TK_FEATURES[chain[i]]) {
        expect(TK_FEATURES[chain[i - 1]], `${f} missing from ${chain[i - 1]}`).toContain(f)
      }
    }
  })
  it('keeps at least one live indicator in every stage', () => {
    for (const stage of STAGES) expect(hasChassisFeature(stage, 'leds')).toBe(true)
  })

  it('keeps the unit IDENTIFIABLE in every stage (plate + lamps + status)', () => {
    // The mock's inventory is not decoration you can shed: which unit this is,
    // whether it is alive, and where it is listening survive to the flush bezel.
    for (const stage of STAGES) {
      for (const f of ['topplate', 'ledblock', 'status'] as const) {
        expect(hasChassisFeature(stage, f), `${f} missing from ${stage}`).toBe(true)
      }
    }
  })

  it('keeps the hazard band and the unit marking at the owner\'s daily width', () => {
    for (const f of ['hazardband', 'marking', 'ventstrip'] as const) {
      expect(hasChassisFeature('narrow', f), f).toBe(true)
    }
  })
})

// ── Caption degradation ──────────────────────────────────────────────────────
// "Rail narrows, chips truncate to their LED bars" (the mock's own caption for
// the 1068×800 frame). A caption that no longer fits must become a BAR, never
// nothing — that is the difference between restaging and hiding.
describe('chassisCaptionMode (truncate to LED bars, never delete)', () => {
  it('prints the whole marking only on the widest stage', () => {
    expect(chassisCaptionMode('wide', TK_BEZEL.wide.y)).toBe('full')
    expect(chassisCaptionMode('mid', TK_BEZEL.mid.y)).toBe('short')
  })

  it('drops to an LED bar on the narrow and flush stages', () => {
    expect(chassisCaptionMode('narrow', TK_BEZEL.narrow.y)).toBe('bar')
    expect(chassisCaptionMode('flush', TK_BEZEL.flush.y)).toBe('bar')
  })

  it('drops to a bar whenever the rail is thinner than one line of type', () => {
    for (const stage of STAGES) {
      expect(chassisCaptionMode(stage, TK_CAPTION_MIN_PX - 1)).toBe('bar')
    }
  })

  it('never returns a mode outside the three it declares', () => {
    for (const stage of STAGES) {
      for (const y of [0, 1, 8, 15, 16, 24, 46, 62, 200]) {
        expect(['full', 'short', 'bar']).toContain(chassisCaptionMode(stage, y))
      }
    }
  })
})

describe('chassisStatusMode (bottom-rail copy)', () => {
  it('stacks both rows on the wide and mid rails', () => {
    expect(chassisStatusMode(TK_BEZEL.wide.y)).toBe('stacked')
    expect(chassisStatusMode(TK_BEZEL.mid.y)).toBe('stacked')
  })
  it('steps stacked → single → bar as the rail thins', () => {
    expect(chassisStatusMode(TK_STATUS_STACK_MIN_PX)).toBe('stacked')
    expect(chassisStatusMode(TK_STATUS_STACK_MIN_PX - 1)).toBe('single')
    expect(chassisStatusMode(TK_STATUS_LINE_MIN_PX)).toBe('single')
    expect(chassisStatusMode(TK_STATUS_LINE_MIN_PX - 1)).toBe('bar')
  })
  it('still prints a status line at the owner\'s daily width', () => {
    expect(chassisStatusMode(TK_BEZEL.narrow.y)).not.toBe('bar')
  })
})

describe('chassisLinkLabel (REAL port when there is one)', () => {
  it('prints the reported loopback port', () => {
    expect(chassisLinkLabel(8123)).toBe('127.0.0.1:8123')
  })
  it('falls back to the documented default when the server has not reported', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chassisLinkLabel(bad)).toBe(`127.0.0.1:${TK_DEFAULT_API_PORT}`)
    }
    expect(TK_DEFAULT_API_PORT).toBe(11435)
  })
  it('never emits a fractional port', () => {
    expect(chassisLinkLabel(1234.7)).toBe('127.0.0.1:1234')
  })
})

describe('chassisWheelPx (drive wheel)', () => {
  it('keeps the wheel inside the flank it is bolted to', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        if (!hasChassisFeature(stage, 'wheel')) continue
        expect(chassisWheelPx(bezel.x) + 12, `${stage} @ ${vp.width}`).toBeLessThanOrEqual(bezel.x)
      }
    }
  })
  it('stays big enough to read as a wheel', () => {
    expect(chassisWheelPx(TK_BEZEL.wide.x)).toBeGreaterThanOrEqual(20)
  })
})

// ── Component source guards ─────────────────────────────────────────────────
describe('TachikomaChrome.tsx (source guards)', () => {
  const raw = read('components/TachikomaChrome.tsx')
  const src = stripComments(raw)

  it('renders null unless the chassis theme is active', () => {
    expect(src).toMatch(/if\s*\(theme\s*!==\s*TK_THEME[^)]*\)\s*return null/)
  })

  it('has no width-gated early return and no display:none', () => {
    // The retired crab chrome's mistake, in the two forms it could reappear in.
    expect(src).not.toMatch(/display:\s*'?none/)
    expect(src).not.toContain('max-width')
    expect(src).not.toMatch(/width\s*<\s*\d+\s*\)\s*return null/)
  })

  it('sets pointer-events: none on EVERY decorative layer', () => {
    // Mechanical: one `style={{ ...LAYER` per `<div`, and LAYER is the only
    // place pointer-events: none is declared. A new layer cannot skip the base.
    const divs = (src.match(/<div/g) ?? []).length
    const layered = (src.match(/style=\{\{\s*\.\.\.LAYER/g) ?? []).length
    expect(divs).toBeGreaterThan(10)
    expect(layered).toBe(divs)
    expect(src).toMatch(/const LAYER[^=]*=\s*\{[^}]*pointerEvents:\s*'none'/)
  })

  // ── The ONE hit-testable exception ─────────────────────────────────────────
  // The mock draws the three window keys as the unit's physical controls, so
  // they are REAL buttons wired to the same IPC the TitleBar uses. That is the
  // only place `pointerEvents: 'auto'` may appear, it must live in a single
  // named constant, and it must only ever be spread onto <button> — a
  // click-eating <div> is still the defect this suite exists to prevent.
  it('confines pointer-events: auto to ONE constant used only on buttons', () => {
    expect((src.match(/pointerEvents:\s*'auto'/g) ?? []).length).toBe(1)
    expect(src).toMatch(/const KEY_HIT[^=]*=\s*\{[^}]*pointerEvents:\s*'auto'/)
    // Every KEY_HIT spread is on a <button …>, never on a <div>.
    const buttons = (src.match(/<button/g) ?? []).length
    const hits = (src.match(/style=\{\{\s*\.\.\.KEY_HIT/g) ?? []).length
    expect(buttons).toBe(3)          // minimise / maximise / close
    expect(hits).toBe(buttons)
    expect(src).not.toMatch(/<div[^>]*\.\.\.KEY_HIT/)
  })

  it('wires the keys to the SAME window IPC the TitleBar uses', () => {
    for (const call of ['window?.minimize', 'window?.maximizeToggle', 'window?.close']) {
      expect(src, `${call} missing`).toContain(call)
    }
  })

  it('labels the keys and keeps them out of an aria-hidden subtree', () => {
    // An aria-hidden ANCESTOR over a focusable control hides it from a screen
    // reader while leaving it in the tab order — a real defect. So the scenery
    // wrapper carries aria-hidden and the key well is its SIBLING.
    expect(src).toMatch(/aria-label="Minimize"/)
    expect(src).toMatch(/aria-label="Close"/)
    expect(src).toMatch(/<div aria-hidden style=\{\{\s*\.\.\.LAYER/)
    // The keys are rendered outside that wrapper.
    const wrapEnd = src.indexOf('THE ONLY LIVE HARDWARE') >= 0
      ? src.indexOf('THE ONLY LIVE HARDWARE')
      : src.indexOf('<WindowKeys')
    expect(src.indexOf('<WindowKeys')).toBeGreaterThan(wrapEnd - 1)
  })

  it('is hidden from assistive tech (it is scenery, not content)', () => {
    expect(src).toContain('aria-hidden')
  })

  // ── The mock's inventory ───────────────────────────────────────────────────
  it('ships the full TK-05 inventory the mock spec lists', () => {
    for (const mark of [
      'TACHIKOMA-RED',
      'UNIT TK-05 · RED CRAB VARIANT',
      'INTAKE · PASSIVE',
      'TK-05 · ONE OPERATOR',
      'DO NOT OPEN · SANDBOXED RENDERER',
      'LOCAL-FIRST · NO CLOUD REQUIRED · MIT',
      'S/N TK-05-0001',
      'ACOUSTIC 2W',
      '攻殻機動隊 · 公安九課',
      'KEYS',
    ]) {
      expect(src, `${mark} missing from the slab`).toContain(mark)
    }
    // The LED block's six named cells.
    for (const lamp of ['SERVO', 'OPTIC', 'LINK', 'GPU', 'NET', 'PWR']) {
      expect(src, `${lamp} lamp missing`).toContain(`'${lamp}'`)
    }
  })

  it('prints the LINK host:port through the pure helper (real port when there is one)', () => {
    expect(src).toContain('chassisLinkLabel')
    expect(src).toContain('apiServer')
  })

  it('never uses filter: drop-shadow (it would ghost the legend text)', () => {
    expect(src).not.toContain('drop-shadow')
    expect(src).not.toMatch(/\bfilter:/)
  })

  it('declares no cursor (globals.css owns the resize affordance)', () => {
    expect(src).not.toMatch(/cursor/)
  })

  it('sits BELOW the app plate so nothing paints over content', () => {
    expect(src).toMatch(/zIndex:\s*0/)
    // globals.css lifts .app-body to 5 — anything higher here would cover it.
    expect(src).not.toMatch(/zIndex:\s*[1-9]/)
  })

  it('kills its own motion under reduced motion', () => {
    expect(src).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(src).toMatch(/\.tk-chassis \*\s*\{\s*animation:\s*none\s*!important/)
  })

  it('draws the geometry in CSS only — no bitmap, no SVG', () => {
    expect(src).not.toMatch(/\.png|\.jpg|\.webp|<svg|url\(/)
    expect(src).toContain('clipPath')
    expect(src).toContain('gradient(')
  })

  it('ships every piece of hardware the spec asks for', () => {
    for (const piece of [
      'Vents', 'Grille', 'LedRack', 'WindowKeys', 'Bolt',
      'NamePlate', 'IntakeStrip', 'LedBlock', 'StatusBlock', 'Marking', 'Wheel',
    ]) {
      expect(src, `${piece} missing`).toContain(`function ${piece}(`)
    }
  })

  it('reads theme store + window state and tears the attribute down', () => {
    expect(src).toContain('useThemeStore')
    expect(src).toContain('useWindowState')
    expect(src).toContain("root.setAttribute('data-chassis'")
    expect(src).toContain("root.removeAttribute('data-chassis')")
    expect(src).toContain("root.style.setProperty('--chassis-inset-x'")
    // THE SLAB IS VERTICALLY SYMMETRIC and stamps `by` into BOTH vertical
    // properties. The recess rule took one `--chassis-inset-y` for the pair
    // until the OPUS-5 rim needed a 30px header over a 24px hint bar; splitting
    // it there means stamping both here, or an unset `--chassis-inset-bottom`
    // falls back to the rule's narrow default and un-recesses the slab's foot.
    expect(src).toContain("root.style.setProperty('--chassis-inset-top', `${by}px`)")
    expect(src).toContain("root.style.setProperty('--chassis-inset-bottom', `${by}px`)")
    expect(src).toContain("root.style.removeProperty('--chassis-inset-top')")
    expect(src).toContain("root.style.removeProperty('--chassis-inset-bottom')")
    expect(src).not.toContain('--chassis-inset-y')
  })

  it('adds no translatable copy (the legends are model/serial/unit marks)', () => {
    // Deliberate: decorative silkscreen stays out of the 8-locale contract, so
    // there is no i18n call here and no English sentence to translate.
    expect(src).not.toContain('useTranslation')
    expect(src).not.toMatch(/\bt\(/)
  })
})

describe('App.tsx mounts the chassis frames', () => {
  const src = stripComments(read('app/App.tsx'))
  it('imports and renders it once', () => {
    expect(src).toContain("import { TachikomaChrome } from '../components/TachikomaChrome'")
    expect((src.match(/<TachikomaChrome\s*\/>/g) ?? []).length).toBe(1)
  })
  it('no longer mounts the retired crab chrome', () => {
    // The component was deleted with the theme (2026-07-26). A stale mount would
    // be a hard import error, but the assertion documents the intent.
    expect(src).not.toContain('CrabChrome')
  })
  it('mounts the OPUS-5 frame beside it, once', () => {
    expect(src).toContain("import { OpusChrome } from '../components/OpusChrome'")
    expect((src.match(/<OpusChrome\s*\/>/g) ?? []).length).toBe(1)
  })
})

// ── Chassis structure-layer rules ───────────────────────────────────────────
// The in-app half of the mocks: a hazard-framed permission card, notched
// SEND/RUN keys, LED-laddered context badge, stamped tool-family chips. Each one
// needs a STABLE hook on the component — never an nth-child chain — and none of
// them may reintroduce the two defects the theme layer has shipped before
// (alpha-tracing drop-shadow on text, clip-path over interactive descendants).
describe('chassis structure sheets (the in-app details)', () => {
  const THEMES = path.resolve(__dirname, '../../src/themes')
  const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
  const tk = stripCss(fs.readFileSync(path.join(THEMES, 'tachikoma-red-structure.css'), 'utf8'))
  const opus = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))

  /** The declaration block of the first rule whose selector matches. */
  const ruleBody = (css: string, needle: string): string => {
    for (const block of css.split('}')) {
      const i = block.indexOf('{')
      if (i !== -1 && block.slice(0, i).includes(needle)) return block.slice(i + 1)
    }
    return ''
  }

  it('hooks every new rule on a stable data attribute, never a positional chain', () => {
    for (const [name, css] of [['tachikoma-red', tk], ['tachi-opus5', opus]] as const) {
      expect(css, `${name} lost its send-key rule`).toContain('[data-send-key]')
      expect(css, `${name} lost its tool-chip rule`).toContain('[data-tool-family]')
      // Positional selectors break the moment a component reorders a child.
      expect(css, `${name} uses nth-child`).not.toContain(':nth-child')
      expect(css, `${name} uses nth-of-type`).not.toContain(':nth-of-type')
    }
    expect(tk).toContain('[data-permission-card]')
    expect(opus).toContain('[data-ctx-meter]')
  })

  it('scopes every new rule to its own theme', () => {
    for (const hook of ['[data-send-key]', '[data-tool-family]', '[data-permission-card]']) {
      const idx = tk.indexOf(hook)
      if (idx < 0) continue
      const selectorStart = tk.lastIndexOf('}', idx) + 1
      expect(tk.slice(selectorStart, idx)).toContain(':root[data-theme="tachikoma-red"]')
    }
    for (const hook of ['[data-send-key]', '[data-tool-family]', '[data-ctx-meter]', '[data-chassis]']) {
      const idx = opus.indexOf(hook)
      if (idx < 0) continue
      const selectorStart = opus.lastIndexOf('}', idx) + 1
      expect(opus.slice(selectorStart, idx)).toContain(':root[data-theme="tachi-opus5"]')
    }
  })

  it('never clips the permission card (clip-path clips descendants — ALLOW is one)', () => {
    const body = ruleBody(tk, '[data-permission-card]')
    expect(body).not.toContain('clip-path')
    expect(body).not.toContain('drop-shadow')
    // The hazard flash needs !important: the component sets `background`
    // inline as a shorthand, which resets background-image.
    expect(body).toMatch(/background-image:[\s\S]*!important/)
  })

  it('cuts the SEND/RUN key with geometry only (the rim rides the inherited shadow)', () => {
    for (const css of [tk, opus]) {
      const body = ruleBody(css, '[data-send-key]')
      expect(body).toContain('clip-path')
      // A border/box-shadow here would be sheared off by the cut, and would need
      // !important to beat the component's inline `border` shorthand.
      expect(body).not.toContain('box-shadow')
      expect(body).not.toContain('drop-shadow')
    }
  })

  it('gives the context badge an LED ladder without tracing its digits', () => {
    const body = ruleBody(opus, '[data-ctx-meter]')
    expect(body).toContain('repeating-linear-gradient')
    expect(body).not.toContain('drop-shadow')
    expect(body).not.toContain('clip-path')  // it is a live button; keep the hit box square
  })

  it('stamps the tool-family chips in both themes', () => {
    for (const css of [tk, opus]) {
      const body = ruleBody(css, '[data-tool-family]')
      expect(body).toContain('clip-path')
      expect(body).not.toContain('drop-shadow')
    }
  })

  it('recolours the OPUS-5 recess without re-declaring its geometry', () => {
    const body = ruleBody(opus, '[data-chassis] .app-body')
    expect(body).toContain('border-color')
    expect(body).toContain('box-shadow')
    // globals.css owns position/inset/z-index; a theme sheet must not fork them.
    for (const banned of ['position:', 'inset:', 'z-index:', 'drop-shadow']) {
      expect(body, `${banned} belongs to globals.css`).not.toContain(banned)
    }
  })

  it('keeps the hooks present in the components that must carry them', () => {
    const hooks: Array<[string, string]> = [
      ['pages/agent/PermissionCard.tsx', 'data-permission-card'],
      ['pages/agent/ToolCallBlock.tsx', 'data-tool-family'],
      ['components/ContextMeter.tsx', 'data-ctx-meter'],
      ['pages/chat/InputBar.tsx', 'data-send-key'],
      ['pages/agent/AgentPage.tsx', 'data-send-key'],
    ]
    for (const [file, attr] of hooks) {
      expect(read(file), `${file} lost ${attr}`).toContain(attr)
    }
  })
})

// ── Sidebar panel ───────────────────────────────────────────────────────────
describe('ChassisSidebarPanel (the in-app telemetry / chassis map)', () => {
  const src = stripComments(read('components/ChassisSidebarPanel.tsx'))

  it('renders nothing on any other theme', () => {
    expect(src).toMatch(/return null/)
    expect(src).toContain('TK_THEME')
    expect(src).toContain('OPUS_THEME')
  })

  it('reads CTX from a real store value, against the routed model\'s own window', () => {
    expect(src).toContain('useAgentStore')
    // Not a per-provider constant: the denominator is what the provider
    // published for the model this session routes to (2026-08-02).
    expect(src).toContain('useAgentContextWindow')
    expect(src).not.toContain('DEFAULT_MAX_TOKENS')
  })

  // ── THE HONESTY LAW (2026-07-27) ──────────────────────────────────────────
  // v1 of this panel drew SERVO 62 and OPTIC 84: two invented needles behind a
  // "decorative chassis readout" tooltip. The owner's verdict was that a
  // disclaimer nobody hovers does not make a fake instrument honest — an
  // element that LOOKS like a measurement must BE one or not exist. These
  // three tests are that law: no literal gauge value, no surviving disclaimer,
  // and an omit-don't-fake branch on every source that can fail to answer.
  it('feeds every gauge from an expression, never a literal needle position', () => {
    // `pct={62}` is the exact shape of the defect. A percentage may only ever
    // arrive from a computed value.
    expect(src).not.toMatch(/pct=\{\s*\d/)
  })

  it('carries no "decorative readout" escape hatch any more', () => {
    expect(src.toLowerCase()).not.toContain('decorative')
    // Nor the retired needle names, which named nothing this app has.
    expect(src).not.toContain('"SERVO"')
    expect(src).not.toContain('"OPTIC"')
  })

  it('omits a row it cannot measure instead of zeroing it', () => {
    // MEM: `performance.memory` is a Chromium extra — absent host → no row and
    // no poll timer.
    expect(src).toContain('performance')
    expect(src).toMatch(/heapPct\s*!==\s*null/)
    // SPEND: no budget cap → no denominator → no row.
    expect(src).toMatch(/spend\s*!==\s*null/)
    expect(src).toMatch(/cap\s*>\s*0/)
  })

  it('makes the CHASSIS MAP cells real controls, not lamps', () => {
    // Buttons, wired to the router — the map is a three-slot switcher.
    expect(src).toContain('useNavigate')
    expect(src).toContain('navigate(target)')
    expect(src).toContain('aria-pressed')
    expect(src).toContain('type="button"')
    // The lit cell stays ROUTE-derived: OpusChrome's flank stencils call the
    // same helper, and a focus-derived map would contradict the frame.
    expect(src).toContain('opusActiveBay')
  })

  it('declares no RESIZE cursor (globals.css owns the resize affordance)', () => {
    // Narrowed from "no cursor at all" when the map cells became buttons: a
    // control that does not show a pointer is a worse control. The law that
    // actually matters is that nothing here forks the resize affordance.
    expect(src).not.toMatch(/col-resize|row-resize|ew-resize|ns-resize/)
  })

  it('never drop-shadows (the panel is all 8px text)', () => {
    expect(src).not.toContain('drop-shadow')
  })

  // ── THE IDLE GATE (batch30d) ──────────────────────────────────────────────
  // This panel is ALWAYS MOUNTED under the TK theme — it lives in the sidebar
  // footer, so its hand-rolled 2s timer outlived every route change and kept
  // re-rendering a MINIMISED window twice a second, forever.
  it('polls the heap through the shared visibility-gated hook, not a raw timer', () => {
    expect(src).toContain('useVisibilityGatedInterval')
    expect(src).not.toContain('setInterval')
    expect(src).not.toContain('clearInterval')
  })

  it('keeps the no-API guard EXACTLY: no measurable heap → no timer is armed', () => {
    // The hook's `intervalMs: null` mode arms nothing at all — not even its
    // mount tick. Support is decided ONCE, from a state initialiser: deriving
    // it from the reading would disarm the poll the first time one came back
    // null and never re-arm it.
    expect(src).toMatch(/supported \? HEAP_POLL_MS : null/)
    expect(src).toMatch(/useState\(\(\) => readHeapPct\(\) !== null\)/)
  })

  it('is mounted from the sidebar, not floated over it', () => {
    const sidebar = stripComments(read('components/layout/Sidebar.tsx'))
    expect(sidebar).toContain("import { ChassisSidebarPanel } from '../ChassisSidebarPanel'")
    expect((sidebar.match(/<ChassisSidebarPanel\s*\/>/g) ?? []).length).toBe(1)
    expect(src).not.toContain("position: 'fixed'")
  })
})

// ── globals.css contract ────────────────────────────────────────────────────
describe('globals.css [data-chassis] block', () => {
  const css = stripComments(read('globals.css'))

  it('insets the plate from the three chassis custom properties', () => {
    // Three-value `inset` is top / horizontal / bottom (margin's shorthand
    // order). The vertical axis is TWO properties because the OPUS-5 rim is not
    // vertically symmetric — a 30px header rail over a 24px hint bar — and one
    // `--chassis-inset-y` made every chassis symmetric by construction. This
    // frame stamps the same number into both, so nothing about it moved.
    expect(css).toMatch(
      /:root\[data-chassis\]\s+\.app-body\s*\{[^}]*inset:\s*var\(--chassis-inset-top,[^)]*\)\s*var\(--chassis-inset-x,[^)]*\)\s*var\(--chassis-inset-bottom,[^)]*\)/,
    )
    // The retired single property must not survive anywhere in the sheet: a
    // stale reader would resolve to nothing and full-bleed that edge.
    expect(css).not.toContain('--chassis-inset-y')
  })

  it('is value-agnostic — every stage is a live chassis', () => {
    // A `[data-chassis="inset"]`-style rule would silently drop the other three
    // stages back to full-bleed.
    expect(css).toContain(':root[data-chassis] .app-body')
    expect(css).not.toContain('[data-chassis="')
  })

  it('lifts the plate above the chassis layers', () => {
    const block = css.split(':root[data-chassis] .app-body')[1] ?? ''
    expect(block.slice(0, block.indexOf('}'))).toMatch(/z-index:\s*5/)
  })

  it('sinks the plate with box-shadow, never filter: drop-shadow', () => {
    const block = (css.split(':root[data-chassis] .app-body')[1] ?? '')
    const body = block.slice(0, block.indexOf('}'))
    expect(body).toContain('box-shadow:')
    expect(body).not.toContain('drop-shadow')
  })

  it('NEVER collapses the chassis in a media query', () => {
    // The retired crab plate had exactly such a rule (it hid its claw art below
    // 1180px and took the gutter with it, erasing the theme at the owner's
    // ~1068px daily width). Copying that here would delete the chassis at the
    // same width — the whole defect this component was written to avoid. The
    // sweep is over EVERY media block, not just max-width ones, because with the
    // crab rule gone globals.css may legitimately carry no width query at all.
    for (const b of mediaBlocks(css)) {
      expect(b.body, `${b.query} touches data-chassis`).not.toContain('data-chassis')
    }
  })

  it('makes the body and #root transparent so the slab shows through', () => {
    expect(css).toMatch(/:root\[data-chassis\]\s+body\s*\{[^}]*background:\s*transparent\s*!important/)
    expect(css).toMatch(/:root\[data-chassis\]\s+#root\s*\{[^}]*background:\s*transparent/)
  })

  it('carries no leftover of the retired crab plate', () => {
    // Half a deleted mechanism is worse than none: `data-crab-overflow` is
    // stamped by nothing now, so any surviving rule is dead weight that reads
    // as live code.
    expect(css).not.toContain('data-crab-overflow')
    expect(css).not.toContain('--crab-inset')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SLAB — variant 2a: ONE continuous machined body
// ═══════════════════════════════════════════════════════════════════════════
//
// Added when the four-bars-around-a-hole frame was replaced by the mock's slab
// system (`Tachi OPUS-5.dc.html`, the `.tkred .slab*` block + the 2a frame):
// five stacked clips and a raking key light, all sharing ONE clip-path polygon,
// with the hardware milled out of the same plate.
//
// Nothing above this line was deleted. Everything above still describes laws the
// slab obeys unchanged — restage-never-hide, the key interlock, pointer-events,
// no drop-shadow, no cursor, z-index 0 — which is the point: the frame changed,
// the contract did not.

/** Ray casting. The silhouette is concave (port bays, foot gaps, the mandible
 *  step), so "is the plate inside the body" cannot be answered with a bounding
 *  box — it needs the real winding test. */
function inPolygon(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

describe('chassisSlabInsets (five stacked clips = a machined chamfer)', () => {
  it('reproduces the mock literal 5 / 7 / 20 / 21 at its own 62px rail', () => {
    expect(chassisSlabInsets(62)).toEqual({ lip: 5, face: 7, seam: 20, inner: 21 })
  })

  it('keeps the bands in order at every rail — the seam is always 1px', () => {
    for (const y of [8, 10, 14, 24, 34, 46, 62, 80, 200]) {
      const s = chassisSlabInsets(y)
      expect(s.lip, `lip @ ${y}`).toBeGreaterThan(0)
      expect(s.face, `face @ ${y}`).toBeGreaterThan(s.lip)
      expect(s.seam, `seam @ ${y}`).toBeGreaterThan(s.face)
      expect(s.inner - s.seam, `parting line @ ${y}`).toBe(1)
    }
  })

  it('never sinks the parting line under the app plate', () => {
    // The seam is the whole point of the stack: if `inner` reached the bezel the
    // plate would cover it and the body would read as one flat fill again.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = chassisBezel(stage, vp)
        expect(chassisSlabInsets(b.y).inner, `${stage} @ ${vp.height}`).toBeLessThan(b.y)
      }
    }
  })
})

describe('chassisSlabPolygon (the ONE silhouette every layer shares)', () => {
  it('transcribes the mock cut depths at the mock own size', () => {
    // 1428×932 shell, bezels 56/62/92/70 — the numbers the mock states. The
    // positions are the mock's fractions; these are the DEPTHS, derived from the
    // bezel, and they land on the mock's own values.
    const { cuts } = chassisSlabPolygon({
      width: TK_MOCK_W, height: TK_MOCK_H, bezel: { x: 92, y: 62 },
    })
    expect(cuts.chamfer).toBe(72)          // 0,72 → 72,0
    expect(cuts.tray?.depth).toBe(15)      // 490,15 → 800,15
    expect(cuts.mandible?.depth).toBe(22)  // 1150,22 → 1186,22
    expect(cuts.rightBay?.depth).toBe(30)  // 1428,240 → 1398,268
    expect(cuts.leftBay?.depth).toBe(30)   // 0,566 → 30,538
    expect(cuts.foot).toBe(40)             // 1120,932 → 1098,892
  })

  it('mills every feature the 2a frame lists', () => {
    const { cuts, points } = chassisSlabPolygon({
      width: 1400, height: 900, bezel: TK_BEZEL.wide,
    })
    expect(cuts.tray, 'intake tray').not.toBeNull()
    expect(cuts.mandible, 'mandible step').not.toBeNull()
    expect(cuts.rightBay, 'right port bay').not.toBeNull()
    expect(cuts.leftBay, 'left port bay').not.toBeNull()
    expect(cuts.shearBl.x).toBeGreaterThan(0)
    expect(cuts.shearBr.x).toBeGreaterThan(0)
    // Chamfer + tray + mandible + bay + 2 shears + 2 feet + bay ≈ the mock's 31.
    expect(points.length).toBeGreaterThanOrEqual(28)
  })

  it('NEVER cuts into the screen — at every stage, on every viewport', () => {
    // The one law that makes a derived polygon safe. A cut deeper than the bezel
    // would bite a notch out of the app plate itself (the plate is opaque and
    // z-index 5, so the visible result is a slab with a hole beside the UI).
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        const { points } = chassisSlabPolygon({ width: vp.width, height: vp.height, bezel })
        const L = bezel.x, T = bezel.y, R = vp.width - bezel.x, B = vp.height - bezel.y
        const where = `${stage} @ ${vp.width}x${vp.height}`

        // 1. No vertex lands inside the plate's rectangle.
        for (const [x, y] of points) {
          const inside = x > L && x < R && y > T && y < B
          expect(inside, `${where}: vertex ${x},${y} is inside the screen`).toBe(false)
        }
        // 2. The plate's own corners, edges and centre are all ON the body.
        const probes: Array<[number, number]> = [
          [L, T], [R, T], [L, B], [R, B],
          [(L + R) / 2, T], [(L + R) / 2, B], [L, (T + B) / 2], [R, (T + B) / 2],
          [(L + R) / 2, (T + B) / 2],
        ]
        for (const [x, y] of probes) {
          expect(inPolygon(points, x, y), `${where}: ${x},${y} fell through the body`).toBe(true)
        }
      }
    }
  })

  it('keeps every vertex inside the viewport box', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        const { points } = chassisSlabPolygon({ width: vp.width, height: vp.height, bezel })
        for (const [x, y] of points) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(vp.width)
          expect(y).toBeLessThanOrEqual(vp.height)
        }
      }
    }
  })

  it('emits whole pixels and a well-formed clip-path', () => {
    const { points, path } = chassisSlabPolygon({ width: 1281, height: 799, bezel: TK_BEZEL.mid })
    for (const [x, y] of points) {
      expect(Number.isInteger(x)).toBe(true)
      expect(Number.isInteger(y)).toBe(true)
    }
    expect(path.startsWith('polygon(')).toBe(true)
    expect(path.endsWith(')')).toBe(true)
    expect(path.split(',').length).toBe(points.length)
  })

  it('survives a degenerate viewport without folding inside out', () => {
    // chassisStage is total, so the polygon must be too: a tiny window drops the
    // features whose spans collapsed rather than emitting inverted vertex pairs.
    for (const vp of [{ width: 320, height: 200 }, { width: 120, height: 90 }]) {
      const bezel = chassisBezel('narrow', vp)
      const { points } = chassisSlabPolygon({ width: vp.width, height: vp.height, bezel })
      expect(points.length).toBeGreaterThanOrEqual(6)
      expect(inPolygon(points, vp.width / 2, vp.height / 2)).toBe(true)
    }
  })
})

// ── Drag regions ─────────────────────────────────────────────────────────────
// New in this batch: no chassis element carried `-webkit-app-region` at all, so
// the only way to move the window was the TitleBar INSIDE the recessed plate.
describe('chassisDragBandPx (grab the chassis, keep the resize edge)', () => {
  it('leaves the Windows sizing border alone', () => {
    expect(TK_RESIZE_EDGE_PX).toBeGreaterThanOrEqual(6)
    expect(TK_RESIZE_EDGE_PX).toBeLessThanOrEqual(8)
  })
  it('never lets a band reach the window edge', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = chassisBezel(stage, vp)
        for (const side of [b.x, b.y]) {
          expect(chassisDragBandPx(side)).toBeGreaterThanOrEqual(0)
          // The band plus the resize strip is exactly the rail — no overhang
          // onto the app plate, no gap where neither works.
          expect(chassisDragBandPx(side)).toBe(Math.max(0, side - TK_RESIZE_EDGE_PX))
        }
      }
    }
  })
  it('still gives the widest stage a real grab target', () => {
    expect(chassisDragBandPx(TK_BEZEL.wide.y)).toBeGreaterThan(20)
    expect(chassisDragBandPx(TK_BEZEL.wide.x)).toBeGreaterThan(20)
  })
})

// ── THE SLAB MATERIAL, PARSED ───────────────────────────────────────────────
// The texture pass turned `SLAB_MATERIAL` from six one-line fills into a real
// finish (brush, machining twill, pressing seams, oxide patina, field wear, an
// oil-slick film). Eyeballing a wall of gradient strings proves nothing, so the
// guards below COMPUTE from them: the layer parser reassembles each face's
// background-image list exactly as the browser will see it, and the colour
// maths is the same sRGB/WCAG pair opusChrome.test.ts uses.
//
// The one thing worth understanding before reading the assertions: on this
// chassis the ink is LIGHTER than the metal (`--text-dim` #8d7b81 on a body
// that runs #0e080a…#271419), so every DARK stop in the texture RAISES legend
// contrast and every LIGHT stop lowers it. "Is the metal richer" and "can you
// still read the silkscreen" are therefore the same measurement.
const MATERIAL_SRC = (() => {
  const src = stripComments(read('components/TachikomaChrome.tsx'))
  const start = src.indexOf('const SLAB_MATERIAL')
  if (start < 0) throw new Error('SLAB_MATERIAL is gone from TachikomaChrome.tsx')
  return src.slice(start, src.indexOf('} as const', start))
})()

/** Every face → its background-image list, rebuilt from the source literals.
 *  A literal that OPENS a gradient (or is a bare hex fill) starts a new image;
 *  anything else is a continuation of the one before it, which is how the
 *  component splits its two longest gradients across lines. The `.join(',')` /
 *  `.join('')` argument literals are skipped — they are punctuation. */
const MATERIAL_LAYERS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {}
  let key = ''
  for (const line of MATERIAL_SRC.split('\n')) {
    const k = /^ {2}([a-z]+):/.exec(line)
    if (k) { key = k[1]; out[key] = [] }
    if (!key) continue
    for (const m of line.matchAll(/'([^']*)'/g)) {
      const piece = m[1]
      if (piece === '' || piece === ',') continue
      if (/^(#[0-9a-f]{6}$|(repeating-)?(linear|radial)-gradient\()/i.test(piece)) out[key].push(piece)
      else if (out[key].length) out[key][out[key].length - 1] += piece
      else throw new Error(`orphan material fragment on ${key}: ${piece}`)
    }
  }
  return out
})()

type Ink = [number, number, number, number]
type Rgb = [number, number, number]

/** Every colour a chunk of CSS names, as [r,g,b,a] — `rgba()`, `rgb()` and
 *  6-digit hex alike, so a guard cannot be dodged by changing notation. */
const inksOf = (css: string): Ink[] => {
  const out: Ink[] = []
  for (const m of css.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)) {
    out.push([+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]])
  }
  for (const m of css.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const n = parseInt(m[1], 16)
    out.push([(n >> 16) & 255, (n >> 8) & 255, n & 255, 1])
  }
  return out
}
const MATERIAL_INKS = inksOf(Object.values(MATERIAL_LAYERS).flat().join(','))

const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminanceOf = ([r, g, b]: Rgb) =>
  0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255)
const contrastRgb = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}
/** Source-over: one ink laid on one bed, the compositing the GPU will do. */
const over = (bed: Rgb, ink: Ink): Rgb =>
  [0, 1, 2].map(i => bed[i] + (ink[i] - bed[i]) * ink[3]) as Rgb

/** The 8px silkscreen ink, resolved from the palette so a theme edit fails HERE
 *  and not in a screenshot of an unreadable serial plate. */
const TEXT_DIM: Rgb = (() => {
  const decl = /--text-dim:\s*#([0-9a-f]{6})/i.exec(read('themes/tachikoma-red.css'))
  if (!decl) throw new Error('--text-dim is not a plain hex in tachikoma-red.css')
  const n = parseInt(decl[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
})()

/** The lightest OPAQUE stop in a face's stack — i.e. the worst bed the legend
 *  ink ever gets from the body fill itself, before any wash lands on it. */
const brightestStop = (images: string[]): Rgb => {
  const opaque = images.flatMap(inksOf).filter(i => i[3] === 1)
  if (!opaque.length) throw new Error('no opaque stop in the face')
  return opaque.map(i => [i[0], i[1], i[2]] as Rgb)
    .sort((a, b) => luminanceOf(b) - luminanceOf(a))[0]
}

/** The ink in one gradient that brightens the most (alpha × luminance). */
const brightestInk = (image: string): Ink =>
  inksOf(image).sort((a, b) =>
    b[3] * luminanceOf([b[0], b[1], b[2]]) - a[3] * luminanceOf([a[0], a[1], a[2]]))[0]

/** Repeat period of a `repeating-*-gradient`, in px: its last stop boundary. */
const gradientPeriodPx = (image: string): number =>
  Math.max(...[...image.matchAll(/([\d.]+)px/g)].map(m => +m[1]))

/** What the eye actually sees where the detail is sub-pixel: each repeating
 *  gradient integrated over ITS OWN period, so a 0.5px crest inside a 3px
 *  period contributes a sixth of its alpha and not all of it. Modelling those
 *  hairlines at full strength (the naive "assume every layer coincides" stack)
 *  is not conservative, it is simply the wrong surface — it describes a pixel
 *  that no gradient in the set can produce. */
const fieldMean = (images: string[], bed: Rgb): Rgb => {
  let out = bed
  for (const image of images) {
    if (!image.startsWith('repeating-')) continue
    const period = gradientPeriodPx(image)
    for (const m of image.matchAll(/(rgba?\([^)]*\))\s+([\d.]+)px\s+([\d.]+)px/g)) {
      const ink = inksOf(m[1])[0]
      const duty = (+m[3] - +m[2]) / period
      out = over(out, [ink[0], ink[1], ink[2], ink[3] * duty])
    }
  }
  return out
}

describe('TachikomaChrome.tsx (the SLAB composition)', () => {
  const src = stripComments(read('components/TachikomaChrome.tsx'))

  it('stacks the mock five clips plus the wear pass and the raking key light', () => {
    for (const layer of ['edge', 'lip', 'face', 'seam', 'inner', 'grain', 'spec']) {
      expect(src, `slab ${layer} missing`).toMatch(new RegExp(`SLAB_MATERIAL\\.${layer}\\b`))
    }
  })

  it('gives every layer the SAME polygon, built once', () => {
    // One call, one const, seven spreads. Seven independently-computed polygons
    // would drift by a pixel and the chamfer would fringe.
    expect((src.match(/chassisSlabPolygon\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/const clip = \{ clipPath: slab\.path \}/)
    expect((src.match(/\.\.\.clip\b/g) ?? []).length).toBe(7)
  })

  it('keeps the slab layers CHILDLESS (clip-path clips descendants)', () => {
    // A hardware child inside a layer would be sheared by the silhouette; a
    // fixed one (the keys) would be clipped even though it escapes the
    // containing block. Every layer is therefore a self-closing leaf.
    const leaves = src.match(/<div style=\{\{ \.\.\.LAYER, \.\.\.clip,[^>]*\/>/g) ?? []
    expect(leaves.length).toBe(7)
  })

  it('rides the wear pass on the SAME inset as the face it wears', () => {
    // `grain` is the service history of the `inner` facet, not a sixth facet.
    // Given it its own inset it would cut a visible step where the scratches
    // start — and the chamfer would read as six bands, which is not the mock.
    expect((src.match(/inset: ins\.inner\b/g) ?? []).length).toBe(2)
    // Five insets, seven layers: spec doubles up on edge (inset 0) too.
    for (const facet of ['ins.lip', 'ins.face', 'ins.seam']) {
      expect((src.match(new RegExp(`inset: ${facet.replace('.', '\\.')}\\b`, 'g')) ?? []).length).toBe(1)
    }
  })

  it('honours the CYAN RESTRAINT — no optic ink in the body material', () => {
    // Written in the mock beside the polygon: "The cyan is NOT allowed on the
    // chassis — it is reserved for the optic, the live LEDs and the screen.
    // That restraint is the difference between a product and a poster."
    for (const optic of ['00e5ff', '0,229,255', '0, 229, 255', 'accent-alt']) {
      expect(MATERIAL_SRC, `${optic} leaked onto the chassis body`).not.toContain(optic)
    }
    // …and the lamps still have it, so this is a restraint and not a deletion.
    expect(src).toContain('accent-alt')
  })

  it('carries no COOL-CAST ink at all, which is the real teal signature', () => {
    // The literal-string guard above only catches the one hex the mock used. The
    // texture pass added ~40 new inks (brush crests, scratch burrs, an oil-slick
    // sheen), so the restraint is restated as the property it actually means:
    // teal is blue AND green above red. The sheen's violet stop is allowed
    // precisely because its green is BELOW its red — it is a clear coat, not a
    // lamp. This is what stops a future "a bit of cool in the metal" edit from
    // walking the chassis back to a poster one commit at a time.
    for (const ink of MATERIAL_INKS) {
      const [r, g, b] = ink
      expect(!(b > r && g > r), `cool-cast ink rgba(${ink.join(',')}) on the chassis`).toBe(true)
    }
    // …and it really did find some inks to check.
    expect(MATERIAL_INKS.length).toBeGreaterThan(30)
  })

  it('keeps every face inside the SIX background-image budget', () => {
    // Past six the raster cost shows on a resize drag, and the silhouette
    // already re-rasters every frame (the polygon is a function of the
    // viewport). One image per top-level comma group.
    for (const [name, images] of Object.entries(MATERIAL_LAYERS)) {
      expect(images.length, `slab ${name} has ${images.length} background-images`)
        .toBeLessThanOrEqual(6)
    }
    // The big machined face and its wear pass are the two that spend the budget.
    expect(MATERIAL_LAYERS.inner.length).toBe(6)
    expect(MATERIAL_LAYERS.grain.length).toBe(6)
  })

  it('paints the finish with gradients only — no bitmap, no blend, no promotion', () => {
    // Rule 6 of the header. A blend mode or an opacity on a texture layer would
    // promote it to its own composited layer, and `mix-blend-mode`/`opacity`
    // also create containing blocks for the fixed window keys on some engines —
    // the same trap the file bans `filter` for.
    for (const banned of ['mix-blend-mode', 'mixBlendMode', 'backdrop-filter',
      'backdropFilter', 'opacity:', 'transform:', 'maskImage', 'mask-image']) {
      expect(MATERIAL_SRC, `${banned} in the slab material`).not.toContain(banned)
    }
    // Every image is a gradient or a flat fill — the lip is a shadow and the
    // seam is a parting line, and neither wants a texture in it.
    for (const image of Object.values(MATERIAL_LAYERS).flat()) {
      expect(image, `${image} is neither a gradient nor a flat fill`)
        .toMatch(/^(#[0-9a-f]{6}$|(repeating-)?(linear|radial)-gradient\()/i)
    }
    expect(MATERIAL_LAYERS.lip).toEqual(['#050303'])
    expect(MATERIAL_LAYERS.seam).toEqual(['#63404b'])
  })

  it('gives the metal a GRAIN, not one smooth ramp per facet', () => {
    // The defect this replaces: at the wide stage the bezel is 116px of a single
    // `linear-gradient`, which has no scale and therefore reads as maroon
    // plastic. Every facet the eye can actually resolve now carries brushing.
    for (const facet of ['edge', 'face', 'inner', 'grain'] as const) {
      const repeating = MATERIAL_LAYERS[facet].filter(i => i.startsWith('repeating-'))
      expect(repeating.length, `slab ${facet} has no micro-detail`).toBeGreaterThan(0)
    }
    // The brush is anisotropic: the two co-linear frequencies on the big face
    // must differ, or their interference (the thing that reads as brushing
    // rather than as a printed screen) does not exist.
    const periods = MATERIAL_LAYERS.inner
      .filter(i => i.includes('163deg') && i.startsWith('repeating-'))
      .map(gradientPeriodPx)
    expect(periods.length).toBe(2)
    expect(periods[0]).not.toBe(periods[1])
    // …and the twill crosses the grain instead of running with it.
    expect(MATERIAL_LAYERS.inner.some(i => i.includes('118deg'))).toBe(true)
  })

  it('keeps the grain NET-DARKENING, so the 8px silkscreen gains contrast', () => {
    // THE CONTRAST LAW for this lane. `--text-dim` legends (INTAKE · PASSIVE,
    // the six lamp names, the unit marking, the whole bottom status block) are
    // printed straight onto the `inner` face, and the ink is LIGHTER than the
    // metal — so a groove RAISES their contrast and a crest LOWERS it. The added
    // finish therefore has to be darker on average than the fill it replaced,
    // which is checked here by integrating each repeating gradient over its own
    // period (the correct model for sub-pixel detail: at 1x the eye sees the
    // duty-cycle mean, not the individual stops).
    const bare = brightestStop(MATERIAL_LAYERS.inner)
    const dressed = fieldMean([...MATERIAL_LAYERS.inner, ...MATERIAL_LAYERS.grain], bare)
    expect(luminanceOf(dressed)).toBeLessThan(luminanceOf(bare))
    // Every legend bed is therefore at least as legible as it was before the
    // texture landed — and this is the pleasing part: the theme's "5.0:1" for
    // this ink is measured on --bg-base (#0a0708), while the lightest stop of
    // the slab face is lighter than that, so the FLAT fill shipped its worst
    // legend bed BELOW AA at 4.40:1. Cutting a grain into it takes that same
    // bed to 4.54:1. The finish did not have to be paid for in legibility; it
    // paid for some.
    expect(contrastRgb(TEXT_DIM, dressed)).toBeGreaterThan(contrastRgb(TEXT_DIM, bare))
    expect(contrastRgb(TEXT_DIM, bare)).toBeLessThan(4.5)
    expect(contrastRgb(TEXT_DIM, dressed)).toBeGreaterThanOrEqual(4.5)
  })

  it('never lets the BROAD washes bury a legend, even where they all pile up', () => {
    // The duty-cycle mean above is the right model for the hairlines but not for
    // the washes that cover whole regions: the mock's raking key light (0.085 at
    // its top-left origin), the new oil-slick sheen and the rubbed-bright
    // chamfer corner all peak in the SAME corner. Stack all three on the
    // brightest stop of the face — the true worst pixel on the unit — and the
    // legend ink must still clear the 3:1 non-text floor.
    // (No bare legend actually sits there: the name plate that occupies that
    // corner prints on its own milled #0c0708 pocket. This is the margin, not
    // the design point.)
    let bed = brightestStop(MATERIAL_LAYERS.inner)
    for (const wash of [...MATERIAL_LAYERS.grain, ...MATERIAL_LAYERS.spec]) {
      if (wash.startsWith('repeating-')) continue
      bed = over(bed, brightestInk(wash))
    }
    expect(contrastRgb(TEXT_DIM, bed)).toBeGreaterThanOrEqual(3)
    // …and no crest anywhere on a legend-bearing facet is brighter than the
    // white the mock's own key light already put on those pixels, so the
    // texture can never become the brightest thing on the chassis.
    for (const facet of ['inner', 'grain', 'spec'] as const) {
      for (const [r, g, b, a] of inksOf(MATERIAL_LAYERS[facet].join(','))) {
        if (r === 255 && g === 255 && b === 255) {
          expect(a, `white ${a} on slab ${facet} outshines the mock key light`)
            .toBeLessThanOrEqual(0.085)
        }
      }
    }
  })

  it('bolts the hardware onto the milled cut list — nothing floats', () => {
    // The intake louvres sit IN the tray the silhouette steps down for, and the
    // bottom flashes start where the shears end. Hardware that ignored the cuts
    // would hang over a corner the polygon had already removed.
    expect(src).toContain('cuts.tray')
    expect(src).toContain('cuts.chamfer')
    expect(src).toContain('cuts.shearBl')
    expect(src).toContain('cuts.shearBr')
  })

  it('makes the chassis the window grab handle, without eating the resize edge', () => {
    expect(src).toContain('WebkitAppRegion')
    expect(src).toMatch(/const DRAG[\s\S]{0,120}'drag'/)
    expect(src).toMatch(/const NO_DRAG[\s\S]{0,130}'no-drag'/)
    // Four bands: top rail, bottom rail, both flanks.
    expect((src.match(/\.\.\.DRAG\b/g) ?? []).length).toBe(4)
    // Every one of them starts TK_RESIZE_EDGE_PX in — a band on `inset: 0`
    // would make the window unresizable from three of its four edges.
    for (const band of src.match(/\.\.\.LAYER, \.\.\.DRAG,[^}]*/g) ?? []) {
      expect(band, `drag band without a resize strip: ${band}`).toContain('TK_RESIZE_EDGE_PX')
      expect(band).not.toMatch(/inset: 0/)
    }
  })

  it('opts every live control OUT of the drag region', () => {
    // A drag region swallows the click whole: a key inside one is a dead key.
    // The well and the cap fragment both carry it (the fragment is spread onto
    // all three buttons).
    expect((src.match(/\.\.\.NO_DRAG\b/g) ?? []).length).toBe(2)
    expect(src).toMatch(/\.\.\.LAYER, \.\.\.NO_DRAG, position: 'fixed'/)
    expect(src).toMatch(/const capStyle[^=]*=\s*\{\s*\.\.\.NO_DRAG/)
  })

  it('keeps the key interlock exactly as it was', () => {
    // Unchanged by the reframe, and pinned again here because the keys MOVED
    // (mock 2a carries them at the top of the right flank): the well is still a
    // sibling of the aria-hidden scenery, still three buttons, still the same
    // IPC, still the only hit-testable thing on the slab.
    expect((src.match(/<button/g) ?? []).length).toBe(3)
    expect((src.match(/pointerEvents:\s*'auto'/g) ?? []).length).toBe(1)
    expect(src).toContain('chassisKeySizePx')
    expect(src).toMatch(/\{has\('keys'\) && <WindowKeys/)
  })

  it('carries no trace of the old four-bars frame', () => {
    // The rails each had their own chamfer clip and their own wall lighting;
    // both are the slab's job now, and a leftover would double-light the seam.
    expect(src).not.toMatch(/const WALL\b/)
    expect(src).not.toContain('backgroundAttachment')
    expect(src).not.toContain('chassisChamferPx')
  })
})

// в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
// DRIVER-2 FINDINGS В· the bottom rail's two columns, and the flush-stage keys
//
// Both defects below were measured on the INSTALLED build against the mock
// renders, not reasoned about, so both guards are written against the mock's own
// numbers (the 2a frame of `Tachi OPUS-5.dc.html`, on its 1428Г—932 shell):
//
//   L316  vent      left 492, top 19, 306 Г— 11       (the intake louvres)
//   L340  grille    left 152, top 870, 128 Г— 44
//   L341  etch      ACOUSTIC 2W                      left 152, top 920
//   L342  hazard    left 286, top 870, 184 Г— 8
//   L343  etch      DO NOT OPEN В· SANDBOXED RENDERER left 286, top 884
//   L344  rule      left 286, top 902, 184 Г— 1
// в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
import {
  TK_GRILLE_W_F,
  TK_GRILLE_GAP_MIN_PX,
  TK_KEY_FINISH,
  chassisGrilleBand,
  chassisStatusLeftPx,
  chassisKeyFinish,
  chassisKeyWellPadPx,
} from '../../src/components/tachikoma/tachikomaChrome.helpers'

/** The wide stage's own window вЂ” the size driver-2 measured the build at. */
const MOCK_VP = { width: 1400, height: 900 }
/** вЂ¦and the scale the mock's 1428px numbers land at inside it. */
const MOCK_SCALE = MOCK_VP.width / TK_MOCK_W

describe('the bottom rail has TWO columns (driver-2: the stencil painted over the grille)', () => {
  const bandAt = (stage: ChassisStage, vp: { width: number; height: number }) => {
    const bezel = chassisBezel(stage, vp)
    const cuts = chassisSlabPolygon({ width: vp.width, height: vp.height, bezel }).cuts
    const grille = chassisGrilleBand({ width: vp.width, shearBlX: cuts.shearBl.x })
    return {
      bezel,
      grille,
      statusLeft: chassisStatusLeftPx({ width: vp.width, inset: bezel.x + 4, grille }),
    }
  }

  it('never lets a legend start before the perforated panel ends', () => {
    // THE DEFECT, exactly: grille [158,847,126,31] with the SANDBOXED RENDERER
    // stencil at [120,856,187,8] вЂ” the legend printed across the speaker.
    for (const stage of STAGES) {
      if (!hasChassisFeature(stage, 'grille')) continue
      for (const vp of VIEWPORTS) {
        const { grille, statusLeft } = bandAt(stage, vp)
        expect(statusLeft, `${stage} @ ${vp.width}`).toBeGreaterThanOrEqual(
          grille.right + TK_GRILLE_GAP_MIN_PX,
        )
      }
    }
  })

  it('leaves the legends real room after clearing the panel', () => {
    for (const stage of STAGES) {
      if (!hasChassisFeature(stage, 'grille')) continue
      for (const vp of VIEWPORTS) {
        const { bezel, statusLeft } = bandAt(stage, vp)
        // The stencil and the serial plate are ~280px of 8px type between them.
        expect(vp.width - bezel.x - 4 - statusLeft, `${stage} @ ${vp.width}`)
          .toBeGreaterThan(300)
      }
    }
  })

  it('lands on the mock geometry at the stage the mock was drawn at', () => {
    const { grille, statusLeft } = bandAt('wide', MOCK_VP)
    // mock L340 вЂ” the panel: left 152, width 128 on a 1428 shell.
    expect(Math.abs(grille.left - 152 * MOCK_SCALE)).toBeLessThanOrEqual(12)
    expect(Math.abs(grille.width - 128 * MOCK_SCALE)).toBeLessThanOrEqual(6)
    // mock L342/L343 вЂ” the hazard flash and the stencil both start at 286.
    expect(Math.abs(statusLeft - 286 * MOCK_SCALE)).toBeLessThanOrEqual(12)
    // The mock's own parting between the two columns is 6px (280 в†’ 286).
    expect(statusLeft - grille.right).toBeGreaterThanOrEqual(TK_GRILLE_GAP_MIN_PX)
  })

  it('falls back to the flank inset on the stages that mill no grille', () => {
    for (const stage of STAGES) {
      if (hasChassisFeature(stage, 'grille')) continue
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        expect(chassisStatusLeftPx({ width: vp.width, inset: bezel.x + 4, grille: null }))
          .toBe(bezel.x + 4)
      }
    }
  })

  it('takes the panel width from the mock fraction, not a magic number', () => {
    expect(TK_GRILLE_W_F).toBeCloseTo(128 / TK_MOCK_W, 6)
  })

  it('starts the panel where the bottom-left shear ends вЂ” nothing over a cut', () => {
    for (const vp of VIEWPORTS) {
      const bezel = chassisBezel('wide', vp)
      const cuts = chassisSlabPolygon({ width: vp.width, height: vp.height, bezel }).cuts
      expect(chassisGrilleBand({ width: vp.width, shearBlX: cuts.shearBl.x }).left)
        .toBeGreaterThan(cuts.shearBl.x)
    }
  })
})

// в”Ђв”Ђ The intake louvres вЂ” VERIFIED CONFORMANT, pinned so they stay that way в”Ђв”Ђв”Ђв”Ђ
// Driver-2 also flagged the intake band (299px at [483,19]) as "far wider than
// the mock tray louvre". It is not: the mock's vent is 306px wide at x=492 on a
// 1428 shell (L316), which is 300px at x=482 once scaled into the 1400px window
// the build was measured in вЂ” the strip is mock-exact and the report is a false
// positive. This test is the receipt, so nobody re-sizes it to something else.
describe('the intake louvres fill the tray at the mock fraction (driver-2 re-check)', () => {
  it('reproduces mock L316 inside the tray the silhouette steps down for', () => {
    const bezel = chassisBezel('wide', MOCK_VP)
    const { tray } = chassisSlabPolygon({ ...MOCK_VP, bezel }).cuts
    expect(tray).not.toBeNull()
    // The component draws the strip at `tray.at + 2` Г— `tray.span - 4` вЂ” a 2px
    // margin inside the tray floor, which is what the mock draws too (its tray
    // floor runs 490в†’800 and the vent is 492в†’798).
    const left = tray!.at + 2
    const width = tray!.span - 4
    expect(Math.abs(left - 492 * MOCK_SCALE)).toBeLessThanOrEqual(4)
    expect(Math.abs(width - 306 * MOCK_SCALE)).toBeLessThanOrEqual(4)
    // вЂ¦and it is a strip in a tray, not a band across the rail.
    expect(width / MOCK_VP.width).toBeLessThan(0.24)
  })
})

// в”Ђв”Ђ The flush-stage keys must be FINDABLE в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Live-found (driver-2): maximized, the three 14Г—14 caps were near-black on a
// near-black well 3px from the window edge, with the TitleBar's own row hidden
// by the [data-chassis-keys="1"] interlock вЂ” a maximized TK-05 had window
// controls nobody could see. The fix lights the caps; these are the numbers.
describe('chassisKeyFinish (the maximized window must show its controls)', () => {
  const THEME_CSS = fs.readFileSync(path.join(SRC, 'themes/tachikoma-red.css'), 'utf8')

  /** `var(--x)` в†’ the hex tachikoma-red.css declares for it, so a palette edit
   *  that made the keys invisible fails HERE and not in a screenshot. */
  const resolveInk = (value: string): string => {
    const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())
    if (!m) return value.trim()
    const decl = new RegExp(`${m[1]}\\s*:\\s*([^;]+);`).exec(THEME_CSS)
    expect(decl, `${m[1]} is not declared in tachikoma-red.css`).toBeTruthy()
    return decl![1].trim()
  }
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  /** WCAG relative luminance of a #rrggbb (or a var that resolves to one). */
  const luminance = (ink: string): number => {
    const hex = resolveInk(ink).replace('#', '')
    expect(hex, `${ink} is not a plain hex ink`).toMatch(/^[0-9a-f]{6}$/i)
    const n = parseInt(hex, 16)
    return 0.2126 * channel(((n >> 16) & 255) / 255)
      + 0.7152 * channel(((n >> 8) & 255) / 255)
      + 0.0722 * channel((n & 255) / 255)
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }

  it('lights the caps at flush and ONLY at flush', () => {
    for (const stage of STAGES) {
      expect(chassisKeyFinish(stage).lit, stage).toBe(stage === 'flush')
    }
    expect(chassisKeyFinish('flush')).toBe(TK_KEY_FINISH.lit)
  })

  it('clears 3:1 cap-vs-well вЂ” the non-text contrast bar (WCAG 1.4.11)', () => {
    const f = TK_KEY_FINISH.lit
    // The measured failure was 1.14:1. Anything under 3 is the same defect.
    expect(contrast(f.capFill, f.wellFill)).toBeGreaterThanOrEqual(3)
    expect(contrast(f.closeFill, f.wellFill)).toBeGreaterThanOrEqual(3)
  })

  it('clears 3:1 engraving-vs-cap, so the marks read on a lit face', () => {
    const f = TK_KEY_FINISH.lit
    expect(contrast(f.glyph, f.capFill)).toBeGreaterThanOrEqual(3)
    expect(contrast(f.closeGlyph, f.closeFill)).toBeGreaterThanOrEqual(3)
  })

  it('clears 3:1 on EVERY gradient stop, not just the flat fill', () => {
    // A raking face whose shaded end fell back to the chassis grey would leave
    // the bottom third of each cap exactly as invisible as the defect was.
    const f = TK_KEY_FINISH.lit
    for (const image of [f.capImage, f.closeImage]) {
      const stops = image.match(/#[0-9a-f]{6}/gi) ?? []
      expect(stops.length).toBeGreaterThanOrEqual(3)
      for (const stop of stops) {
        expect(contrast(stop, f.wellFill), `${stop} vs the well`).toBeGreaterThanOrEqual(3)
        expect(contrast(stop, f.glyph), `${stop} vs the engraving`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps the close key distinguishable from the other two', () => {
    const f = TK_KEY_FINISH.lit
    expect(f.closeFill).not.toBe(f.capFill)
    expect(contrast(f.closeFill, f.capFill)).toBeGreaterThan(1.4)
  })

  it('honours the CYAN RESTRAINT вЂ” a lit control carries the unit own light', () => {
    // A physical control MAY carry light; cyan still belongs to the optic, the
    // live lamps and the screen, so the lit caps take the slab key light and
    // the alarm ink instead.
    for (const [key, value] of Object.entries(TK_KEY_FINISH.lit)) {
      if (typeof value !== 'string') continue
      for (const optic of ['00e5ff', '0,229,255', '0, 229, 255', 'accent-alt']) {
        expect(value, `${optic} leaked onto the ${key} of a chassis key`).not.toContain(optic)
      }
    }
  })

  it('leaves the DRESSED stages byte-identical (driver-2 marked them PASS)', () => {
    const f = TK_KEY_FINISH.dressed
    expect(f.lit).toBe(false)
    expect(f.wellFill).toBe('rgba(4,2,3,0.85)')
    expect(f.capFill).toBe('rgba(30,21,24,0.98)')
    expect(f.closeFill).toBe(f.capFill)
    expect(f.closeImage).toBe(f.capImage)
    expect(f.glyph).toBe('var(--text-primary)')
    expect(f.closeGlyph).toBe('var(--danger)')
    expect(f.rim).toBe('inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.9)')
  })
})

describe('chassisKeyWellPadPx (the well fits INSIDE the flank)', () => {
  it('never lets the well overhang onto the app plate', () => {
    // At flush the flank is 14px and the cap takes all of it, so the nominal 3px
    // pad made a 20px well: 6px of it sat behind the plate globals.css lifts to
    // z-index 5, which clipped 3px off every cap.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = chassisBezel(stage, vp)
        const size = chassisKeySizePx(bezel.x)
        const well = size + chassisKeyWellPadPx(size, bezel.x) * 2
        expect(well, `${stage} @ ${vp.width}`).toBeLessThanOrEqual(bezel.x)
      }
    }
  })
  it('keeps the roomy stages exactly where they were', () => {
    expect(chassisKeyWellPadPx(30, TK_BEZEL.wide.x)).toBe(5)
    expect(chassisKeyWellPadPx(30, TK_BEZEL.mid.x)).toBe(5)
    expect(chassisKeyWellPadPx(22, TK_BEZEL.narrow.x)).toBe(4)
    expect(chassisKeyWellPadPx(14, TK_BEZEL.flush.x)).toBe(0)
  })
  it('collapses to zero rather than going negative on a degenerate flank', () => {
    expect(chassisKeyWellPadPx(14, TK_BEZEL_MIN.x)).toBe(0)
  })
})

describe('TachikomaChrome.tsx (the driver-2 wiring)', () => {
  const src = stripComments(read('components/TachikomaChrome.tsx'))

  it('lays both rail columns out from ONE band', () => {
    expect(src).toContain('chassisGrilleBand(')
    expect(src).toContain('chassisStatusLeftPx(')
    // One band, computed once, handed to both consumers.
    expect((src.match(/chassisGrilleBand\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/<Grille band=\{grille\}/)
    expect(src).toMatch(/<StatusBlock[\s\S]{0,160}left=\{statusLeft\}/)
    // The old single-margin prop is gone: it is what put the stencil at 120px.
    expect(src).not.toMatch(/inset=\{x \+ 4\}/)
  })

  it('keeps the ACOUSTIC rating with the panel it rates', () => {
    const start = src.indexOf('function Grille(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('function Wheel(', start))
    expect(body).toContain('ACOUSTIC 2W')
    // вЂ¦and the status row only prints it when there is no panel to hang it on.
    expect(src).toMatch(/acoustic=\{!grille\}/)
    expect(src).toMatch(/\{acoustic && \(/)
  })

  it('takes every key colour from the staged finish, never a literal', () => {
    expect(src).toContain('chassisKeyFinish(stage)')
    expect(src).toContain('chassisKeyWellPadPx(size, flank)')
    for (const field of ['capFill', 'capImage', 'closeFill', 'closeImage', 'wellFill', 'glyph', 'rim']) {
      expect(src, `finish.${field} unused`).toContain(`finish.${field}`)
    }
    // The old hardcoded caps are gone.
    expect(src).not.toContain('rgba(30,21,24,0.98)')
    expect(src).not.toContain('rgba(4,2,3,0.85)')
  })

  it('publishes the structure-sheet hook on all three keys', () => {
    // tachikoma-red-structure.css GROUP B2 excludes [data-chassis-key] from the
    // optic offset: the caps are hardware, not app controls.
    expect((src.match(/data-chassis-key\b/g) ?? []).length).toBe(3)
    expect((src.match(/data-lit=\{lit\}/g) ?? []).length).toBe(3)
    expect(src).toMatch(/data-key="close"/)
  })

  it('gives the lit caps their own hover, and leaves the dressed hover alone', () => {
    expect(src).toContain('.tk-chassis-key:not([data-lit="1"]):hover')
    expect(src).toContain('.tk-chassis-key[data-lit="1"]:hover')
    expect(src).toContain('.tk-chassis-key[data-lit="1"][data-key="close"]:hover')
  })
})

// ── THE IDLE GATE (batch30d, lane W1) ───────────────────────────────────────
// Owner: "проверь что приложение просто так не гоняет GPU". The idle audit
// (lane V, 12780f0) found the theme layer to be the last thing still burning
// frames on an app nobody was touching, and the TK-05 slab was the worst of it:
//
//   1. `live: true` was HARDCODED on two LED cells, and `tk-chassis-led`
//      animates `box-shadow` — a PAINT property — so the LED rack of an
//      always-mounted chrome repainted every frame, forever.
//   2. the vent sweep ran `7s linear infinite` unconditionally: compositor-only,
//      but it pins the compositor awake permanently.
//   3. `tk-reticle` animated on EVERY h1::after / h2::after in the app.
//   4. nothing anywhere knew the window was unfocused. Electron's
//      backgroundThrottling only covers minimised / occluded; the owner's window
//      lives VISIBLE and unfocused on a second monitor, where it never fires.
//
// These guards pin the fix in both directions: the lamps may only report state
// they can actually read (the honesty law, applied to hardware), and the motion
// may only run when there is something to report AND someone to see it.

describe('chassisLampLit (a lamp is a real reading or it is dark)', () => {
  const NONE = {}
  const ALL = { runActive: true, linkUp: true, online: true }
  const SOURCES: readonly ChassisLampSource[] = ['run', 'link', 'net', 'power', 'dead']

  it('wires each source to its OWN signal and to no other', () => {
    expect(chassisLampLit('run', { runActive: true })).toBe(true)
    expect(chassisLampLit('run', { linkUp: true, online: true })).toBe(false)
    expect(chassisLampLit('link', { linkUp: true })).toBe(true)
    expect(chassisLampLit('link', { runActive: true, online: true })).toBe(false)
    expect(chassisLampLit('net', { online: true })).toBe(true)
    expect(chassisLampLit('net', { runActive: true, linkUp: true })).toBe(false)
  })

  it('lights `power` always and `dead` never — the two ends of the law', () => {
    // `power` is the one tautology and a true one: the function only runs in a
    // renderer that is executing. `dead` is the escape hatch that keeps the rest
    // honest — a cell with no source is dark, never dressed up as one with one.
    expect(chassisLampLit('power', NONE)).toBe(true)
    expect(chassisLampLit('power', ALL)).toBe(true)
    expect(chassisLampLit('dead', ALL)).toBe(false)
    expect(chassisLampLit('dead', NONE)).toBe(false)
  })

  it('treats an ABSENT signal as not lit (a caller may wire one lamp only)', () => {
    for (const s of ['run', 'link', 'net'] as const) {
      expect(chassisLampLit(s, NONE), s).toBe(false)
    }
  })

  it('is total — every source in the union answers a boolean', () => {
    for (const s of SOURCES) {
      expect(typeof chassisLampLit(s, ALL), s).toBe('boolean')
      expect(typeof chassisLampLit(s, NONE), s).toBe('boolean')
    }
  })
})

describe('TK-05 lamps and motion are gated on real state', () => {
  const src = stripComments(read('components/TachikomaChrome.tsx'))

  it('has no hardcoded live cell left anywhere', () => {
    // `live: true` on a table row is the exact shape of the defect.
    expect(src).not.toMatch(/live:\s*true/)
    expect(src).not.toMatch(/cell\.live/)
  })

  it('derives every lamp from chassisLampLit over the shared signals', () => {
    expect(src).toContain('chassisLampLit(')
    const table = src.slice(src.indexOf('const LED_BLOCK'), src.indexOf('function lampFace'))
    expect(table.length).toBeGreaterThan(0)
    // Six named cells, each naming its source.
    for (const name of ['SERVO', 'OPTIC', 'LINK', 'GPU', 'NET', 'PWR']) {
      expect(table, `${name} lamp missing`).toContain(`'${name}'`)
    }
    // Six rows, each with a literal source (the 7th `source:` in this slice is
    // the row TYPE, which is why the match demands a quoted value).
    expect((table.match(/source:\s*'/g) ?? []).length).toBe(6)
    // GPU is THE dead cell: no cheap renderer-side reading exists for it, and
    // inventing one (or spending a timer on it) is what this pass removes.
    expect(table).toMatch(/name:\s*'GPU',\s+source:\s*'dead'/)
    // NET took over the source the dead cell used to sit on.
    expect(table).toMatch(/name:\s*'NET',\s+source:\s*'net'/)
  })

  it('makes the flank rack a REPEATER, never a second private table', () => {
    // Five unlabelled lamps with their own states would be five more claims
    // nobody can check, and the two racks could contradict each other.
    expect(src).toContain('LED_BLOCK.slice(0, 5)')
    expect(src).not.toContain('const LED_CELLS')
  })

  it('reads the run signal from the same three stores the scan bar does', () => {
    expect(src).toContain('chassisRunActive({ agentStatus, nodesRunning, chatStreaming })')
    expect(src).toContain('useAgentStore')
    expect(src).toContain('useNodesRunStore')
    expect(src).toContain('streamingConversationId !== null || s.streamingMessageId !== null')
  })

  it('blinks the iris ONLY while that cell is lit by a run', () => {
    expect(src).toMatch(/const blink = lit && cell\.blink === true/)
    expect(src).toMatch(/animation: blink \? 'tk-chassis-led/)
    // …and the unlit face is a dark lamp in its housing, not a missing one.
    expect(src).toContain('const LED_OFF')
    expect(src).toMatch(/backgroundColor: lit \? cell\.ink : LED_OFF/)
  })

  it('mounts the vent sweep only while something is running', () => {
    const start = src.indexOf('function Vents(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('function Grille(', start))
    // Conditionally RENDERED, not merely un-animated: the keyframe's 0% is
    // `translateY(-140%); opacity: 0`, so a sweep left in the tree without its
    // animation parks a lit cyan band at the top of the vent.
    expect(body).toMatch(/\{runActive && \([\s\S]*tk-chassis-sweep/)
    expect((body.match(/tk-chassis-sweep/g) ?? []).length).toBe(1)
  })

  it('lights LINK from `running`, never from the port it prints', () => {
    // The legend falls back to the documented default when the server is down —
    // a plate rating. A LAMP may not: it would be claiming a live server.
    expect(src).toMatch(/up:\s*s\?\.running === true/)
    expect(src).toContain('chassisLinkLabel(api.port)')
  })

  it('reads NET from the platform, with BOTH edges wired and torn down', () => {
    expect(src).toContain('navigator.onLine')
    for (const evt of ['online', 'offline']) {
      expect(src).toContain(`addEventListener('${evt}'`)
      expect(src).toContain(`removeEventListener('${evt}'`)
    }
  })

  it('prints the PWR plate as a RATING, never as a voltmeter reading', () => {
    // One decimal place is the whole difference: `12V 4A` is what a plate says,
    // `12.4V` is what an instrument says — and this one is a constant.
    expect(src).not.toContain('12.4V')
    expect(src).toContain('PWR 12V 4A')
  })

  it('adds NO timer of its own — the lamps are stores and OS events', () => {
    // The whole point of the batch: an always-mounted chrome may not poll.
    expect(src).not.toContain('setInterval')
    expect(src).not.toContain('setTimeout')
    expect(src).not.toContain('requestAnimationFrame')
  })
})

describe('AppShell publishes the two :root idle signals', () => {
  const shell = stripComments(read('components/layout/AppShell.tsx'))

  it('stamps data-window-focused on focus and REMOVES it on blur', () => {
    expect(shell).toContain("root.setAttribute('data-window-focused', '1')")
    expect(shell).toContain("root.removeAttribute('data-window-focused')")
    for (const evt of ['focus', 'blur']) {
      expect(shell).toContain(`addEventListener('${evt}'`)
      expect(shell).toContain(`removeEventListener('${evt}'`)
    }
    // PRESENT OR ABSENT, never "0": the sheets ask with `:not()`, so every
    // environment that fires no focus event degrades to PAUSED — the safe way.
    expect(shell).not.toMatch(/data-window-focused',\s*'0'/)
  })

  it('seeds from document.hasFocus() (a window can open in the background)', () => {
    expect(shell).toContain('document.hasFocus')
  })

  it('mirrors run-active onto :root WITHOUT moving the scan-bar stamp', () => {
    // The element stamp is what the OPUS-5 sweep rule reads
    // (`[data-scan-bar][data-run-active="1"]`); both halves of that pair stay.
    expect(shell).toContain("data-run-active={runActive ? '1' : '0'}")
    // The mirror is what lets a sheet gate motion in a DIFFERENT subtree — the
    // TK reticle is an h1::after anywhere in the app.
    expect(shell).toContain("root.setAttribute('data-run-active', '1')")
    expect(shell).toContain("root.removeAttribute('data-run-active')")
    expect(shell).toContain('chassisRunActive(')
  })
})

describe('tachikoma-red-structure.css · GROUP R (the idle gate)', () => {
  const raw = fs.readFileSync(
    path.resolve(__dirname, '../../src/themes/tachikoma-red-structure.css'), 'utf8',
  )
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = css.split('}')
    .map((b) => {
      const i = b.indexOf('{')
      return i === -1 ? null : { selector: b.slice(0, i).trim(), body: b.slice(i + 1) }
    })
    .filter((r): r is { selector: string; body: string } => !!r)
  const pause = blocks.filter((r) => r.body.includes('animation-play-state'))

  it('pauses the chassis while the window is visible but UNFOCUSED', () => {
    expect(pause.length).toBe(1)
    // `!important` twice over: the animations are INLINE on the chassis leaves,
    // and the `animation` shorthand resets play-state to `running`.
    expect(pause[0].body).toMatch(/animation-play-state:\s*paused\s*!important/)
    expect(pause[0].selector).toContain(':not([data-window-focused])')
  })

  it('scopes the pause to the chassis — the app\'s run dots keep animating', () => {
    // A blanket `:root:not([data-window-focused]) *` would freeze the streaming
    // caret and every waiting indicator: the motion a user alt-tabs AWAY to let
    // finish, and the only motion in the product that is load-bearing.
    for (const sel of pause[0].selector.split(',')) {
      expect(sel.trim(), sel).toContain(':root[data-theme="tachikoma-red"]')
      expect(sel.trim(), sel).toContain('.tk-chassis')
    }
  })

  it('aims at the class the component actually renders', () => {
    expect(read('components/TachikomaChrome.tsx')).toContain('className="tk-chassis"')
  })

  it('animates the reticle ONLY under a live run, and always cuts the tick', () => {
    const reticle = blocks.filter((r) => r.selector.includes('h1::after'))
    const animated = reticle.filter((r) => /animation:\s*tk-reticle/.test(r.body))
    expect(animated.length).toBe(1)
    expect(animated[0].selector).toContain('[data-run-active="1"]')
    // The corner lock itself is STRUCTURE and is painted at all times.
    const still = reticle.filter((r) => r.body.includes('border-bottom'))
    expect(still.length).toBe(1)
    expect(still[0].selector).not.toContain('data-run-active')
    expect(still[0].body).not.toContain('animation')
  })

  it('keeps the reduced-motion kill switch last, and still total', () => {
    // House rule: the kill switch is the last thing in the file, so a rule
    // appended later cannot outlive it. `animation: none !important` wins on the
    // NAME, so there is nothing left for the pause rule to freeze.
    const rmIdx = raw.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    expect(rmIdx).toBeGreaterThan(raw.lastIndexOf('animation-play-state'))
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion'))
    expect(rm).toContain('h1::after')
    expect(rm).toMatch(/animation:\s*none\s*!important/)
  })
})
