// apps/desktop/test/unit/opusChrome.test.ts
//
// Guards for the OPUS-5 · CHASSIS REV 5 frame (src/components/OpusChrome.tsx +
// src/components/opus/opusChrome.helpers.ts). Same conventions as
// tachikomaChrome.test.ts / structureSheets.test.ts: the pure helpers are exercised
// directly and everything that only exists as JSX is checked at the SOURCE level
// (the test env is node with no DOM, so there is no getComputedStyle).
//
// The defects these tests exist to prevent are the ones this app has already
// shipped once:
//   1. Chrome that DISAPPEARS on a narrow window — the crab claws hide below
//      1180px, and the mock's 1068×800 panel IS the owner's daily size.
//   2. `filter: drop-shadow()` on a transparent element that holds text (it
//      traces alpha, so it paints a ghost copy of the glyphs).
//   3. A decorative layer that eats clicks (missing pointer-events: none).
//   4. A theme-level `cursor` killing the resize affordance (resizeCursor.test).
//   5. NEW, specific to this frame: the crab engraving is the ONE layer that
//      paints above the app plate, so its containment is pinned here — it must
//      stay pointer-events:none, keep a single ink constant, and be inset from
//      the plate edge (the mock's "the window edge can never eat it").
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  OPUS_THEME,
  OPUS_COMPARTMENTS,
  isOpusTheme,
  opusLayout,
  opusBezel,
  OPUS_BEZEL,
  opusRulerStepPx,
  opusRulerHeightPx,
  opusRulerVisible,
  OPUS_RULER_MIN_RAIL_PX,
  opusActiveBay,
  opusEngraveInsetPx,
  opusEngraveHeightPx,
  opusEngraveVisible,
  opusEngraveTopPx,
  opusEngraveBandPx,
  OPUS_ENGRAVE_HEAD_PX,
  OPUS_ENGRAVE_FOOT_PX,
  OPUS_ENGRAVE_BURR_PX,
  opusLedPx,
  opusLegendVisible,
  OPUS_LED_COUNT,
  OPUS_LEGEND_MIN_RAIL_PX,
  opusDragBandPx,
  OPUS_DRAG_EDGE_PX,
  opusCaptionMode,
  opusBayCaptionMode,
  OPUS_CAPTION_MIN_PX,
  chassisRunActive,
  opusDownloadActive,
  OPUS_IO_STATES,
  opusContextChars,
  opusSegmentLevel,
  OPUS_SEG_COUNT,
  opusFrameBitePx,
  opusFrameCorePx,
  opusFrameCoreChamferPx,
  OPUS_FRAME_BITE_MAX_PX,
} from '../../src/components/opus/opusChrome.helpers'
import {
  TK_BEZEL, TK_BEZEL_MIN, chassisStage, chassisCaptionMode, type ChassisStage,
} from '../../src/components/tachikoma/tachikomaChrome.helpers'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** Strip CSS comments only — the sheets document the selectors they must not
 *  contain, exactly like the TSX files do. */
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Strip block and line comments — these files DOCUMENT the defects they must
 *  not contain ("no drop-shadow", "no cursor"), so an un-stripped scan fails on
 *  the prose that explains the rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const STAGES: ChassisStage[] = ['wide', 'mid', 'narrow', 'flush']

const VIEWPORTS = [
  { width: 900, height: 600 },
  { width: 1024, height: 700 },
  { width: 1068, height: 800 },   // the mock's own frame, and the daily size
  { width: 1280, height: 800 },
  { width: 1400, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

describe('isOpusTheme (mount predicate)', () => {
  it('is true only for the OPUS-5 theme id', () => {
    expect(OPUS_THEME).toBe('tachi-opus5')
    expect(isOpusTheme(OPUS_THEME)).toBe(true)
  })
  it('is false for every other theme and for nullish input', () => {
    for (const other of ['tachi-dark', 'tachi-neon', 'comic', 'tachikoma-red', 'bankr', '', 'custom:x']) {
      expect(isOpusTheme(other)).toBe(false)
    }
    expect(isOpusTheme(null)).toBe(false)
    expect(isOpusTheme(undefined)).toBe(false)
  })
})

// ── THE headline contract, again ─────────────────────────────────────────────
describe('the OPUS-5 frame never disappears', () => {
  it('returns a layout at EVERY viewport, including the 1068px daily width', () => {
    for (const vp of VIEWPORTS) {
      const l = opusLayout({ theme: OPUS_THEME, ...vp, maximized: false })
      expect(l, `${vp.width}×${vp.height}`).not.toBeNull()
      expect(l!.bezel.x).toBeGreaterThan(0)
      expect(l!.bezel.y).toBeGreaterThan(0)
      expect(l!.bezel.bottom).toBeGreaterThan(0)
    }
    const daily = opusLayout({ theme: OPUS_THEME, width: 1068, height: 800, maximized: false })
    expect(daily!.stage).toBe('narrow')
  })

  it('returns null ONLY for a foreign theme', () => {
    expect(opusLayout({ theme: 'tachikoma-red', width: 1600, height: 900, maximized: false })).toBeNull()
    expect(opusLayout({ theme: null, width: 1600, height: 900, maximized: false })).toBeNull()
    expect(opusLayout({ theme: OPUS_THEME, width: 320, height: 240, maximized: false })).not.toBeNull()
  })

  it('reuses the TK-05 staging LADDER, and its own bezel table', () => {
    // One ladder, two frames: a change to the thresholds or the clamps must move
    // both, and a test that pins one pins the other. The TABLE is forked (see
    // the thin-rim block below) — the slab's 116/62 is a slab's geometry.
    for (const vp of VIEWPORTS) {
      for (const maximized of [false, true]) {
        const l = opusLayout({ theme: OPUS_THEME, ...vp, maximized })!
        // opusLayout opts back into thin-at-maximized (flushOnMaximized) -
        // the ONE divergence from the TK ladder, by owner directive.
        const stage = chassisStage({ width: vp.width, maximized, flushOnMaximized: true })
        expect(l.stage).toBe(stage)
        expect(l.bezel).toEqual(opusBezel(stage, vp))
      }
    }
  })
})

// ── THE THIN RIM (2026-07-27) ────────────────────────────────────────────────
// The owner's report, verbatim: "в опус теме обрежь блять рамку" — at 1516×912
// the frame borrowed TK_BEZEL and spent 116px on each flank and 62px on each
// rail, ~232px of a 1516px window on metal. The mock it is a likeness of (1b)
// is a THIN instrument rim: a 30px header row, ~16px flanks with one vertical
// bay stencil each, a bottom hint strip. These tests are the ceiling.
describe('the OPUS-5 frame is a thin rim, not a slab', () => {
  it('never spends more than 16px on a flank, 30px on a rail, 24px on the foot', () => {
    for (const stage of STAGES) {
      expect(OPUS_BEZEL[stage].x, `${stage} flank`).toBeLessThanOrEqual(16)
      expect(OPUS_BEZEL[stage].y, `${stage} rail`).toBeLessThanOrEqual(30)
      expect(OPUS_BEZEL[stage].bottom, `${stage} foot`).toBeLessThanOrEqual(24)
      // …and it never disappears either: the floor is the chassis contract.
      expect(OPUS_BEZEL[stage].x).toBeGreaterThanOrEqual(TK_BEZEL_MIN.x)
      expect(OPUS_BEZEL[stage].y).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
      expect(OPUS_BEZEL[stage].bottom).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
    }
  })

  // ── The bottom rail is its own number (mock 1b, 2026-07-27) ────────────────
  // The frame drew its hint bar at the HEADER's thickness because the shared
  // recess rule spent one `--chassis-inset-y` on both edges, which made every
  // chassis vertically symmetric by construction. The rule now takes a separate
  // top and bottom, so the table finally says what the mock draws: a 30px
  // header (rack + revision caption + key well) over a 24px bar (one line of
  // hint type). These tests are what stop the two collapsing back into one.
  describe('the hint rail is thinner than the header rail', () => {
    it('is strictly thinner at EVERY stage', () => {
      for (const stage of STAGES) {
        expect(OPUS_BEZEL[stage].bottom, `${stage}`).toBeLessThan(OPUS_BEZEL[stage].y)
      }
      // The mock's own two numbers, and the flush pair that keeps the same 6px
      // difference on a rim the owner asked to be thinner still.
      expect(OPUS_BEZEL.narrow.y).toBe(30)
      expect(OPUS_BEZEL.narrow.bottom).toBe(24)
      expect(OPUS_BEZEL.flush.y - OPUS_BEZEL.flush.bottom).toBe(4)
    })

    it('never inverts once the viewport clamp bites', () => {
      // Both rails are clamped by ONE expression (same cap, same floor), so the
      // clamp can only bring them TOGETHER, never past each other. On a viewport
      // short enough it ties — that is deliberate: 6px of design intent must not
      // push the bottom rail under the minimum the rest of the frame sits at.
      for (const stage of STAGES) {
        for (const vp of [...VIEWPORTS, { width: 1000, height: 240 }, { width: 100, height: 100 }]) {
          const b = opusBezel(stage, vp)
          expect(b.bottom, `${stage} @ ${vp.height}`).toBeLessThanOrEqual(b.y)
          expect(b.bottom).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
        }
      }
      // The tie, stated: at 240px of height the cap is 18 and both rails take it.
      const short = opusBezel('narrow', { width: 1000, height: 240 })
      expect(short.y).toBe(18)
      expect(short.bottom).toBe(18)
    })

    it('gives the workspace back the 6px it used to spend', () => {
      // The whole point, in the only unit that matters — plate height at the
      // owner's daily 1068×800: 800 − 30 − 24 = 746, where the symmetric frame
      // took 800 − 30 − 30 = 740.
      const b = opusBezel('narrow', { width: 1068, height: 800 })
      expect(800 - b.y - b.bottom).toBe(746)
    })
  })

  it('is its OWN table, not the slab\'s — thinner on every flank', () => {
    // The two frames are different objects: the slab carries vents, a grille, a
    // hazard flash and a drive wheel; this one carries a header row. If a future
    // edit ever puts them back on one table this fails first.
    for (const stage of STAGES) {
      expect(OPUS_BEZEL[stage].x, `${stage} flank`).toBeLessThan(TK_BEZEL[stage].x)
    }
    // The rails follow where the slab was FAT — 62 → 30 and 46 → 30, which is
    // the half of the report that was about the bottom band.
    for (const stage of ['wide', 'mid'] as const) {
      expect(OPUS_BEZEL[stage].y, `${stage} rail`).toBeLessThan(TK_BEZEL[stage].y)
    }
    // …and at narrow / flush it deliberately spends MORE rail than the slab's
    // 24 / 10px, because EVERY stage now carries the mock's 30px header row
    // instead of degrading it: on a 10px rail that row has no printed legend, a
    // 3px LED cell and key caps standing proud of the metal. "Thin" is the
    // frame's cost to the workspace, not a race to zero — and the cost is
    // dominated by the flanks the owner circled, which halve at every stage.
    for (const stage of ['narrow', 'flush'] as const) {
      expect(OPUS_BEZEL[stage].y, `${stage} rail`).toBeGreaterThan(TK_BEZEL[stage].y)
    }
    // On every stage the owner actually reported (all three unmaximized ones)
    // the frame still costs strictly LESS metal in total than the slab table.
    for (const stage of ['wide', 'mid', 'narrow'] as const) {
      const was = 2 * TK_BEZEL[stage].x + 2 * TK_BEZEL[stage].y
      const now = 2 * OPUS_BEZEL[stage].x + OPUS_BEZEL[stage].y + OPUS_BEZEL[stage].bottom
      expect(now, `${stage} total chrome`).toBeLessThan(was)
    }
    expect(opusLegendVisible(TK_BEZEL.flush.y)).toBe(false)
    expect(opusLegendVisible(OPUS_BEZEL.flush.y)).toBe(true)
  })

  it('costs the workspace under 5% of the width at every real viewport', () => {
    // The old wide stage spent ~15% of a 1516px window on the two flanks alone.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = opusBezel(stage, vp)
        expect((2 * b.x) / vp.width, `${stage} @ ${vp.width}`).toBeLessThan(0.05)
        // The two rails are no longer one number doubled — the vertical cost is
        // the header PLUS the thinner hint bar.
        expect((b.y + b.bottom) / vp.height, `${stage} @ ${vp.height}`).toBeLessThan(0.11)
      }
    }
  })

  it('keeps the header rail thick enough for the row it exists to carry', () => {
    // 30px is not a taste: the rack stacks a 6px LED cell over its 8px legend
    // with a 3px gap (17px) and the rail spends ~20% on its pad. Anything under
    // the legend threshold silently drops `RUN IO NET PRV PWR`.
    for (const stage of STAGES) {
      expect(opusLegendVisible(OPUS_BEZEL[stage].y), stage).toBe(true)
      const { h } = opusLedPx(OPUS_BEZEL[stage].y)
      expect(h + 3 + 8 + Math.round(OPUS_BEZEL[stage].y * 0.2), stage)
        .toBeLessThanOrEqual(OPUS_BEZEL[stage].y)
    }
  })

  it('keeps a real drag band on the thin flanks (the frame is the handle)', () => {
    // Dragging was added the day before the thinning and must survive it: a
    // 16px flank minus the 6px resize strip is a 10px band, and the 30px top
    // rail — the primary handle — keeps 24px.
    for (const stage of STAGES) {
      const b = OPUS_BEZEL[stage]
      expect(opusDragBandPx(b.x), `${stage} flank band`).toBeGreaterThanOrEqual(4)
      expect(opusDragBandPx(b.y), `${stage} rail band`).toBeGreaterThanOrEqual(16)
    }
    expect(opusDragBandPx(OPUS_BEZEL.wide.x)).toBe(10)
  })

  it('stages by the LADDER even where the geometry stopped differing', () => {
    // wide / mid / narrow collapse to one number on purpose (there is no
    // hardware left to shed), but the ladder itself has to keep running: the
    // value lands in `data-chassis`, gates the caption ladder, and is what
    // flushOnMaximized resolves. Collapsing the STAGES would break all three.
    expect(OPUS_BEZEL.wide).toEqual(OPUS_BEZEL.narrow)
    expect(OPUS_BEZEL.flush.x).toBeLessThan(OPUS_BEZEL.narrow.x)
    expect(OPUS_BEZEL.flush.y).toBeLessThan(OPUS_BEZEL.narrow.y)
    const max = opusLayout({ theme: OPUS_THEME, width: 2560, height: 1440, maximized: true })!
    expect(max.stage).toBe('flush')
    expect(max.bezel).toEqual(OPUS_BEZEL.flush)
  })

  it('floors, never shears, on a viewport far shorter than the app allows', () => {
    // The ratio clamp is inert at the window's own 600px minHeight; below it the
    // rail shrinks and everything printed on it re-derives (legend, ruler, bite).
    const short = opusBezel('narrow', { width: 1000, height: 240 })
    expect(short.y).toBeLessThan(OPUS_BEZEL.narrow.y)
    expect(short.y).toBeGreaterThanOrEqual(TK_BEZEL_MIN.y)
    expect(opusLegendVisible(short.y)).toBe(false)
    const tiny = opusBezel('narrow', { width: 100, height: 100 })
    expect(tiny).toEqual({ x: TK_BEZEL_MIN.x, y: TK_BEZEL_MIN.y, bottom: TK_BEZEL_MIN.y })
  })
})

describe('rail ruler', () => {
  it('coarsens the tick pitch as the rail thins (a fine scale becomes a smear)', () => {
    expect(opusRulerStepPx('narrow')).toBeLessThanOrEqual(opusRulerStepPx('wide'))
    expect(opusRulerStepPx('flush')).toBeLessThanOrEqual(opusRulerStepPx('narrow'))
    for (const stage of STAGES) expect(opusRulerStepPx(stage)).toBeGreaterThan(0)
  })

  it('never draws a ruler taller than the rail it is cut into', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        expect(opusRulerHeightPx(bezel.y), `${stage} @ ${vp.height}`).toBeLessThan(bezel.y)
        expect(opusRulerHeightPx(bezel.y)).toBeGreaterThanOrEqual(4)
      }
    }
  })

  it('leaves room for the legends beside it at every stage that draws it', () => {
    // The rail carries the ruler on its OUTER edge and the legends on the
    // plate-facing side. Below the threshold there is room for one of the two,
    // and the ruler — pure texture — is the one that goes.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        if (!opusRulerVisible(bezel.y)) continue
        // ruler band + 2px offset + one 8px legend line + its 3px pad
        expect(opusRulerHeightPx(bezel.y) + 2 + 8 + 3, `${stage} @ ${vp.height}`)
          .toBeLessThanOrEqual(bezel.y + 1)
      }
    }
  })

  it('is SHED on the thin rim — the top rail is the header row now', () => {
    // The scale used to survive down to the 24px narrow rail because the rail
    // was empty below the header. On the thin rim the 30px top rail IS the
    // header: ~6px of pad and 17px of LED rack + legend leave 7px, less than
    // the 8px band the scale wants, and the ticks would surface between the
    // lamp cells. Mock 1b agrees — it prints no scale on either rail.
    for (const stage of STAGES) {
      expect(opusRulerVisible(OPUS_BEZEL[stage].y), stage).toBe(false)
      // The room the shed is claimed on, stated as arithmetic: rack + gap +
      // legend + pad + the ruler's own band does not fit in the rail.
      const rail = OPUS_BEZEL[stage].y
      const header = opusLedPx(rail).h + 3 + 8 + Math.round(rail * 0.2)
      expect(header + opusRulerHeightPx(rail) + 2, stage).toBeGreaterThan(rail)
    }
    // The gate is a THRESHOLD, not a deletion: a thicker rail gets its scale
    // back with no other edit, which is why Ruler and its two helpers stay.
    expect(opusRulerVisible(OPUS_RULER_MIN_RAIL_PX)).toBe(true)
    expect(opusRulerVisible(OPUS_RULER_MIN_RAIL_PX - 1)).toBe(false)
    expect(opusRulerVisible(TK_BEZEL.wide.y)).toBe(true)
  })
})

describe('compartments (the numbered bays)', () => {
  it('declares all four bays the mock silkscreens', () => {
    expect(OPUS_COMPARTMENTS.map(c => `${c.id} ${c.label}`)).toEqual([
      '01 NAV', '02 RAIL', '03 STAGE', '04 INPUT',
    ])
  })
  it('prints each bay on a frame edge', () => {
    for (const c of OPUS_COMPARTMENTS) {
      expect(['left', 'right', 'bottom']).toContain(c.edge)
    }
  })
})

// ── The caption ladder is THIS frame's own (2026-07-27, owner directive) ─────
// "метки текстом на узких если будет лучше". It was better and it was not
// happening: the frame read `chassisCaptionMode`, whose middle clause is
// `hasChassisFeature(stage, 'legends')` — a SLAB feature the TK-05 ladder drops
// at narrow and flush. So every stencil below 1180px degraded to an LED bar
// while the flank carrying it was the same 16px it is at 2560px. The frame was
// never out of room; it was reading another object's inventory ladder.
describe('opus caption ladder', () => {
  it('prints TEXT on every rail and flank the table actually produces', () => {
    // The regression, stated as the four stages that used to lose their type.
    for (const stage of STAGES) {
      const b = OPUS_BEZEL[stage]
      expect(opusCaptionMode(stage, b.y), `${stage} header`).not.toBe('bar')
      expect(opusCaptionMode(stage, b.bottom), `${stage} hint`).not.toBe('bar')
      expect(opusBayCaptionMode(b.x), `${stage} flank`).toBe('full')
    }
  })

  it('diverges from the TK gate exactly where the slab sheds its legends', () => {
    // The two frames still SHARE the staging ladder; what is forked is what a
    // stage buys. This pins the divergence so a future edit cannot quietly
    // re-point the opus frame at the slab's gate and undo the directive.
    for (const stage of ['narrow', 'flush'] as const) {
      expect(chassisCaptionMode(stage, OPUS_BEZEL[stage].y), stage).toBe('bar')
      expect(opusCaptionMode(stage, OPUS_BEZEL[stage].y), stage).toBe('short')
    }
    // …and they agree where the slab does print: wide is the long form.
    expect(opusCaptionMode('wide', OPUS_BEZEL.wide.y)).toBe('full')
    expect(opusCaptionMode('mid', OPUS_BEZEL.mid.y)).toBe('short')
  })

  it('still degrades to the LED bar where a surface is GENUINELY too small', () => {
    // "Restage, never hide" is intact — the bar is the truncation, it just fires
    // on the room available instead of on a borrowed feature list.
    expect(OPUS_CAPTION_MIN_PX).toBeGreaterThanOrEqual(8 + 2 + 2)
    for (const stage of STAGES) {
      expect(opusCaptionMode(stage, OPUS_CAPTION_MIN_PX), stage).not.toBe('bar')
      expect(opusCaptionMode(stage, OPUS_CAPTION_MIN_PX - 1), stage).toBe('bar')
    }
    expect(opusBayCaptionMode(OPUS_CAPTION_MIN_PX)).toBe('full')
    expect(opusBayCaptionMode(OPUS_CAPTION_MIN_PX - 1)).toBe('bar')
    // The one case that is genuinely too small: a viewport-clamped rim. At the
    // flank floor (TK_BEZEL_MIN.x = 10) and the rail floor (8) the bars return.
    expect(opusBayCaptionMode(TK_BEZEL_MIN.x)).toBe('bar')
    const tiny = opusBezel('narrow', { width: 100, height: 100 })
    expect(opusCaptionMode('narrow', tiny.y)).toBe('bar')
    expect(opusBayCaptionMode(tiny.x)).toBe('bar')
    // …and it is reachable through a real (if absurd) window, not only through
    // a hand-built bezel: a 150px-tall viewport clamps the rails to 11px.
    expect(opusCaptionMode('narrow', opusBezel('narrow', { width: 1000, height: 150 }).y)).toBe('bar')
  })

  it('never lets the STAGE decide whether a bay stencil has text at all', () => {
    // The bay marking is set vertically, so the flank's WIDTH holds the line box
    // and the marking's length runs down an axis no stage constrains. A gate
    // that took the stage would reintroduce the exact defect.
    for (const flank of [12, 16, 36, 116]) {
      expect(opusBayCaptionMode(flank), `${flank}px flank`).toBe('full')
    }
  })
})

describe('opusActiveBay (the CHASSIS MAP lamp)', () => {
  it('lights NAV on the hub and config surfaces', () => {
    for (const p of ['/home', '/settings', '/settings?tab=appearance', '/studio', '/learn']) {
      expect(opusActiveBay(p), p).toBe('nav')
    }
  })
  it('lights RAIL on the conversation surfaces', () => {
    for (const p of ['/chat', '/chat/abc', '/agent', '/tachiapp', '/inbox']) {
      expect(opusActiveBay(p), p).toBe('rail')
    }
  })
  it('lights STAGE for every other surface, including nothing at all', () => {
    for (const p of ['/nodes', '/design', '/media', '/wallet', '/', '', null, undefined]) {
      expect(opusActiveBay(p as string), String(p)).toBe('stage')
    }
  })
  it('is case-insensitive and never throws', () => {
    expect(opusActiveBay('/HOME')).toBe('nav')
    expect(opusActiveBay('/Chat/9')).toBe('rail')
  })
})

// ── The engraving's containment ──────────────────────────────────────────────
describe('crab engraving geometry (the window edge can never eat it)', () => {
  it('always keeps clear air between the silhouette and the plate edge', () => {
    // The inset is a fraction of the FLANK, so the thin rim resolves it to its
    // 10px floor everywhere — which is exactly what the floor is for: the mark
    // is inset from the PLATE, and a 16px flank must not drag it onto the seam.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        expect(opusEngraveInsetPx(bezel), `${stage} @ ${vp.width}`).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it('fits inside the plate at every viewport it agrees to draw on', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        const plateW = vp.width - 2 * bezel.x
        // The plate is bounded by the HEADER rail on top and the thinner HINT
        // rail below — the same expression Frame uses.
        const plateH = vp.height - bezel.y - bezel.bottom
        if (!opusEngraveVisible(plateW, plateH)) continue
        const h = opusEngraveHeightPx(plateH)
        const w = Math.round(h * 0.69)
        const inset = opusEngraveInsetPx(bezel)
        expect(h + inset * 2, `height @ ${vp.height}`).toBeLessThanOrEqual(plateH)
        expect(w + inset * 2, `width @ ${vp.width}`).toBeLessThanOrEqual(plateW)
      }
    }
  })

  it('refuses to draw on a plate too small to carry a mark', () => {
    expect(opusEngraveVisible(400, 800)).toBe(false)
    expect(opusEngraveVisible(1200, 200)).toBe(false)
    // The owner's daily 1068×800 on the thin rim: a 1036×746 plate (740 while
    // the two rails were one number; 996×752 while the frame borrowed the
    // slab's 36/24 narrow bezel).
    expect(opusEngraveVisible(1036, 746)).toBe(true)
  })

  it('stays a mark on the stage, not wallpaper over it', () => {
    for (const plateH of [320, 500, 752, 900, 1400, 2000]) {
      expect(opusEngraveHeightPx(plateH)).toBeLessThanOrEqual(plateH * 0.5 + 1)
      expect(opusEngraveHeightPx(plateH)).toBeLessThanOrEqual(420)
    }
  })

  // ── The dead-space band ────────────────────────────────────────────────────
  // The defect: "centred in the plate" is only dead space on the MOCK's idle
  // stage. On a live chat it put the silhouette straight over the GET MODELS row
  // and the answer bubbles (driver-verified on the installed build). The mark is
  // centred in the band BETWEEN the page header strip and the composer instead,
  // and these tests are what stop it creeping back into either.
  it('never enters the composer band or the header strip', () => {
    for (const plateH of [320, 500, 752, 800, 900, 1400, 2000]) {
      const h = opusEngraveHeightPx(plateH)
      const top = opusEngraveTopPx(plateH, h)
      expect(top, `top @ ${plateH}`).toBeGreaterThanOrEqual(OPUS_ENGRAVE_HEAD_PX)
      expect(top + h, `foot @ ${plateH}`).toBeLessThanOrEqual(plateH - OPUS_ENGRAVE_FOOT_PX)
    }
  })

  it('is sized from the band, not from the plate', () => {
    for (const plateH of [320, 500, 752, 900, 1400, 2000]) {
      expect(opusEngraveHeightPx(plateH), `h @ ${plateH}`)
        .toBeLessThanOrEqual(opusEngraveBandPx(plateH))
    }
    // The owner's daily 1068×800 → a 746px plate once the hint rail thinned to
    // 24: a 239px mark in a 570px band, where the old plate-relative pair gave
    // 346px.
    expect(opusEngraveBandPx(746)).toBe(570)
    expect(opusEngraveHeightPx(746)).toBe(239)
  })

  it('centres in the band, so the mark reads as placed and not as parked', () => {
    const h = opusEngraveHeightPx(752)
    const top = opusEngraveTopPx(752, h)
    const above = top - OPUS_ENGRAVE_HEAD_PX
    const below = (752 - OPUS_ENGRAVE_FOOT_PX) - (top + h)
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1)
  })

  it('keeps the composer clear even for a height it did not choose', () => {
    // A caller handing in an oversized height must still not park the mark under
    // the text field — the clamp resolves toward the HEADER, never the composer.
    const top = opusEngraveTopPx(752, 900)
    expect(top).toBe(OPUS_ENGRAVE_HEAD_PX)
  })

  it('leaves the horizontal anchor alone — the mark stays in the RIGHT third', () => {
    // The vertical rule moved; the horizontal one did not, and must not: the
    // left third is the reading column. Width is 0.69 of height by the art's own
    // aspect, so a right-anchored mark this narrow can never cross the midline.
    for (const plateW of [620, 996, 1400, 1920]) {
      const w = Math.round(opusEngraveHeightPx(800) * 0.69)
      expect(w, `w @ ${plateW}`).toBeLessThan(plateW / 3)
    }
  })
})

// ── Component source guards ─────────────────────────────────────────────────
describe('OpusChrome.tsx (source guards)', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('renders null unless the OPUS-5 theme is active', () => {
    expect(src).toMatch(/if\s*\(theme\s*!==\s*OPUS_THEME[^)]*\)\s*return null/)
  })

  it('has no width-gated early return and no display:none', () => {
    expect(src).not.toMatch(/display:\s*'?none/)
    expect(src).not.toContain('max-width')
    expect(src).not.toMatch(/width\s*<\s*\d+\s*\)\s*return null/)
  })

  it('sets pointer-events: none on EVERY decorative layer', () => {
    const divs = (src.match(/<div/g) ?? []).length
    const layered = (src.match(/style=\{\{\s*\.\.\.LAYER/g) ?? []).length
    expect(divs).toBeGreaterThan(10)
    expect(layered).toBe(divs)
    expect(src).toMatch(/const LAYER[^=]*=\s*\{[^}]*pointerEvents:\s*'none'/)
  })

  it('confines pointer-events: auto to ONE constant used only on buttons', () => {
    expect((src.match(/pointerEvents:\s*'auto'/g) ?? []).length).toBe(1)
    expect(src).toMatch(/const KEY_HIT[^=]*=\s*\{[^}]*pointerEvents:\s*'auto'/)
    const buttons = (src.match(/<button/g) ?? []).length
    const hits = (src.match(/style=\{\{\s*\.\.\.KEY_HIT/g) ?? []).length
    expect(buttons).toBe(3)
    expect(hits).toBe(buttons)
    expect(src).not.toMatch(/<div[^>]*\.\.\.KEY_HIT/)
  })

  it('wires the in-frame keys to the SAME window IPC the TitleBar uses', () => {
    for (const call of ['window?.minimize', 'window?.maximizeToggle', 'window?.close']) {
      expect(src, `${call} missing`).toContain(call)
    }
    expect(src).toMatch(/aria-label="Minimize"/)
    expect(src).toMatch(/aria-label="Close"/)
  })

  it('OpusKeys renders at EVERY stage — no thin-rail bail-out, ever', () => {
    // Live-found (twice, once per chassis theme): the structure sheet hides
    // the TitleBar row whenever data-chassis-keys is set, and the attribute
    // here is set whenever the chassis is live — so a render-side bail-out
    // (`if (rail < …) return null`) stranded a MAXIMIZED window with ZERO
    // controls while the attribute lied about a replacement being on screen.
    // The keys sit proud of a thin rail instead of unmounting. If a render
    // gate is ever reintroduced, the attribute effect MUST be gated on the
    // same predicate — this test forces that conversation.
    const keysFn = src.slice(src.indexOf('function OpusKeys'))
    const body = keysFn.slice(0, keysFn.indexOf('return ('))
    expect(body).not.toMatch(/return null/)
    expect(body).not.toMatch(/if\s*\(\s*rail\s*</)
    // …and the key keeps a CLICKABLE floor on the thinnest rail: keySizePx
    // clamps to ≥12px (live-measured 12×12 at flush). Lowering the floor
    // below a usable hit target is a deliberate decision, not a cleanup.
    const sizeFn = src.slice(src.indexOf('function keySizePx'))
    expect(sizeFn.slice(0, sizeFn.indexOf('}'))).toMatch(/Math\.max\(12,/)
  })

  it('hides the scenery from assistive tech but not the keys', () => {
    expect(src).toMatch(/<div aria-hidden style=\{\{\s*\.\.\.LAYER/)
    expect(src.indexOf('<OpusKeys')).toBeGreaterThan(src.indexOf('<div aria-hidden'))
  })

  it('never uses filter: drop-shadow (it would ghost the 8px legends)', () => {
    expect(src).not.toContain('drop-shadow')
    expect(src).not.toMatch(/\bfilter:/)
  })

  it('declares no cursor (globals.css owns the resize affordance)', () => {
    expect(src).not.toMatch(/cursor/)
  })

  it('keeps every layer below the plate EXCEPT the engraving', () => {
    // The plate is z-index 5 (globals.css). The frame sits at 0; the engraving
    // is the one documented exception at 6, because the mock puts the crab
    // INSIDE the stage and the plate is opaque.
    expect(src).toMatch(/zIndex:\s*0/)
    const sixes = (src.match(/zIndex:\s*6/g) ?? []).length
    expect(sixes).toBe(1)
    expect(src).not.toMatch(/zIndex:\s*(?:[1-5]|[7-9]|\d\d)/)
    // …and that one exception is still click-through and still masked art, not
    // a painted rectangle.
    expect(src).toContain('maskImage')
    expect(src).toContain('WebkitMaskImage')
    expect(src).toMatch(/const ENGRAVE_INK\s*=/)
  })

  it('renders the engraving as a SIBLING of the frame, not a child of it', () => {
    // `z-index: 0` on the frame container opens a stacking context, so a child
    // asking for z-index 6 would still paint below the plate — invisible. The
    // engraving must therefore sit outside that container, in a fragment.
    expect(src).toMatch(/return \(\s*<>/)
    const keysIdx = src.indexOf('<OpusKeys')
    const engIdx = src.indexOf('<Engraving')
    expect(keysIdx).toBeGreaterThan(0)
    expect(engIdx).toBeGreaterThan(keysIdx)
    // The frame's container closes between the two.
    expect(src.indexOf('</div>', keysIdx)).toBeLessThan(engIdx)
  })

  it('kills its own motion under reduced motion', () => {
    expect(src).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(src).toMatch(/\.opus-chassis \*\s*\{\s*animation:\s*none\s*!important/)
  })

  it('draws the frame in CSS and only the engraving from bitmaps', () => {
    expect(src).toContain('clipPath')
    expect(src).toContain('gradient(')
    // The two claw PNGs are the mask source and the ONLY assets imported —
    // every `.png` in the file is one of those two import statements.
    const pngImports = src.match(/^import\s+\w+\s+from\s+'[^']*\.png'$/gm) ?? []
    expect(pngImports.length).toBe(2)
    expect((src.match(/\.png/g) ?? []).length).toBe(pngImports.length)
    expect(src).toContain("from '../assets/crab/claw-left.png'")
    expect(src).toContain("from '../assets/crab/claw-right.png'")
  })

  it('ships every piece of the OPUS-5 inventory', () => {
    for (const piece of [
      'Ruler', 'HeaderRow', 'SegmentReadout', 'LampBlock', 'Bay', 'Engraving',
      'DragBands', 'OpusKeys',
    ]) {
      expect(src, `${piece} missing`).toContain(`function ${piece}(`)
    }
    // The mock's 1b header row is a BADGE plus a revision caption, not one
    // string — the dotted rule takes the slack between them.
    for (const mark of ['OPUS-5', 'CHASSIS REV 5', 'P·04 INPUT', 'ENTER run task', 'STAGE', 'RAIL', 'NAV']) {
      expect(src, `${mark} missing`).toContain(mark)
    }
    // The rack's five cells. `GPU` is deliberately NOT among them any more: it
    // was the one lamp with no reading behind it (hardcoded lit), and the local
    // engines it named can only be asked with a poll — see the honesty describe
    // below and `OpusLampMode` in the helpers.
    for (const lamp of ['RUN', 'IO', 'NET', 'PRV', 'PWR']) {
      expect(src, `${lamp} lamp missing`).toContain(`'${lamp}'`)
    }
  })

  it('prints the panel\'s REAL pixel size in the header (the mock\'s 1068 × 800)', () => {
    expect(src).toMatch(/viewport\.width\b[\s\S]{0,40}viewport\.height/)
  })

  it('adds no translatable copy (the markings are bay numbers and ratings)', () => {
    expect(src).not.toContain('useTranslation')
  })

  it('shares the recess attribute and tears it down on the cleanup only', () => {
    expect(src).toContain("root.setAttribute('data-chassis'")
    expect(src).toContain("root.removeAttribute('data-chassis')")
    expect(src).toContain("root.style.setProperty('--chassis-inset-x'")
    // BOTH vertical properties, stamped unconditionally. The recess rule falls
    // back to its narrow default for an unset one, so stamping only the top
    // would un-recess the bottom of the plate — and the whole reason the rule
    // takes two is that THIS frame's rails differ.
    expect(src).toContain("root.style.setProperty('--chassis-inset-top', `${by}px`)")
    expect(src).toContain("root.style.setProperty('--chassis-inset-bottom', `${bb}px`)")
    expect(src).toContain("root.style.removeProperty('--chassis-inset-top')")
    expect(src).toContain("root.style.removeProperty('--chassis-inset-bottom')")
    // …and the two are DIFFERENT numbers, i.e. the bottom really is read off
    // the bezel's own field and not aliased back onto the header rail.
    expect(src).toMatch(/const bb = layout\?\.bezel\.bottom \?\? 0/)
    expect(src).not.toContain('--chassis-inset-y')
    // The INACTIVE branch must not remove the attribute: both chassis components
    // write it, and only "cleanup removes / effect sets" is ordered correctly by
    // React across a theme switch.
    expect(src).toMatch(/if\s*\(!stage\)\s*return\b/)
  })
})

// ── The run signal behind the header scan bar ────────────────────────────────
// One boolean OR'd out of three stores. The truth table matters more than it
// looks: a scan bar that never stops is a decoration, and a scan bar that stays
// dark while a harness boots reads as a hang.
describe('chassisRunActive (the scan-bar signal)', () => {
  it('is false when nothing at all is happening', () => {
    expect(chassisRunActive({})).toBe(false)
    expect(chassisRunActive({ agentStatus: 'idle', nodesRunning: false, chatStreaming: false })).toBe(false)
    expect(chassisRunActive({ agentStatus: null })).toBe(false)
  })

  it('lights for a live agent run, INCLUDING the starting phase', () => {
    // Booting a harness session costs real seconds; a dark lamp through them is
    // indistinguishable from a hang.
    expect(chassisRunActive({ agentStatus: 'running' })).toBe(true)
    expect(chassisRunActive({ agentStatus: 'starting' })).toBe(true)
  })

  it('goes dark again on every TERMINAL agent status', () => {
    for (const status of ['done', 'error', 'idle']) {
      expect(chassisRunActive({ agentStatus: status }), status).toBe(false)
    }
  })

  it('lights for a Nodes run and for a streaming answer on their own', () => {
    expect(chassisRunActive({ nodesRunning: true })).toBe(true)
    expect(chassisRunActive({ chatStreaming: true })).toBe(true)
    // …and stays lit while one of three is still going.
    expect(chassisRunActive({ agentStatus: 'done', nodesRunning: true, chatStreaming: false })).toBe(true)
  })
})

// ── The scan bar's element (AppShell) ────────────────────────────────────────
// PATCH-01 left the mock's header scan bar unshipped because "a theme sheet
// cannot invent an element". This is that element: one inert leaf, two data
// hooks, dressed only by tachi-opus5-structure.css (GROUP R).
describe('AppShell header scan bar', () => {
  const shell = stripComments(read('components/layout/AppShell.tsx'))

  it('publishes both hooks the structure sheet aims at, exactly once', () => {
    expect((shell.match(/data-scan-bar/g) ?? []).length).toBe(1)
    expect(shell).toContain('data-run-active={runActive')
  })

  it('drives the run attribute from the shared signal, not a local guess', () => {
    expect(shell).toContain('chassisRunActive')
    expect(shell).toMatch(/useAgentStore\(s => s\.status\)/)
    // `nodesRunActive` is the store's own named selector — Run-all OR any single
    // node's run. The inline `s.status.kind === 'running'` it replaced answered
    // only for a Run-all, so a lone 44-minute render left every lamp dark.
    expect(shell).toMatch(/useNodesRunStore\(nodesRunActive\)/)
    // BOTH chat ids. `streamingMessageId` alone is set on the provider's first
    // chunk and cleared on done, so a short answer opened and closed the window
    // in ~0ms and the bar stayed dark for a whole real send (live-found on the
    // installed build). `streamingConversationId` is armed at SEND — the same
    // instant the chat's WaitingIndicator starts — so the OR is the honest read.
    expect(shell).toMatch(
      /useChatStore\(s => s\.streamingConversationId !== null \|\| s\.streamingMessageId !== null\)/,
    )
  })

  it('reads the chat store with the SAME expression OpusChrome does', () => {
    // Two components, two files, one truth. They are not linked by a prop chain
    // on purpose (see the comment in OpusChrome), so this equality is the only
    // thing keeping the header bar and the frame's lamps from disagreeing about
    // what "a run" is — which is exactly how the FAIL happened: one of them
    // could have been fixed alone and the chassis would still have lied.
    const frame = stripComments(read('components/OpusChrome.tsx'))
    const sel = /useChatStore\(s => [^)]*\)/
    const a = shell.match(sel)?.[0]
    expect(a, 'AppShell has a chat selector').toBeTruthy()
    expect(frame.match(sel)?.[0]).toBe(a)
  })

  it('rides an id that is armed at SEND — the whole reason the OR exists', () => {
    // If this ever stops being true the OR silently degrades back to the ~0ms
    // window that produced the FAIL, and nothing else in the suite would notice.
    const bar = stripComments(read('pages/chat/InputBar.tsx'))
    expect(bar).toContain('setStreamingConversation(activeConversationId)')
    const store = stripComments(read('store/chat.store.ts'))
    expect(store).toContain('setStreamingConversation(id) { set({ streamingConversationId: id }) }')
  })

  it('is a LEAF — self-closing, and it must stay that way', () => {
    // THE CONTAINING-BLOCK TRAP (the maximized-keys saga): the sheet animates
    // this element, and an element carrying an animation / transform / filter
    // becomes the containing block for any `position: fixed` descendant. A leaf
    // has no descendants, so the trap cannot spring — giving it children is the
    // regression this pins.
    const i = shell.indexOf('data-scan-bar')
    const tag = shell.slice(shell.lastIndexOf('<div', i), shell.indexOf('>', i))
    expect(tag.trimEnd().endsWith('/')).toBe(true)
  })

  it('is inert and click-through by default (every theme paints it, none must)', () => {
    const i = shell.indexOf('data-scan-bar')
    const tag = shell.slice(shell.lastIndexOf('<div', i), shell.indexOf('>', i))
    expect(tag).toContain('aria-hidden')
    expect(tag).toMatch(/pointerEvents:\s*'none'/)
    expect(tag).toMatch(/background:\s*'transparent'/)
    // Out of flow, so it costs zero layout on the six themes with no rule for it.
    expect(tag).toMatch(/position:\s*'absolute'/)
    // …and it carries none of the containing-block properties inline either.
    expect(tag).not.toMatch(/transform:/)
    expect(tag).not.toMatch(/filter:/)
    expect(tag).not.toMatch(/animation:/)
  })

  it('never sets position on .app-body itself (that would break the plate)', () => {
    // `[data-chassis] .app-body` is `position: fixed` in globals.css and an
    // inline position here would beat it, un-recessing the whole chassis. The
    // strip resolves against the viewport on non-chassis themes instead, which
    // is invisible either way.
    const bodyIdx = shell.indexOf('className="app-body"')
    expect(bodyIdx).toBeGreaterThan(0)
    expect(shell.slice(bodyIdx, shell.indexOf('>', bodyIdx))).not.toMatch(/position:/)
  })
})

/** The LAMPS array literal, without its type annotation — the annotation is
 *  `readonly {…}[]`, so a naive slice to the first `]` stops inside it. */
const lampManifest = (src: string) => {
  const i = src.indexOf('const LAMPS')
  return src.slice(i, src.indexOf('\n]', i))
}

// ── The header rack (mock option 1b) ─────────────────────────────────────────
describe('header LED rack', () => {
  it('has one cell per lamp in RUN IO NET PRV PWR', () => {
    expect(OPUS_LED_COUNT).toBe(5)
    const src = stripComments(read('components/OpusChrome.tsx'))
    expect((lampManifest(src).match(/name: '/g) ?? []).length).toBe(OPUS_LED_COUNT)
  })

  it('sizes the cell off a FRACTION of the rail, so it survives the flush bezel', () => {
    // A `rail - k` cell outgrows a 10px rail and gets sheared by the rail's own
    // clip-path — the defect the segmented readout already had to fix once.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const rail = opusBezel(stage, vp).y
        const { w, h } = opusLedPx(rail)
        expect(h, `${stage} @ ${vp.height}`).toBeLessThanOrEqual(rail)
        expect(h).toBeGreaterThanOrEqual(3)
        expect(w).toBeGreaterThanOrEqual(h)
      }
    }
    // The mock's own daily panel: a 16 × 6 cell — which is what the thin rim's
    // 30px header rail returns, and what the slab's 24px narrow rail returned.
    expect(opusLedPx(OPUS_BEZEL.narrow.y)).toEqual({ w: 16, h: 6 })
  })

  it('truncates the LEGEND to the bare rack, never the rack to nothing', () => {
    // "chips truncate to their LED bars" — the lamps carry the state, the words
    // only name it, so the words are what goes.
    expect(opusLegendVisible(OPUS_LEGEND_MIN_RAIL_PX)).toBe(true)
    expect(opusLegendVisible(OPUS_LEGEND_MIN_RAIL_PX - 1)).toBe(false)
    // WHAT MOVED WITH THE THIN RIM: the truncation used to fire at the flush
    // STAGE (a 10px slab rail). The rim's rails are 30 / 24, so every stage now
    // prints the words and the degradation is a SHORT-VIEWPORT behaviour — the
    // same ladder, re-triggered by the only thing that still shrinks the rail.
    for (const stage of STAGES) {
      expect(opusLegendVisible(OPUS_BEZEL[stage].y), stage).toBe(true)
    }
    expect(opusLegendVisible(opusBezel('narrow', { width: 1000, height: 240 }).y)).toBe(false)
    // …and the rack itself is drawable at every stage, including flush.
    for (const stage of STAGES) {
      expect(opusLedPx(OPUS_BEZEL[stage].y).h, stage).toBeGreaterThan(0)
    }
  })
})

// ── The RUN lamp is STATE, not decoration ────────────────────────────────────
describe('OpusChrome wires its lamps to the real run signal', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('reads the same three stores AppShell ORs into the scan-bar boolean', () => {
    expect(src).toContain('chassisRunActive')
    expect(src).toMatch(/useAgentStore\(s => s\.status\)/)
    // Same named selector as AppShell — the lamps and the scan bar must never
    // disagree about what "a run" is, and `nodesRunActive` is that one answer.
    expect(src).toMatch(/useNodesRunStore\(nodesRunActive\)/)
    // Byte-identical to AppShell's chat selector — the frame's lamps and the
    // header's bar must never disagree about what "a run" is.
    expect(src).toMatch(
      /useChatStore\(s => s\.streamingConversationId !== null \|\| s\.streamingMessageId !== null\)/,
    )
  })

  it('never hardcodes a lit RUN lamp or a breathing readout cell', () => {
    // The regression: both were unconditional, so the instrument claimed a run
    // was in flight every second the app was open. `runActive` must gate the
    // animation on BOTH — a lamp that is always lit is a sticker.
    const seg = src.slice(src.indexOf('function SegmentReadout'), src.indexOf('function LampBlock'))
    expect(seg).toContain('runActive')
    expect(seg).toMatch(/const live = runActive &&/)
    // Every animation in the readout hangs off `live`, never off the index alone.
    expect(seg).toMatch(/animation: live \?/)
    const lamp = src.slice(src.indexOf('function LampBlock'), src.indexOf('function DragBands'))
    // WHAT MOVED (2026-07-27 lamp-honesty audit): the lamp block no longer knows
    // what a run IS. It looks its cell up in the readings record, so `runActive`
    // reaches it as `lamps.run` and nothing else in the block can invent a lit
    // state. The RUN cell is still the only one that blinks, and still only
    // while it is lit.
    expect(lamp).toMatch(/const lit = lamps\[lamp\.mode\]/)
    expect(lamp).toMatch(/animation: lamp\.name === 'RUN' && lit/)
    expect(lamp).not.toMatch(/mode === 'on'/)
  })

  it('gives every rack cell a SIGNAL and leaves no always-on mode', () => {
    // The manifest is the whole audit surface: a cell names the reading that
    // lights it, and `'on'` — the mode that lit GPU and PWR unconditionally —
    // does not exist any more. PWR is still constant, but it is constant in the
    // READINGS (`pwr: true`, a claim entailed by the cell being on screen), not
    // in the manifest, so the manifest can never light anything by itself.
    const lamps = lampManifest(src)
    expect(lamps).toMatch(/name: 'RUN',\s*mode: 'run'/)
    expect(lamps).toMatch(/name: 'IO',\s*mode: 'io'/)
    expect(lamps).toMatch(/name: 'NET',\s*mode: 'net'/)
    expect(lamps).toMatch(/name: 'PRV',\s*mode: 'prv'/)
    expect(lamps).toMatch(/name: 'PWR',\s*mode: 'pwr'/)
    expect(lamps).not.toContain("mode: 'on'")
    expect(lamps).not.toContain("mode: 'dead'")
    // …and every mode in the manifest is a key of the readings type.
    const modes = [...lamps.matchAll(/mode: '(\w+)'/g)].map(m => m[1]).sort()
    expect(modes).toEqual(['io', 'net', 'prv', 'pwr', 'run'])
  })

  it('takes each reading from the store that owns it, and never from a timer', () => {
    // THE STANDING RULE for this file: the chrome is mounted for the life of the
    // app, so a poll here is a poll forever. Every lamp is a subscription, a
    // platform event, or a constant.
    expect(src).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
    // IO — the download manager's own queue, through the shared refcounted
    // subscription (idempotent: the DownloadStrip arms the same one).
    expect(src).toMatch(/useDownloadsStore\(s => opusDownloadActive\(s\.items\)\)/)
    expect(src).toMatch(/useDownloadsStore\.getState\(\)\.init\(\)/)
    // NET — navigator.onLine plus the two events that move it. No fetch, no ping.
    expect(src).toContain('navigator.onLine')
    expect(src).toMatch(/addEventListener\('online', sync\)/)
    expect(src).toMatch(/addEventListener\('offline', sync\)/)
    expect(src).toMatch(/removeEventListener\('online', sync\)/)
    expect(src).toMatch(/removeEventListener\('offline', sync\)/)
    // PRV — one boolean off the persisted privacy store.
    expect(src).toMatch(/usePrivacyStore\(s => s\.mode === 'private'\)/)
    // PWR — the one constant, and it is in the readings, not in the manifest.
    expect(src).toMatch(/pwr: true/)
  })

  it('lights the readout from the CTX reading, cell by cell', () => {
    // SEG_LIT is gone: ten cells with six of them hardcoded lit was an
    // instrument face showing a number nothing had measured.
    expect(src).not.toContain('SEG_LIT')
    expect(src).toMatch(/i < level \? 'var\(--opus-signal/)
    expect(src).toMatch(/opusSegmentLevel\(opusContextChars\(s\.messages\) \/ 4 \/ ctxWindowTokens\)/)
  })

  it('reads CTX from the SAME source as the sidebar gauge — one number, two surfaces', () => {
    // The frame lights a ladder and the sidebar prints a percentage; if the two
    // ever drift, the chassis contradicts itself three inches apart (the exact
    // failure the bay stencils were fixed for). The equality is pinned on both
    // halves of the estimate: the DENOMINATOR and the four event fields the
    // numerator counts.
    //
    // The denominator used to be `DEFAULT_MAX_TOKENS` on both sides — a flat 32k
    // for every model, consistent and consistently wrong (2026-08-02: a Venice
    // 200k model read as five times fuller than it was). It is now the ROUTED
    // MODEL's published window, from the one hook both surfaces call.
    const panel = stripComments(read('components/ChassisSidebarPanel.tsx'))
    expect(panel).toContain('useAgentContextWindow()')
    expect(src).toContain('useAgentContextWindow()')
    expect(panel).not.toContain('DEFAULT_MAX_TOKENS')
    expect(src).not.toContain('DEFAULT_MAX_TOKENS')
    for (const file of [panel, stripComments(read('components/opus/opusChrome.helpers.ts'))]) {
      for (const field of ['text', 'input', 'output', 'message']) {
        expect(file, `${field} not counted`).toContain(`typeof ev.${field} === 'string'`)
      }
    }
    // Both import the denominator from the store that owns it — a second copy of
    // the resolution in either file would be a silent fork of the same reading.
    expect(src).toMatch(/import \{[^}]*useAgentContextWindow[^}]*\} from '\.\.\/store\/agent\.store'/)
    // AND both honour "no published window" instead of substituting one: the
    // ladder goes dark, the sidebar row disappears.
    expect(src).toContain('ctxWindowTokens === null')
    expect(panel).toContain('ctxWindowTokens === null')
  })
})

// ── The rack's readings, as truth tables ─────────────────────────────────────
// The lamps are wired at the source level above; these are the pure halves —
// what "IO is lit" and "the ladder is at 6" actually mean, with no DOM.
describe('opusDownloadActive (the IO lamp)', () => {
  it('is dark with no queue at all', () => {
    expect(opusDownloadActive([])).toBe(false)
    expect(opusDownloadActive(null)).toBe(false)
    expect(opusDownloadActive(undefined)).toBe(false)
    // A bridge-less host hands back whatever it has; an unreadable queue is not
    // activity (the store itself normalises, this is the belt).
    expect(opusDownloadActive([null, undefined, {}])).toBe(false)
  })

  it('lights for bytes moving, queued work and the verify pass', () => {
    for (const state of OPUS_IO_STATES) {
      expect(opusDownloadActive([{ state }]), state).toBe(true)
    }
    expect(OPUS_IO_STATES).toEqual(['queued', 'active', 'verifying'])
  })

  it('goes dark on every SETTLED row — the lamp must not outlive the transfer', () => {
    for (const state of ['paused', 'done', 'error']) {
      expect(opusDownloadActive([{ state }]), state).toBe(false)
    }
    // …and one live row among settled ones still lights it.
    expect(opusDownloadActive([{ state: 'done' }, { state: 'error' }, { state: 'active' }])).toBe(true)
  })
})

describe('the CTX ladder (opusContextChars / opusSegmentLevel)', () => {
  const msg = (event: unknown) => ({ event })

  it('counts the same four event fields the sidebar CTX row counts', () => {
    expect(opusContextChars([
      msg({ text: 'abcd' }), msg({ input: 'ab' }), msg({ output: 'a' }), msg({ message: 'abc' }),
    ])).toBe(10)
    // One event can carry several of them.
    expect(opusContextChars([msg({ text: 'ab', output: 'cd' })])).toBe(4)
  })

  it('is total — a missing log, a null row or a foreign event reads as zero', () => {
    expect(opusContextChars(null)).toBe(0)
    expect(opusContextChars(undefined)).toBe(0)
    expect(opusContextChars([])).toBe(0)
    expect(opusContextChars([null, undefined, {}, msg(null), msg({ kind: 'tool' })])).toBe(0)
    // Non-string fields are not lengths and must never be added.
    expect(opusContextChars([msg({ text: 42, input: { a: 1 } })])).toBe(0)
  })

  it('shows an EMPTY ladder for an empty session, not a token cell', () => {
    expect(opusSegmentLevel(0)).toBe(0)
    expect(opusSegmentLevel(-1)).toBe(0)
    expect(opusSegmentLevel(Number.NaN)).toBe(0)
  })

  it('lights at least one cell for any real reading, and saturates at the top', () => {
    // Rounding a genuine 2% session down to a dark ladder is the same lie as
    // lighting six cells of nothing, in the other direction.
    expect(opusSegmentLevel(0.001)).toBe(1)
    expect(opusSegmentLevel(0.5)).toBe(5)
    expect(opusSegmentLevel(1)).toBe(OPUS_SEG_COUNT)
    expect(opusSegmentLevel(4)).toBe(OPUS_SEG_COUNT)
    expect(OPUS_SEG_COUNT).toBe(10)
  })

  it('is monotonic across the whole range (a gauge, not a lookup table)', () => {
    let prev = 0
    for (let i = 0; i <= 100; i++) {
      const v = opusSegmentLevel(i / 100)
      expect(v, `${i}%`).toBeGreaterThanOrEqual(prev)
      expect(v).toBeLessThanOrEqual(OPUS_SEG_COUNT)
      prev = v
    }
  })
})

// ── The blur pause (GROUP T) ─────────────────────────────────────────────────
// AppShell publishes `data-window-focused` on :root — PRESENT while the window
// has focus, ABSENT while it does not (its "IDLE GATE" comment is the contract).
// The chassis is the app's only forever-animating surface, and on a second
// monitor it is visible and unfocused for hours: nothing throttles it, because
// Electron's backgroundThrottling only covers a page the compositor has stopped
// showing. This is the sheet's half of that gate.
describe('OPUS-5 pauses its own motion while the window is blurred', () => {
  const THEMES = path.resolve(SRC, 'themes')
  const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))

  it('consumes the AppShell contract as a :not(), never a "0" value', () => {
    // Present-or-absent has exactly two states and degrades to PAUSED in any
    // environment that never fires `focus` — the safe direction. A `="0"` form
    // would need the attribute to exist to work at all.
    expect(css).toContain(':not([data-window-focused])')
    expect(css).not.toContain('data-window-focused="0"')
    const shell = read('components/layout/AppShell.tsx')
    expect(shell).toContain("root.setAttribute('data-window-focused', '1')")
    expect(shell).toContain("root.removeAttribute('data-window-focused')")
  })

  it('pauses the FRAME and nothing else — scoped per chassis, never globally', () => {
    const paused = css
      .split('}')
      .flatMap(block => {
        const i = block.indexOf('{')
        return i === -1 ? [] : [{ selector: block.slice(0, i).trim(), body: block.slice(i + 1) }]
      })
      .filter(r => r.body.includes('animation-play-state'))
    expect(paused.length).toBeGreaterThan(0)
    for (const r of paused) {
      // Both halves of the scope on every selector: this theme, and the frame.
      expect(r.selector, r.selector).toContain(':root[data-theme="tachi-opus5"]')
      expect(r.selector, r.selector).toContain(':not([data-window-focused])')
      expect(r.selector, r.selector).toContain('.opus-chassis')
      expect(r.body).toMatch(/animation-play-state:\s*paused\s*!important/)
    }
    // …and the class it scopes to is really the frame's root, not a guess.
    expect(stripComments(read('components/OpusChrome.tsx'))).toContain('className="opus-chassis"')
  })

  it('composes with reduced motion instead of fighting it', () => {
    // The kill switch stays the LAST thing in the file (house rule), and it
    // clears `animation` outright — so under reduced motion there is nothing
    // left for the pause to hold. The two never contend for the same longhand
    // with opposite intents.
    const raw = fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8')
    expect(raw.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
      .toBeGreaterThan(raw.lastIndexOf('animation-play-state'))
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion'))
    expect(rm).not.toContain('animation-play-state')
  })

  it('leaves the scan bar\'s own rules byte-identical', () => {
    // GROUP R is pinned elsewhere in this file (one idle rule, one running rule,
    // one animation name). The pause must not add a third scan-bar rule — the
    // strip only ever animates while a run is genuinely in flight, and its
    // gating is the shared lane's, not this one's.
    const barRules = css
      .split('}')
      .flatMap(block => {
        const i = block.indexOf('{')
        return i === -1 ? [] : [block.slice(0, i)]
      })
      .filter(sel => sel.includes('[data-scan-bar]'))
    expect(barRules.length).toBe(3)   // idle · running · the reduced-motion kill
  })
})

// ── The engraving is anchored to the STAGE INTERIOR ──────────────────────────
describe('crab engraving anchoring + the 1c burr', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('starts BOTH coordinates at the bezel, never at the viewport', () => {
    // The mock's caption is the contract: "the crab moves inside the stage as an
    // engraving, so the window edge can never eat it". An anchor that started at
    // 0 (or at a raw `right: N`) is exactly how the retired crab theme got its
    // claws sliced by the screen edge.
    const eng = src.slice(src.indexOf('function Engraving'))
    expect(eng).toMatch(/right: bezel\.x \+ inset/)
    expect(eng).toMatch(/top: bezel\.y \+/)
    // …and it is inset from the plate edge on top of the bezel.
    expect(eng).toContain('inset')
    expect(src).toContain('opusEngraveInsetPx(bezel)')
  })

  it('strikes the silhouette twice — the groove and its 2px burr', () => {
    expect(OPUS_ENGRAVE_BURR_PX).toBe(2)
    // Two <Engraving> renders, one of them `burr` — same component, so the
    // silhouette, the size and the anchor can never drift apart.
    expect((src.match(/<Engraving/g) ?? []).length).toBe(2)
    expect(src).toMatch(/<Engraving\s+burr/)
    expect(src).toMatch(/const ENGRAVE_BURR_INK\s*=/)
    // The burr is a DISPLACEMENT of the same mark, not a shadow: this file bans
    // drop-shadow, and a shadow would trace the mask's alpha anyway.
    expect(src).toMatch(/const nudge = burr \? OPUS_ENGRAVE_BURR_PX : 0/)
  })

  it('stays click-through and out of the drag region', () => {
    const eng = src.slice(src.indexOf('function Engraving'))
    expect(eng).toMatch(/\.\.\.LAYER, \.\.\.NO_DRAG/)
  })
})

// ── Window drag ──────────────────────────────────────────────────────────────
describe('the chassis is the window handle', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('leaves a non-draggable strip on the outer edge for the resize border', () => {
    // A drag region painted to the window edge ships a window that moves but
    // never resizes (Windows keeps a native resize border there — thickFrame).
    expect(OPUS_DRAG_EDGE_PX).toBeGreaterThanOrEqual(4)
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const b = opusBezel(stage, vp)
        expect(opusDragBandPx(b.y), `${stage} @ ${vp.height}`).toBeLessThan(b.y)
        expect(opusDragBandPx(b.x)).toBeLessThan(b.x)
        expect(opusDragBandPx(b.y)).toBeGreaterThanOrEqual(0)
      }
    }
    // Below the strip width the band is ZERO — the resize edge always wins.
    expect(opusDragBandPx(OPUS_DRAG_EDGE_PX)).toBe(0)
    expect(opusDragBandPx(OPUS_DRAG_EDGE_PX - 5)).toBe(0)
  })

  it('publishes drag on the rails and no-drag on every control', () => {
    expect(src).toMatch(/const DRAG[^=]*=\s*\{[^}]*'drag'/)
    expect(src).toMatch(/const NO_DRAG[^=]*=\s*\{[^}]*'no-drag'/)
    // The key caps opt out through the ONE constant every key already spreads,
    // so a new key cannot be added without it.
    expect(src).toMatch(/const KEY_HIT[^=]*=\s*\{[^}]*\.\.\.NO_DRAG/)
    // The key WELL opts out too: the caps sit inside it, and a drag region
    // swallows clicks on anything that does not subtract itself.
    const keysFn = src.slice(src.indexOf('function OpusKeys'))
    expect(keysFn).toMatch(/\.\.\.LAYER, \.\.\.NO_DRAG/)
  })

  it('drags from the top rail and both flanks, never the bottom rail', () => {
    const bands = src.slice(src.indexOf('function DragBands'))
    // top + left + right, and nothing anchored to the bottom edge.
    expect((bands.match(/\.\.\.DRAG/g) ?? []).length).toBe(3)
    expect(bands).toMatch(/top: e, left: e, right: e/)
    expect(bands).toMatch(/left: e, width: bandX/)
    expect(bands).toMatch(/right: e, width: bandX/)
    expect(bands).not.toMatch(/bottom: e/)
    // The header row is a grab surface in its own right (it IS the title bar).
    const header = src.slice(src.indexOf('function HeaderRow'), src.indexOf('function SegmentReadout'))
    expect(header).toMatch(/\.\.\.LAYER, \.\.\.DRAG/)
  })
})

// ── Pincer SEND (mock option 1e) ─────────────────────────────────────────────
// The hooks live in two SHARED composers, so the guard has two halves: the
// components must publish the jaws, and no sheet but OPUS-5's may dress them —
// the default look of those buttons has to survive pixel-identically.
describe('pincer SEND hooks', () => {
  const COMPOSERS: Array<[string, string]> = [
    ['pages/chat/InputBar.tsx', 'chat'],
    ['pages/agent/AgentPage.tsx', 'agent'],
  ]

  for (const [rel, name] of COMPOSERS) {
    describe(name, () => {
      const src = stripComments(read(rel))

      it('publishes the hook on the send button and exactly two jaws', () => {
        expect((src.match(/data-pincer-send/g) ?? []).length).toBe(1)
        expect((src.match(/data-jaw="t"/g) ?? []).length).toBe(1)
        expect((src.match(/data-jaw="b"/g) ?? []).length).toBe(1)
      })

      it('keeps the jaws LEAF spans — the containing-block law', () => {
        // A jaw is transformed by the sheet, and a transformed element becomes
        // the containing block for any `position: fixed` descendant (the trap
        // that ate the maximized window keys). The top jaw may hold the LABEL
        // and nothing else; the bottom jaw is self-closing and empty.
        expect(src).toMatch(/<span data-jaw="b"\s*\/>/)
        const t = src.slice(src.indexOf('<span data-jaw="t">'))
        const inner = t.slice(t.indexOf('>') + 1, t.indexOf('</span>'))
        expect(inner).not.toContain('<')
      })

      it('carries the label INSIDE the top jaw, so no chassis means no change', () => {
        // With no chassis sheet loaded these spans are unstyled inline boxes and
        // the button renders exactly as it did — that is the whole contract.
        const i = src.indexOf('<span data-jaw="t">')
        expect(i).toBeGreaterThan(0)
        expect(src.slice(i, src.indexOf('</span>', i))).toMatch(/\S/)
      })
    })
  }

  describe('only the OPUS-5 sheet dresses them', () => {
    const THEMES = path.resolve(SRC, 'themes')
    const sheets = fs.readdirSync(THEMES).filter(f => f.endsWith('.css'))

    it('no other theme sheet — or globals.css — targets the jaws', () => {
      expect(stripCss(fs.readFileSync(path.join(SRC, 'globals.css'), 'utf8')))
        .not.toContain('data-jaw')
      for (const f of sheets) {
        if (f === 'tachi-opus5-structure.css') continue
        const css = stripCss(fs.readFileSync(path.join(THEMES, f), 'utf8'))
        expect(css, `${f} dresses the pincer`).not.toContain('data-jaw')
        expect(css, `${f} dresses the pincer`).not.toContain('data-pincer-send')
      }
    })

    it('cuts the V-notch into the JAWS and clears it from the button', () => {
      const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))
      // The mock's two polygons, transcribed.
      expect(css).toContain('polygon(0 0, 100% 0, 100% 100%, 14px 100%, 0 60%)')
      expect(css).toContain('polygon(14px 0, 100% 0, 100% 100%, 0 100%, 0 40%)')
      expect(css).toMatch(/\[data-jaw="b"\][^}]*height:\s*18px/)
      // GROUP B's bite clips the BUTTON box and would shear the jaws off as
      // they part, so it has to be cleared — and cleared by a selector that
      // actually outranks it (`button[data-pincer-send]`, not the bare attr).
      expect(css).toMatch(/button\[data-pincer-send\][^}]*clip-path:\s*none/)
    })

    it('parts the jaws 3px on hover and SNAPS them shut on press, in 140ms', () => {
      const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))
      expect(css).toMatch(/\[data-jaw\][^}]*transition:\s*transform 140ms/)
      expect(css).toMatch(/:hover \[data-jaw="t"\] \{ transform: translateY\(-3px\)/)
      expect(css).toMatch(/:hover \[data-jaw="b"\] \{ transform: translateY\(3px\)/)
      expect(css).toMatch(/:active \[data-jaw="t"\] \{ transform: translateY\(1px\)/)
      expect(css).toMatch(/:active \[data-jaw="b"\] \{ transform: translateY\(-1px\)/)
      // No springs: one duration, one easing, nothing else animated.
      expect(css).not.toMatch(/\[data-jaw\][^}]*transition:[^;}]*(?:width|height|opacity)/)
    })

    // ── The claw's proportions (mock 1e) ────────────────────────────────────
    // The composer stretches this button to the whole row (~94px on CHAT). The
    // V-notch is a FIXED 14px cut, so a 74px upper jaw turned the diagonal into
    // a near-vertical scratch and the claw read as two slabs — driver-verified
    // on the installed build, and the 46px CODE instance reading correctly is
    // the tell. Mock 1e draws the whole claw in a 64px row (L1301) over an 18px
    // lower jaw (L1305): 64 − 18 − 2 seam = 44 of upper jaw.
    it('caps the JAWS at the mock 1e geometry and leaves the hit target alone', () => {
      const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))
      expect(css).toMatch(/\[data-jaw="t"\][^}]*max-height:\s*44px/)
      // The travel-stop is a constant, not a shrinkable flex item.
      expect(css).toMatch(/\[data-jaw="b"\][^}]*flex-shrink:\s*0/)
      // The cap only works if the short claw is CENTRED in the tall button —
      // otherwise it parks against the top edge of the composer row.
      expect(css).toMatch(/button\[data-pincer-send\][^}]*justify-content:\s*center/)
      // …and the button itself is NOT capped: the click area stays the full row.
      expect(css).not.toMatch(/button\[data-pincer-send\][^}]*max-height/)
    })

    // ── The button carries no transform (GROUP S's own law) ─────────────────
    // The composer's send button has an INLINE `transform: translate(1px, 1px)`
    // on hover — the sink-into-its-own-shadow press every other theme wants. On
    // the chassis it moved the whole claw at the same time as the jaws parted
    // (so the bite double-moved) AND re-opened the containing-block trap the
    // GROUP S comment exists to close. Neutralised in the sheet, not deleted at
    // the source, so no other theme loses its press.
    it('keeps the pincer button transform-free', () => {
      const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))
      expect(css).toMatch(/button\[data-pincer-send\][^}]*transform:\s*none\s*!important/)
      // The inline style it neutralises is still there for everyone else.
      const bar = read('pages/chat/InputBar.tsx')
      expect(bar).toContain("transform: sendHovered ? 'translate(1px, 1px)' : 'none'")
    })

    it('kills the travel under reduced motion', () => {
      const css = stripCss(fs.readFileSync(path.join(THEMES, 'tachi-opus5-structure.css'), 'utf8'))
      const rm = css.slice(css.indexOf('@media (prefers-reduced-motion'))
      expect(rm).toMatch(/\[data-jaw\][^}]*transition:\s*none\s*!important/)
      // …and the two-line follow-up from the scan-bar batch: the typing dot now
      // shares the pulse dot's glow treatment AND its kill switch.
      expect(css).toContain('.tachi-typing-dot')
      expect(rm).toContain('.tachi-typing-dot')
    })
  })
})

// ── The same rule, on the TK-05 side ────────────────────────────────────────
describe('TachikomaChrome.tsx shares the attribute the same way', () => {
  const src = stripComments(read('components/TachikomaChrome.tsx'))
  it('also no-ops its effect while inactive', () => {
    expect(src).toMatch(/if\s*\(!stage\)\s*return\b/)
  })
})

// ── The claw-notch run bar · mock option 1f (GROUP R) ────────────────────────
// 1f's recipe, in the label's own words: "Milled tick marks give it a
// machinist's scale; the leading edge is a closing pincer, not a flat wall; the
// signal sweep is the only ambient motion in the theme." Each clause below is
// one test, because each one is a thing a later edit can quietly undo:
// re-cadencing the ticks, squaring the leading edge back into a wall, or adding
// a second animation to a theme whose whole claim is that only one thing moves.
describe('OPUS-5 run bar is the 1f instrument (GROUP R)', () => {
  const THEMES = path.resolve(SRC, 'themes')
  const readSheet = (name: string) => stripCss(fs.readFileSync(path.join(THEMES, name), 'utf8'))
  const css = readSheet('tachi-opus5-structure.css')
  const rmIdx = css.indexOf('@media (prefers-reduced-motion')
  const rm = css.slice(rmIdx)

  /** Declaration blocks in the dressing half whose selector names the strip. */
  const barRules = css
    .slice(0, rmIdx)
    .split('}')
    .flatMap((block) => {
      const i = block.indexOf('{')
      return i === -1 ? [] : [{ selector: block.slice(0, i).trim(), body: block.slice(i + 1) }]
    })
    .filter((r) => r.selector.includes('[data-scan-bar]'))
  const idle = barRules.filter((r) => !r.selector.includes('data-run-active'))
  const running = barRules.filter((r) => r.selector.includes('[data-run-active="1"]'))

  it('mills BOTH states on ONE 11px-cell / 13px-pitch machinist scale', () => {
    // Mock 1f L1318 cuts the ticks at `transparent 0 11px, rgba(0,0,0,.4) 11px
    // 13px`; the 1b frame's dead rack (L1217) is the olive underneath. They are
    // held to the SAME pitch on purpose — two cadences over one strip beat
    // against each other and read as a rendering fault, not as a scale.
    expect(idle).toHaveLength(1)
    expect(running).toHaveLength(1)
    for (const r of [...idle, ...running]) {
      expect(r.body, r.selector).toContain('rgba(0, 0, 0, 0) 0 11px, rgba(0, 0, 0, 0.55) 11px 13px')
      expect(r.body, r.selector).toContain('#22300a 0 11px, rgba(0, 0, 0, 0) 11px 13px')
    }
    // The grooves are the FIRST background layer, i.e. the TOP one, so the scale
    // is milled THROUGH the lit fill instead of being buried under it.
    const img = running[0].body.slice(running[0].body.indexOf('background-image'))
    expect(img.indexOf('rgba(0, 0, 0, 0.55)')).toBeLessThan(img.indexOf('conic-gradient'))
  })

  it('gives the lit group a CLOSING PINCER leading edge, only while a run is live', () => {
    expect(running[0].body).toContain('conic-gradient(')
    expect(running[0].body).toContain('at 100% 50%')          // apex ON the leading edge
    expect(running[0].body).toMatch(/background-size:[^;]*22% 100%/)
    // Idle is the bare rack: a claw notch with nothing running is decoration.
    expect(idle[0].body).not.toContain('conic-gradient')
    // …and it is the sheet's only one, so "the leading edge" stays singular.
    expect((css.match(/conic-gradient\(/g) ?? []).length).toBe(1)
  })

  it('cuts the notch 12px deep — the angles ARE the mock polygon', () => {
    // Mock 1f L1317: polygon(0 0, calc(100% - 12px) 0, 100% 50%,
    // calc(100% - 12px) 100%, 0 100%). Painted as a conic wedge instead of a
    // clip-path (which would need a child), the SAME geometry is two angles: a
    // boundary ray θ off horizontal falls half the band's height over the notch
    // depth. Change the band height without re-deriving them and the notch stops
    // being 12px — this is that derivation, run against the shipped numbers.
    const height = Number(/height:\s*(\d+)px/.exec(idle[0].body)![1])
    const seam = Number(/border-bottom:\s*(\d+)px/.exec(idle[0].body)![1])
    const band = height - seam                      // the background positioning area
    expect(band).toBe(14)                           // 1b frame L1216: a 14px band + a 2px seam
    const theta = (Math.atan(band / 2 / 12) * 180) / Math.PI
    expect(running[0].body).toContain(`${(270 - theta).toFixed(2)}deg`)
    expect(running[0].body).toContain(`${(270 + theta).toFixed(2)}deg`)
  })

  it('moves ONE thing, and reduced motion kills every name it starts', () => {
    const names = new Set(
      barRules.flatMap((r) => [...r.body.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1])),
    )
    // "The signal sweep is the only ambient motion in the theme."
    expect([...names]).toEqual(['opus5-scan'])
    for (const n of names) expect(css).toContain(`@keyframes ${n}`)
    expect(rm).toMatch(/\[data-scan-bar\][^{]*\{[^}]*animation:\s*none\s*!important/)
    // The kill is a blanket `animation: none` on the strip itself, so it covers
    // any name GROUP R ever starts — and it must not take the PAINT with it: the
    // milled rack and the lit group still have to read with the travel stopped.
    const killed = rm.slice(rm.indexOf('[data-scan-bar]'))
    expect(killed.slice(0, killed.indexOf('}'))).not.toContain('background')
  })

  it('stays a childless, click-through leaf — the 1f shape needed no inner leaves', () => {
    // The containing-block trap again (the maximized-keys saga). Painting the
    // pincer as a background layer instead of clipping a child is what keeps
    // this true, so the two halves are pinned together here.
    const shell = stripComments(read('components/layout/AppShell.tsx'))
    const i = shell.indexOf('data-scan-bar')
    const tag = shell.slice(shell.lastIndexOf('<div', i), shell.indexOf('>', i))
    expect(tag.trimEnd().endsWith('/')).toBe(true)
    expect(tag).toMatch(/pointerEvents:\s*'none'/)
    // GROUP R never reaches THROUGH the strip either: every selector ENDS on it,
    // so no rule is waiting for a child that must not exist.
    for (const r of barRules) {
      expect(
        r.selector.endsWith('[data-scan-bar]') || r.selector.endsWith('[data-run-active="1"]'),
        r.selector,
      ).toBe(true)
    }
  })

  it('takes its 16px of layout on THIS theme only — no other sheet touches the strip', () => {
    // The element is inline-absolute at 2px, which is right for the six themes
    // that never dress it. GROUP R puts it in flow because a 16px instrument
    // left absolute would paint over the title bar or over the page header; that
    // cost must not leak to a theme that draws no instrument at all.
    expect(idle[0].body).toMatch(/position:\s*relative\s*!important/)
    expect(idle[0].body).toMatch(/flex-shrink:\s*0/)
    for (const f of fs.readdirSync(THEMES).filter((f) => f.endsWith('.css'))) {
      if (f === 'tachi-opus5-structure.css') continue
      expect(readSheet(f), f).not.toContain('data-scan-bar')
    }
  })
})

// ── The frame's own pincer bite (2026-07-27 acid retheme) ────────────────────
// PATCH-01's caption is "the pincer profile is the corner bite cut into every
// control", and the frame — the biggest control in the app — was the one
// exception: four symmetric chamfers, i.e. a bevel that says nothing. It now
// takes GROUP B's asymmetric cut: a stepped notch out of the top-left, a 45°
// chamfer off the bottom-right, the other two corners square, and both cuts
// terminating on an acid rim.
//
// THE INVARIANT THAT MAKES IT CHEAP: both bitten corners are wholly inside the
// two RAILS (the flanks are inset by the rail height), so the flanks stay
// unclipped and the drag/resize bands — separate siblings — never see a
// clip-path at all. That only holds while `notch + rim <= bezel.y`, which is
// what the first test here pins at every stage and viewport.
describe('the frame bite (opusFrameBitePx)', () => {
  it('keeps the whole cut, rim included, inside the rail it is milled into', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        const bite = opusFrameBitePx(bezel)
        const core = opusFrameCorePx(bite)
        const label = `${stage} @ ${vp.width}×${vp.height}`
        expect(bite.notch + bite.rim, label).toBeLessThanOrEqual(bezel.y)
        expect(core.notch, label).toBeLessThanOrEqual(bezel.y)
        expect(opusFrameCoreChamferPx(bite), label).toBeLessThanOrEqual(bezel.y)
      }
    }
  })

  it('cuts the BOTTOM chamfer from the hint rail, not the header rail', () => {
    // The two rails are different thicknesses now, and the bite is derived from
    // the rail it is milled into. Feeding the 30px header's 17px notch to a 24px
    // bar is exactly the "sheared by the metal's own edge" failure this helper
    // exists to prevent — the chamfer plus its acid rim has to fit in the FOOT.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bezel = opusBezel(stage, vp)
        const foot = opusFrameBitePx({ x: bezel.x, y: bezel.bottom })
        const label = `${stage} @ ${vp.width}×${vp.height}`
        expect(foot.notch + foot.rim, label).toBeLessThanOrEqual(bezel.bottom)
        expect(opusFrameCoreChamferPx(foot), label).toBeLessThanOrEqual(bezel.bottom)
        expect(foot.rim, label).toBeGreaterThanOrEqual(1)
        expect(foot.step, label).toBeLessThan(foot.notch)
      }
    }
    // …and it is genuinely a SMALLER cut than the header's, at the nominal
    // table: a 13px chamfer under a 17px notch at wide/mid/narrow.
    expect(opusFrameBitePx({ x: 16, y: OPUS_BEZEL.narrow.y }).notch).toBe(17)
    expect(opusFrameBitePx({ x: 16, y: OPUS_BEZEL.narrow.bottom }).notch).toBe(13)
  })

  it('is a STAIRCASE, not a square — two cuts, the claw jaw', () => {
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        const bite = opusFrameBitePx(opusBezel(stage, vp))
        expect(bite.notch, `${stage} @ ${vp.width}`).toBeGreaterThan(0)
        expect(bite.step).toBeGreaterThanOrEqual(2)
        expect(bite.step).toBeLessThan(bite.notch)
      }
    }
  })

  it('always terminates on acid — the rim is never zero on a real rail', () => {
    // The rim IS the "the frame has to end on the acid" half of the owner's
    // note: it is the only place the signal-filled layer under each bitten rail
    // is visible. A zero rim silently ships the cut as bare dark metal.
    for (const stage of STAGES) {
      for (const vp of VIEWPORTS) {
        expect(opusFrameBitePx(opusBezel(stage, vp)).rim, `${stage} @ ${vp.height}`)
          .toBeGreaterThanOrEqual(1)
      }
    }
    // The metal's cut is the acid's cut GROWN by exactly the rim on the
    // axis-aligned faces, and by rim·√2 on the 45° one — that difference is
    // what makes the visible band a uniform width on both corners.
    const bite = opusFrameBitePx(OPUS_BEZEL.wide)
    expect(opusFrameCorePx(bite).notch).toBe(bite.notch + bite.rim)
    expect(opusFrameCorePx(bite).step).toBe(bite.step + bite.rim)
    expect(opusFrameCoreChamferPx(bite)).toBe(bite.notch + Math.round(bite.rim * Math.SQRT2))
  })

  it('scales with the rail and stops before the corner goes missing', () => {
    const wide = opusFrameBitePx(opusBezel('wide', { width: 1920, height: 1080 }))
    const flush = opusFrameBitePx(opusBezel('flush', { width: 1920, height: 1080 }))
    expect(wide.notch).toBeGreaterThan(flush.notch)
    expect(wide.notch).toBeLessThanOrEqual(OPUS_FRAME_BITE_MAX_PX)
    // …and it degraded GRACEFULLY when the rail was cut from 62px to 30: the
    // bite is a fraction of the rail, so it is a 17px notch on the header rail
    // and still a staircase with a 2px rim on a rail clamped down to 16.
    expect(wide.notch).toBe(17)
    const clamped = opusFrameBitePx({ x: 16, y: 16 })
    expect(clamped.notch + clamped.rim).toBeLessThanOrEqual(16)
    expect(clamped.step).toBeLessThan(clamped.notch)
    expect(clamped.rim).toBeGreaterThanOrEqual(1)
    // A 62px rail must not cut a 34px hole out of the window's corner.
    expect(opusFrameBitePx({ x: 300, y: 400 }).notch).toBe(OPUS_FRAME_BITE_MAX_PX)
  })

  it('runs out of metal instead of overflowing on a degenerate rail', () => {
    // Not reachable through opusBezel (its floor is 8), but the helper is
    // pure and public: it sheds the part rather than shearing it, the same rule
    // the ruler and the rack legend follow.
    for (const y of [0, 1, 2, 3]) {
      const bite = opusFrameBitePx({ x: 10, y })
      expect(bite.notch + bite.rim, `y=${y}`).toBeLessThanOrEqual(y)
      expect(bite.notch).toBeGreaterThanOrEqual(0)
      expect(bite.step).toBeLessThanOrEqual(Math.max(0, bite.notch - 1))
    }
  })
})

describe('OpusChrome frame corners (source guards)', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('cuts the notch on the TOP rail and the chamfer on the BOTTOM one', () => {
    // One helper per cut, used twice each (rim + metal), so the acid layer and
    // the metal over it can never drift into two different shapes.
    expect(src).toMatch(/function notchPath\(/)
    expect(src).toMatch(/function chamferPath\(/)
    expect((src.match(/notchPath\(/g) ?? []).length).toBe(3)   // 1 decl + 2 uses
    expect((src.match(/chamferPath\(/g) ?? []).length).toBe(3)
    expect(src).toContain('clipPath: notchPath(bite.notch, bite.step)')
    expect(src).toContain('clipPath: notchPath(core.notch, core.step)')
    // The bottom pair reads the FOOT's bite — the hint rail is 6px thinner than
    // the header, so the header's notch would be cut past the metal it has.
    expect(src).toContain('clipPath: chamferPath(footBite.notch)')
    expect(src).toContain('clipPath: chamferPath(footChamfer)')
    expect(src).toMatch(/const footBite = opusFrameBitePx\(\{ x, y: foot \}\)/)
    expect(src).toMatch(/const footChamfer = opusFrameCoreChamferPx\(footBite\)/)
  })

  it('draws the acid rim UNDER the metal, never over it', () => {
    // Painting order is DOM order (no z-index in the scenery), so each rim
    // layer has to come first. If it ever moves after its rail the acid covers
    // the whole bar instead of the few px of the cut.
    for (const wall of ['WALL.top', 'WALL.bottom']) {
      const metal = src.indexOf(`boxShadow: ${wall}`)
      expect(metal, wall).toBeGreaterThan(0)
      const rim = src.lastIndexOf('backgroundColor: RIM_INK', metal)
      expect(rim, `${wall} has no rim layer before it`).toBeGreaterThan(0)
    }
    expect((src.match(/backgroundColor: RIM_INK/g) ?? []).length).toBe(2)
    expect(src).toMatch(/const RIM_INK\s*=\s*'var\(--opus-signal/)
  })

  it('leaves the FLANKS unclipped — the drag and resize areas do not move', () => {
    // The bite is paint. The drag bands and the 6px resize strip are separate
    // siblings that no clip-path touches, and the flanks (which carry two of
    // the three bands) are not clipped at all.
    for (const side of ['left', 'right']) {
      const i = src.indexOf(`WALL.${side}`)
      expect(i, side).toBeGreaterThan(0)
      expect(src.slice(i, src.indexOf('}}', i)), side).not.toContain('clipPath')
    }
    const from = src.indexOf('function DragBands')
    const bands = src.slice(from, src.indexOf('\nfunction ', from + 1))
    expect(bands).toContain('...DRAG')
    expect(bands).not.toContain('clipPath')
    expect(bands).not.toContain('bite')
  })

  it('ends the frame on PURE acid, not on a wash of it', () => {
    // The four inner hairlines shipped at 55% alpha, which resolves to a muted
    // olive over the graphite. The owner's note is the spec: the frame ENDS on
    // the acid, so the rule is the signal token itself.
    const wall = src.slice(src.indexOf('const RULE'), src.indexOf('const LEGEND'))
    expect(wall).toMatch(/const RULE\s*=\s*'var\(--opus-signal/)
    expect(wall).not.toMatch(/rgba\(184\s*,\s*242\s*,\s*39\s*,\s*0?\.\d+\)\s*,\s*inset/)
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(wall, `${side} hairline`).toMatch(new RegExp(`${side}: \`inset [^\`]*\\$\\{RULE\\}`))
    }
  })

  it('keeps the ruler clear of the corner it would be sheared by', () => {
    // The scale lives on the rail's OUTER edge, which is exactly where the
    // metal is now missing. chassisChamferPx stays as the FLOOR so the ruler
    // never moves outward from where it already was.
    expect(src).toMatch(/const rulerInset = Math\.max\(ch, bite\.notch \+ bite\.rim\)/)
    expect(src).toMatch(/const footRulerInset = Math\.max\(ch, footBite\.notch \+ footBite\.rim\)/)
    // One per rail, each clearing ITS OWN corner cut.
    expect((src.match(/inset=\{rulerInset\}/g) ?? []).length).toBe(1)
    expect((src.match(/inset=\{footRulerInset\}/g) ?? []).length).toBe(1)
  })
})

// ── The bottom rail is dressed off its OWN thickness ─────────────────────────
// Every number the hint bar draws with used to be the header rail's, because
// there was only one. Each of these is a place a stale `y` would silently put
// the bar's contents at the wrong height — none of which a type-checker sees,
// since both are numbers.
describe('OpusChrome bottom rail (source guards)', () => {
  const src = stripComments(read('components/OpusChrome.tsx'))

  it('reads the hint rail off the bezel and derives the bar from it', () => {
    expect(src).toMatch(/const foot = bezel\.bottom/)
    // Height, pad and ruler: the three things printed on the bar.
    expect((src.match(/height: foot,/g) ?? []).length).toBe(2)   // rim + metal
    expect(src).toMatch(/const footPad = Math\.max\(3, Math\.round\(foot \* 0\.2\)\)/)
    expect(src).toMatch(/opusRulerVisible\(foot\)/)
    expect(src).toMatch(/height=\{footRulerH\}/)
    // The hint type and its LED-bar truncation both sit on the FOOT's pad.
    expect((src.match(/top: footPad/g) ?? []).length).toBe(4)
    expect(src).not.toMatch(/top: railPad,\s*\n?\s*\}\}>ENTER run task/)
  })

  it('ends the flanks and the plate on the hint rail, not on the header', () => {
    // The flanks are inset by the rail they MEET at each end — that is what
    // keeps both corner bites wholly inside the rails and the flanks unclipped.
    expect((src.match(/top: y, bottom: foot/g) ?? []).length).toBe(2)
    expect(src).toMatch(/const plateH = viewport\.height - y - foot/)
    // The flank DRAG bands end there too, or they would overhang the bar.
    const bands = src.slice(src.indexOf('function DragBands'))
    expect((bands.match(/top: bezel\.y, bottom: bezel\.bottom/g) ?? []).length).toBe(2)
    // …and the bottom rail is STILL not a drag surface (it is the resize edge).
    expect(bands).not.toMatch(/bottom: e/)
  })

  it('derives three captions, one per surface that has to print', () => {
    expect(src).toMatch(/const capRail = opusCaptionMode\(stage, y\)/)
    expect(src).toMatch(/const capFoot = opusCaptionMode\(stage, foot\)/)
    expect(src).toMatch(/const capBay = opusBayCaptionMode\(x\)/)
    // Each goes to its own surface: header row, hint bar, flank stencils.
    expect(src).toMatch(/cap=\{capRail\} rail=\{y\}/)
    expect(src).toMatch(/capFoot === 'bar' \?/)
    expect((src.match(/<Bay cap=\{capBay\}/g) ?? []).length).toBe(3)
    // The borrowed gate is GONE — it is what turned the 16px flanks into bars.
    expect(src).not.toContain('chassisCaptionMode')
  })
})

// ── The acid retheme: the palette is ONE hue, and it is not teal ─────────────
// The theme shipped with a petrol-teal control family (--accent #0c6b79,
// --accent-text #6fe3f2, --accent-muted #0b2a2e), so every ACTIVE surface in
// the app — the PageTopbar badge, the selected sidebar tab, the chat History
// `New` key, the selected conversation row — was teal while the theme's whole
// claim was its acid. The family is now re-derived from --opus-signal.
//
// These are the constraints that made the old hues survivable and that any
// future edit has to keep surviving; the file's own header explains each one.
describe('tachi-opus5 palette · the acid family', () => {
  // COMMENTS STRIPPED FIRST, and not as tidiness: the file's header explains
  // the retheme in prose that contains the literal `--opus-signal:` followed by
  // the derivation, so an un-stripped scan resolves the token to a sentence.
  const THEME_CSS = stripCss(fs.readFileSync(path.resolve(SRC, 'themes/tachi-opus5.css'), 'utf8'))

  /** `var(--x)` → the hex tachi-opus5.css declares for it, so a palette edit
   *  that broke a call site fails HERE and not in a screenshot. */
  const resolveInk = (value: string): string => {
    const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())
    if (!m) return value.trim()
    const decl = new RegExp(`${m[1]}\\s*:\\s*([^;]+);`).exec(THEME_CSS)
    expect(decl, `${m[1]} is not declared in tachi-opus5.css`).toBeTruthy()
    return decl![1].trim()
  }
  const rgb = (ink: string): [number, number, number] => {
    const hex = resolveInk(ink).replace('#', '')
    expect(hex, `${ink} is not a plain hex ink`).toMatch(/^[0-9a-f]{6}$/i)
    const n = parseInt(hex, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = (ink: string): number => {
    const [r, g, b] = rgb(ink)
    return 0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255)
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }

  const FAMILY = ['var(--accent)', 'var(--accent-hover)', 'var(--accent-muted)',
    'var(--accent-text)', 'var(--accent-alt)', 'var(--opus-signal)']

  it('has no teal left in it — green is the top channel, blue the bottom', () => {
    // The crispest possible "is it still teal" guard. On the acid ramp GREEN is
    // always the maximum and BLUE always the minimum; on a petrol/teal ramp
    // blue is at or near the top. One assertion, no hue arithmetic to argue
    // with, and it fires on any drift back toward cyan.
    for (const ink of FAMILY) {
      const [r, g, b] = rgb(ink)
      expect(g, `${ink} is not green-dominant`).toBeGreaterThan(r)
      expect(b, `${ink} still leans blue`).toBeLessThan(r)
    }
    // …and the neutral chassis carries no chroma toward blue either: the old
    // graphite was G≈B>R, which is what read as "muddy green" over big fills.
    for (const ink of ['var(--bg-base)', 'var(--bg-surface)', 'var(--bg-elevated)',
      'var(--bg-inset)', 'var(--bg-sidebar)', 'var(--border)', 'var(--border-strong)',
      'var(--text-primary)', 'var(--text-muted)', 'var(--text-dim)']) {
      const [r, g, b] = rgb(ink)
      expect(b, `${ink} still carries the teal cast`).toBeLessThanOrEqual(Math.min(r, g))
    }
  })

  it('keeps --accent a bed for BOTH white and black text', () => {
    // ~40 call sites hardcode #fff on var(--accent) (Sidebar's primary button,
    // the inbox badge, globals' ::selection …) and ToolCallBlock paints the
    // READ/SEARCH/FETCH family chip as `background: var(--accent); color: #000`.
    // Those files are not this theme's to edit, so --accent has to serve both —
    // which is why the moss is a LUMINANCE MATCH to the retired petrol and not
    // simply "the acid, darker".
    expect(contrast('#ffffff', 'var(--accent)')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', 'var(--accent-hover)')).toBeGreaterThanOrEqual(4.5)
    // 9px bold uppercase on a chip: the WCAG 1.4.11 non-text floor is the bar
    // the petrol cleared (3.40:1) and the moss must not fall under it.
    expect(contrast('#000000', 'var(--accent)')).toBeGreaterThanOrEqual(3)
    // The acid itself can NEVER be a text bed for white — this is the whole
    // reason it lives in --accent-alt instead of --accent.
    expect(contrast('#ffffff', 'var(--accent-alt)')).toBeLessThan(3)
  })

  it('pairs every acid FILL with dark ink, at AA', () => {
    // Where the app fills with the signal (the pincer SEND jaws, the FRONTIER
    // chip, ::selection in GROUP L) it pairs `color: var(--bg-base)`.
    expect(contrast('var(--bg-base)', 'var(--accent-alt)')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('var(--bg-base)', 'var(--opus-signal)')).toBeGreaterThanOrEqual(4.5)
  })

  it('makes the ACTIVE well readable and visibly selected', () => {
    // --accent-muted is the app's active/selected fill (126 call sites, almost
    // always with `color: var(--accent-text)`).
    expect(contrast('var(--accent-text)', 'var(--accent-muted)')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('var(--text-primary)', 'var(--accent-muted)')).toBeGreaterThanOrEqual(4.5)
    // …and it has to read as SELECTED against the surface it sits on. The old
    // teal well was 1.15:1 against --bg-elevated — the "why does nothing look
    // selected" half of the owner's complaint.
    expect(contrast('var(--accent-muted)', 'var(--bg-elevated)')).toBeGreaterThanOrEqual(1.3)
  })

  it('keeps the legend inks at AA on every surface they are printed on', () => {
    for (const bg of ['var(--bg-base)', 'var(--bg-surface)', 'var(--bg-elevated)', 'var(--bg-sidebar)']) {
      expect(contrast('var(--accent-text)', bg), `accent-text on ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast('var(--text-primary)', bg), `text-primary on ${bg}`).toBeGreaterThanOrEqual(4.5)
      // The 8–9px tier prints real copy (plate labels, status legends), so it
      // must clear AA and not merely read as "dim".
      expect(contrast('var(--text-dim)', bg), `text-dim on ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast('var(--text-muted)', bg), `text-muted on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the SIGNAL the brightest thing in the theme', () => {
    // The instrument hierarchy: the LEDs, the frame rule, the SEND key and the
    // selection wash are the brightest surfaces; the legends that merely NAME a
    // live thing sit a step under them. Collapsing --accent-text onto the
    // signal is what flattens an instrument into a poster.
    const signal = luminance('var(--opus-signal)')
    expect(luminance('var(--accent-text)')).toBeLessThan(signal)
    expect(luminance('var(--accent-hover)')).toBeLessThan(luminance('var(--accent-text)'))
    expect(luminance('var(--accent)')).toBeLessThan(luminance('var(--accent-hover)'))
    expect(luminance('var(--accent-muted)')).toBeLessThan(luminance('var(--accent)'))
    expect(luminance('var(--accent-alt)')).toBe(signal)
  })

  it('keeps the three tool-call family chips mutually distinguishable', () => {
    // READ=accent / WRITE=success / EDIT=warning at 9px. The accent is green
    // now and so is success, so the separation has moved from HUE to LIGHTNESS
    // — which means it has to be a real gap, not a rounding.
    expect(contrast('var(--accent)', 'var(--success)')).toBeGreaterThanOrEqual(2.5)
    expect(contrast('var(--accent)', 'var(--warning)')).toBeGreaterThanOrEqual(3)
    // success vs warning has always separated on HUE, not lightness (they sit
    // within 1.3:1 of each other and always did), so the guard there is that
    // they keep different dominant channels — green vs red.
    const [sr, sg] = rgb('var(--success)')
    const [wr, wg] = rgb('var(--warning)')
    expect(sg).toBeGreaterThan(sr)
    expect(wr).toBeGreaterThan(wg)
  })
})

// ── B2 excludes the chassis keys (parity with the TK-05 sheet) ───────────────
// Driver-2 measured a computed drop-shadow(var(--opus-signal)) on every TK
// window key: invisible (the cap's inline clip-path is applied after the
// filter and eats it) but it contradicted the sheet's signal restraint and
// forced a compositing layer per key. Lane M fixed the TK sheet and flagged
// the identical defect here; this pins the opus side of the fix.
describe('OPUS-5 B2 excludes the window keys', () => {
  it('every chassis key button publishes data-chassis-key', () => {
    const src = read('components/OpusChrome.tsx')
    const keyButtons = src.match(/<button className="opus-chassis-key"[^>]*/g) ?? []
    expect(keyButtons.length).toBe(3)
    for (const b of keyButtons) expect(b).toContain('data-chassis-key')
  })
  it('the B2 offset rule carries :not([data-chassis-key])', () => {
    const sheet = read('themes/tachi-opus5-structure.css')
    const b2 = sheet.split('B2 · THE OFFSET')[1]?.split('GROUP C')[0] ?? ''
    expect(b2).toContain(':not([data-chassis-key])')
    expect(b2).toContain('drop-shadow')
  })
})
