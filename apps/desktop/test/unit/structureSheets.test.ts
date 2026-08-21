// apps/desktop/test/unit/structureSheets.test.ts
//
// APP-WIDE LAW for theme structure layers (`src/themes/<id>-structure.css`),
// plus the art contract for the two claw PNGs.
//
// WAS `crabChrome.test.ts`. The `tachi-crab` theme was deleted on 2026-07-26
// (owner's call), and with it CrabChrome.tsx and crab/crabChrome.helpers.ts — so
// every assertion about claw GRIP GEOMETRY (inset gutter, tip overlap, render
// size, glow slack) went with the code it described. Two things in that file
// were never about the crab theme and are what survives here:
//
//   1. The ghost-button drop-shadow law, which every structure sheet obeys.
//   2. The claw PNGs themselves. They live on in `src/assets/crab/` because
//      OpusChrome.tsx uses them as the CSS MASK for the OPUS-5 stage engraving
//      — the only bitmaps in the whole chrome layer. A regenerated asset that
//      reintroduces a straight opaque cut, or stops being a tall silhouette,
//      still breaks a shipped theme, so those guards stay.
//
// Two rules added with PATCH-01 / the live cosmetics pass are also pinned here:
// the B1/B2 split (the cut must reach ghost controls) and the single-key-set
// rule (a chassis theme hides the TitleBar's own window controls).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const THEMES_DIR = path.resolve(__dirname, '../../src/themes')
const SRC_DIR = path.resolve(__dirname, '../../src')

/** Comments must be stripped before anything is matched: these sheets DOCUMENT
 *  the bad selector as a warning, and the `kbd` groups mention "button" in
 *  prose. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const readSheet = (name: string) => fs.readFileSync(path.join(THEMES_DIR, name), 'utf8')

/** Every structure layer that ships. Palette-only sheets have no geometry and
 *  are covered by resizeCursor.test.ts instead. */
const STRUCTURE_SHEETS = [
  'comic-structure.css',
  'tachi-opus5-structure.css',
  'tachikoma-red-structure.css',
]

/** All three sheets PATCH-01 (and its comic follow-up) split into B1 (the cut)
 *  / B2 (the offset) — every ghost control gets the geometry, only solid
 *  controls get the drop-shadow. */
const PATCHED_SHEETS: Array<[string, string]> = [
  ['comic-structure.css', 'comic'],
  ['tachi-opus5-structure.css', 'tachi-opus5'],
  ['tachikoma-red-structure.css', 'tachikoma-red'],
]

/** Of those, only the two CHASSIS frames mount their own window keys and must
 *  hide the TitleBar's duplicate row — comic ships no frame, so it is not in
 *  this narrower list even though it shares the B1/B2 button split above. */
const CHASSIS_SHEETS: Array<[string, string]> = [
  ['tachi-opus5-structure.css', 'tachi-opus5'],
  ['tachikoma-red-structure.css', 'tachikoma-red'],
]

interface Rule { selector: string; body: string }

/** Every rule block in a sheet, comments already gone. */
const rules = (css: string): Rule[] =>
  stripComments(css)
    .split('}')
    .map((block) => {
      const i = block.indexOf('{')
      return i === -1 ? null : { selector: block.slice(0, i), body: block.slice(i + 1) }
    })
    .filter((r): r is Rule => !!r)

// ── The ghost-shadow law ─────────────────────────────────────────────────────
// filter: drop-shadow() traces an element's ALPHA. On a transparent-background
// button the only opaque pixels are the glyphs, so the shadow paints a copy of
// the TEXT — the app-wide "doubled / struck-through" defect that shipped in the
// structure themes. Every drop-shadow-on-button rule must therefore exclude
// ghost buttons. See recipes/ADDING-A-THEME.md.
describe('structure layers never drop-shadow ghost buttons', () => {
  /** Rule blocks whose declarations cast a drop-shadow onto a <button>. */
  const shadowedButtonRules = (css: string) =>
    rules(css).filter((r) => /\bbutton\b/.test(r.selector) && r.body.includes('drop-shadow('))

  for (const sheet of STRUCTURE_SHEETS) {
    describe(sheet, () => {
      const css = readSheet(sheet)
      const shadowed = shadowedButtonRules(css)

      it('has at least one drop-shadow button rule to check', () => {
        expect(shadowed.length).toBeGreaterThan(0)
      })

      it('excludes transparent-background buttons from every one of them', () => {
        for (const rule of shadowed) {
          expect(rule.selector).toContain('[style*="background: transparent"]')
          expect(rule.selector).toContain('[style*="background: none"]')
        }
      })

      it('matches the background VALUE, never a bare ": none"', () => {
        // `[style*=": none"]` also matches `border-image: none`, which every
        // solid nav tile carries — it would strip the bevel from real buttons.
        const selectors = stripComments(css)
        expect(selectors).not.toContain('[style*=": none"]')
        expect(selectors).not.toContain('[style*=":none"]')
      })
    })
  }
})

// ── PATCH-01 · the B1 / B2 split ─────────────────────────────────────────────
// The law above governs the SHADOW, and the first cut of all three sheets put
// `clip-path` in the same rule as the shadow — so the signature bite/chamfer
// reached only the solid controls in the app and ~90% of the UI stayed a
// plain rectangle. clip-path clips the BORDER BOX and never reads alpha, so
// it is safe on a ghost; the split is the fix, and this is the guard that
// stops it being "tidied" back into one rule.
describe('the CUT reaches ghost controls too (B1)', () => {
  for (const [sheet, theme] of PATCHED_SHEETS) {
    describe(sheet, () => {
      const all = rules(readSheet(sheet))
      /** B1: the bare enabled-button rule — no ghost exclusion, cut only. */
      const b1 = all.filter(
        (r) =>
          r.selector.includes(`:root[data-theme="${theme}"] button:not(:disabled)`) &&
          !r.selector.includes('[style*="background') &&
          !/:hover|:active|:focus/.test(r.selector) &&
          r.body.includes('clip-path'),
      )

      it('cuts every enabled button with no transparent-background exclusion', () => {
        expect(b1.length).toBe(1)
      })

      it('carries geometry ONLY — the offset stays in B2', () => {
        // A drop-shadow here would be the original defect. A blanket
        // `box-shadow: none` here would also erase the :focus-visible ring
        // globals.css draws as a shadow on controls that carry no shadow of
        // their own — which is why the patch left it in B2.
        expect(b1[0].body).not.toContain('drop-shadow')
        expect(b1[0].body).not.toContain('box-shadow')
      })

      it('still keeps a solid-only offset rule (B2) with the exclusion intact', () => {
        const b2 = all.filter(
          (r) =>
            r.selector.includes('[style*="background: transparent"]') &&
            r.body.includes('drop-shadow('),
        )
        expect(b2.length).toBeGreaterThan(0)
        // B2 is where a torn corner can actually happen, so this belongs here.
        expect(b2.some((r) => /box-shadow:\s*none\s*!important/.test(r.body))).toBe(true)
      })
    })
  }
})

// ── One set of window keys, not two ──────────────────────────────────────────
// Both chassis frames mount their OWN min/max/close keys on the frame, wired to
// the same `window.tachi.window` IPC the TitleBar uses — so with the TitleBar's
// row still up, two live identical clusters sat ~50px apart (live-found). The
// sheets hide the row; the point of this guard is that they do it SCOPED, so no
// other theme loses its only window controls.
describe('chassis sheets hide the duplicate titlebar keys', () => {
  const HOOK = '[data-titlebar-controls]'

  it('the TitleBar still publishes the hook the sheets aim at', () => {
    const titleBar = fs.readFileSync(path.join(SRC_DIR, 'components/layout/TitleBar.tsx'), 'utf8')
    expect(titleBar).toContain('data-titlebar-controls')
  })

  it('the TitleBar row still carries the INLINE display:flex the !important exists to beat', () => {
    // The two halves of the cascade argument, linked: the sheets' hide rule
    // needs `!important` ONLY because the hooked row sets `display: 'flex'`
    // inline (an author !important beats an inline normal declaration; a plain
    // selector loses to it — that was the shipped six-button no-op). If this
    // assertion ever fails, the inline style was removed — revisit the
    // `!important` requirement DELIBERATELY instead of letting the two drift.
    const titleBar = fs.readFileSync(path.join(SRC_DIR, 'components/layout/TitleBar.tsx'), 'utf8')
    const hookLine = titleBar.split('\n').find((l) => l.includes('data-titlebar-controls'))
    expect(hookLine).toBeDefined()
    expect(hookLine).toMatch(/display:\s*'flex'/)
  })

  for (const [sheet, theme] of CHASSIS_SHEETS) {
    describe(sheet, () => {
      const all = rules(readSheet(sheet))
      const hits = all.filter((r) => r.selector.includes(HOOK))

      it('hides the row WITH !important (cascade-aware guard)', () => {
        expect(hits.length).toBe(1)
        // The row carries an INLINE display:flex, which beats any selector
        // without !important — the first shipped version of this rule matched
        // /display:\s*none/ and was a runtime no-op (live-found: six window
        // buttons). The guard must assert the cascade, not just the text.
        expect(hits[0].body).toMatch(/display:\s*none\s*!important/)
      })

      it('scopes the rule to its own theme (never a bare selector)', () => {
        // An unscoped `[data-titlebar-controls] { display: none }` would delete
        // the window controls on every theme in the app.
        expect(hits[0].selector).toContain(`:root[data-theme="${theme}"]`)
      })

      it('requires the data-chassis-keys interlock (no keys on screen → row survives)', () => {
        // Live-found regression: TK-05's flush stage drops the flank keys, and
        // an unconditional hide left a maximized window with ZERO controls.
        // The chrome components set data-chassis-keys ONLY while their
        // replacement keys are mounted; the rule must demand it.
        expect(hits[0].selector).toContain('[data-chassis-keys="1"]')
      })
    })
  }

  it('no other structure sheet touches the hook', () => {
    const others = STRUCTURE_SHEETS.filter((s) => !CHASSIS_SHEETS.some(([p]) => p === s))
    for (const sheet of others) {
      expect(stripComments(readSheet(sheet)), `${sheet} hides the titlebar keys`).not.toContain(HOOK)
    }
  })
})

// ── The header scan bar (PATCH-01's "Not in this patch") ─────────────────────
// The mock's header carries an LED strip that sweeps while a run is in flight.
// PATCH-01 could not ship it — "a theme sheet cannot invent an element" — so it
// arrived as an inert leaf in AppShell plus this one rule group. The guards pin
// the two halves to each other, and pin the sweep to the run state: a strip that
// sweeps while the app is idle is a decoration, and this app has already shipped
// one animation that outlived its state.
describe('OPUS-5 header scan bar (GROUP R)', () => {
  const SHEET = 'tachi-opus5-structure.css'
  const HOOK = '[data-scan-bar]'
  const bare = stripComments(readSheet(SHEET))
  // The sheet is read in two halves: the reduced-motion block at the foot also
  // names the hook (it is the kill switch), and folding it in with the dressing
  // rules would make "the strip has exactly one idle rule" count two.
  const rmIdx = bare.indexOf('@media (prefers-reduced-motion')
  const rm = bare.slice(rmIdx)
  const scanRules = rules(bare.slice(0, rmIdx)).filter((r) => r.selector.includes(HOOK))

  it('AppShell still publishes the element the rule aims at', () => {
    const shell = fs.readFileSync(path.join(SRC_DIR, 'components/layout/AppShell.tsx'), 'utf8')
    expect(shell).toContain('data-scan-bar')
    expect(shell).toContain('data-run-active')
  })

  it('dresses the strip and scopes every rule to its own theme', () => {
    expect(scanRules.length).toBeGreaterThanOrEqual(2)
    for (const r of scanRules) {
      expect(r.selector, r.selector).toContain(':root[data-theme="tachi-opus5"]')
    }
  })

  it('beats the inline background shorthand the strip carries', () => {
    // Same cascade argument as GROUP A / GROUP O: the element sets
    // `background: transparent` INLINE (its inertness guarantee on every other
    // theme), which resets background-image and outranks a normal author rule.
    const idle = scanRules.filter((r) => !r.selector.includes('data-run-active'))
    expect(idle.length).toBe(1)
    expect(idle[0].body).toMatch(/background-image:[\s\S]*?!important/)
  })

  it('sweeps ONLY under data-run-active="1"', () => {
    const animated = scanRules.filter((r) => /animation:\s*opus5-scan/.test(r.body))
    expect(animated.length).toBe(1)
    expect(animated[0].selector).toContain('[data-run-active="1"]')
    // The idle rule must stay still — no animation, at all.
    const idle = scanRules.filter((r) => !r.selector.includes('data-run-active'))
    expect(idle[0].body).not.toContain('animation')
  })

  it('animates a PAINT property only — never transform / filter / a fill-mode', () => {
    // THE CONTAINING-BLOCK LAW (the maximized-keys saga): a permanent
    // transform / filter / animation fill-mode turns an element into the
    // containing block for its `position: fixed` descendants. The strip is a
    // childless leaf so it cannot bite today; keeping the motion on
    // background-position means it could not bite even if that changed.
    for (const r of scanRules) {
      expect(r.body).not.toMatch(/transform:/)
      expect(r.body).not.toMatch(/filter:/)
      expect(r.body).not.toMatch(/\b(forwards|backwards|both)\b/)
    }
    const kfIdx = bare.indexOf('@keyframes opus5-scan')
    expect(kfIdx).toBeGreaterThan(-1)
    const kf = bare.slice(kfIdx, bare.indexOf(':root', kfIdx))
    expect(kf).toContain('background-position')
    expect(kf).not.toMatch(/transform|filter|opacity/)
  })

  it('is in the reduced-motion kill list at the foot of the sheet', () => {
    expect(rmIdx).toBeGreaterThan(-1)
    expect(rm).toContain(HOOK)
    expect(rm).toMatch(/\[data-scan-bar\][^{]*\{[^}]*animation:\s*none\s*!important/)
  })
})

// ── Claw art contract ────────────────────────────────────────────────────────
// The art is generated by src/assets/crab/extract-claws.py. It outlived the crab
// theme: OpusChrome.tsx masks the OPUS-5 stage engraving with these two PNGs, so
// the shape contract is still load-bearing. The guards exist because the
// PREVIOUS strips were rectangular crops that ran through the app window drawn
// in the hero, and each therefore carried a ~740px fully opaque bar down its
// inner border — the straight "cut" the user saw. A regenerated asset that
// reintroduces a wall fails here.
describe('claw art (src/assets/crab/claw-*.png)', () => {
  const ASSETS = path.resolve(__dirname, '../../src/assets/crab')

  /** Longest contiguous run of fully-opaque samples. */
  const longestOpaqueRun = (vec: number[]) => {
    let best = 0
    let run = 0
    for (const v of vec) {
      run = v === 255 ? run + 1 : 0
      if (run > best) best = run
    }
    return best
  }

  type Png = { width: number; height: number; alphaAt: (x: number, y: number) => number }

  /** Minimal RGBA8 non-interlaced PNG reader — enough to inspect the alpha
   *  channel without pulling an image dependency into the test suite. */
  function decodePng(file: string): Png {
    const buf = fs.readFileSync(file)
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    expect(buf[24]).toBe(8) // bit depth
    expect(buf[25]).toBe(6) // colour type: truecolour + alpha
    expect(buf[28]).toBe(0) // not interlaced

    const idat: Buffer[] = []
    let off = 8
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off)
      const type = buf.toString('ascii', off + 4, off + 8)
      if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
      off += 12 + len
      if (type === 'IEND') break
    }
    const raw = zlib.inflateSync(Buffer.concat(idat))

    const bpp = 4
    const stride = width * bpp
    const out = Buffer.alloc(height * stride)
    let p = 0
    for (let y = 0; y < height; y++) {
      const filter = raw[p++]
      const row = raw.subarray(p, p + stride)
      p += stride
      const cur = out.subarray(y * stride, (y + 1) * stride)
      const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0
        const b = prev ? prev[i] : 0
        const c = i >= bpp && prev ? prev[i - bpp] : 0
        let v = row[i]
        if (filter === 1) v += a
        else if (filter === 2) v += b
        else if (filter === 3) v += (a + b) >> 1
        else if (filter === 4) {
          const pa = Math.abs(b - c)
          const pb = Math.abs(a - c)
          const pc = Math.abs(a + b - 2 * c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`)
        cur[i] = v & 0xff
      }
    }
    return { width, height, alphaAt: (x, y) => out[y * stride + x * bpp + 3] }
  }

  const column = (png: Png, x: number) =>
    Array.from({ length: png.height }, (_, y) => png.alphaAt(x, y))
  const row = (png: Png, y: number) =>
    Array.from({ length: png.width }, (_, x) => png.alphaAt(x, y))

  // The contract the extraction script prints and enforces. A longer run means
  // a straight cut through the art — exactly the defect being guarded.
  const MAX_BORDER_RUN_PX = 40

  const SIDES = [
    { side: 'left' as const, file: 'claw-left.png' },
    { side: 'right' as const, file: 'claw-right.png' },
  ]

  for (const { side, file } of SIDES) {
    describe(file, () => {
      const png = decodePng(path.join(ASSETS, file))
      // The inner edge is the one that faced the app plate under the old claw
      // chrome, and is now the one that meets the other half of the engraving.
      const innerX = side === 'left' ? png.width - 1 : 0
      const inward = side === 'left' ? -1 : 1

      it('is a tall, narrow claw silhouette', () => {
        expect(png.width).toBeGreaterThan(200)
        expect(png.height).toBeGreaterThan(700)
        const aspect = png.width / png.height
        expect(aspect).toBeGreaterThan(0.25)
        expect(aspect).toBeLessThan(0.45)
      })

      it('has no straight cut on ANY border', () => {
        const borders = {
          top: row(png, 0),
          bottom: row(png, png.height - 1),
          left: column(png, 0),
          right: column(png, png.width - 1),
        }
        for (const [name, vec] of Object.entries(borders)) {
          expect(
            longestOpaqueRun(vec),
            `${file} ${name} border holds a straight fully-opaque cut`,
          ).toBeLessThanOrEqual(MAX_BORDER_RUN_PX)
        }
      })

      it('dissolves on the inner edge instead of ending in a wall', () => {
        // The old strips ended in a 740px opaque bar here. The extraction now
        // ramps the alpha to ~zero across the last few dozen source px.
        //
        // This ramp is ALSO why the OPUS-5 engraving overlaps its two halves by
        // ENGRAVE_SEAM_PX: two fading edges abutting on the midline read as a
        // hairline slit, so they are made to overlap and sum instead.
        expect(Math.max(...column(png, innerX))).toBeLessThanOrEqual(24)
      })

      it('keeps the ramp short — the limb is solid again well inside the edge', () => {
        // If the whole limb faded away it would read as a severed stump.
        const solid = column(png, innerX + inward * MAX_BORDER_RUN_PX)
        expect(Math.max(...solid)).toBe(255)
      })

      it('has a mostly-solid body (it is a silhouette, not a ghost)', () => {
        let opaque = 0
        for (let y = 0; y < png.height; y += 4) {
          for (let x = 0; x < png.width; x += 4) if (png.alphaAt(x, y) === 255) opaque++
        }
        const sampled = Math.ceil(png.height / 4) * Math.ceil(png.width / 4)
        expect(opaque / sampled).toBeGreaterThan(0.3)
      })
    })
  }

  it('is still imported by the one component that consumes it', () => {
    const opus = fs.readFileSync(path.join(SRC_DIR, 'components/OpusChrome.tsx'), 'utf8')
    expect(opus).toContain("from '../assets/crab/claw-left.png'")
    expect(opus).toContain("from '../assets/crab/claw-right.png'")
  })
})

// ── The retired theme is gone, all the way down ──────────────────────────────
// A half-deleted theme is worse than a live one: a chip that stamps an id with
// no sheet paints a window with NO palette variables at all. This is the sweep.
describe('tachi-crab is fully retired', () => {
  it('ships no sheet and no chrome component', () => {
    for (const gone of [
      path.join(THEMES_DIR, 'tachi-crab.css'),
      path.join(THEMES_DIR, 'tachi-crab-structure.css'),
      path.join(SRC_DIR, 'components/CrabChrome.tsx'),
      path.join(SRC_DIR, 'components/crab/crabChrome.helpers.ts'),
    ]) {
      expect(fs.existsSync(gone), `${gone} is still present`).toBe(false)
    }
  })

  it('is imported by nothing and offered nowhere', () => {
    const files = [
      'globals.css',
      'app/App.tsx',
      'components/layout/Sidebar.tsx',
      'store/theme.store.ts',
      'pages/settings/SettingsPage.tsx',
    ]
    for (const rel of files) {
      // Comments are stripped BEFORE the scan: several of these files document
      // the retirement in prose (why the theme grid is six chips, why the boot
      // path coerces), and that prose is the opposite of a leftover.
      const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
      const body = stripComments(src).replace(/^\s*\/\/.*$/gm, '')
      expect(body, `${rel} still references the retired theme`).not.toContain('tachi-crab')
    }
  })

  it('keeps the claw ART, which a live theme still uses', () => {
    for (const keep of ['claw-left.png', 'claw-right.png']) {
      expect(fs.existsSync(path.join(SRC_DIR, 'assets/crab', keep))).toBe(true)
    }
  })

  it('coerces a persisted crab id at boot instead of stamping a dead theme', () => {
    const store = fs.readFileSync(path.join(SRC_DIR, 'store/theme.store.ts'), 'utf8')
    expect(store).toContain('RETIRED_THEMES')
    // The rewrite is the reason the coercion runs once, not every boot.
    expect(store).toContain("localStorage.setItem('tachi-theme'")
  })
})

// ── The TK-05 recessed screen (GROUP Q, added with the SLAB reframe) ─────────
// The chassis stopped being four bars around a hole and became ONE machined
// body (TachikomaChrome.tsx, mock variant 2a). The app plate is now COUNTERBORED
// into that body, and the mock draws the well as stacked rings on `.screen`: a
// metal lip, a black gap, a second metal lip, then one faint optic hairline
// inside the glass.
//
// The law this pins is the same one the tachi-opus5 frame already obeys:
// globals.css owns the recess GEOMETRY (position / inset / z-index, driven by
// the two custom properties the chrome component computes), and a theme sheet
// may only RE-COLOUR it. Two sources of truth for the inset is how a chassis
// ends up half a stage behind the plate it is supposed to hold.
describe('tachikoma-red recessed screen (theme recolours, globals owns geometry)', () => {
  const tk = stripComments(readSheet('tachikoma-red-structure.css'))

  /** The declaration block of the first rule whose selector matches. */
  const ruleBody = (css: string, needle: string): string => {
    for (const block of css.split('}')) {
      const i = block.indexOf('{')
      if (i !== -1 && block.slice(0, i).includes(needle)) return block.slice(i + 1)
    }
    return ''
  }

  it('recolours the plate without re-declaring its geometry', () => {
    const body = ruleBody(tk, '[data-chassis] .app-body')
    expect(body, 'the GROUP Q recess rule is missing').toContain('box-shadow')
    expect(body).toContain('border-color')
    for (const banned of ['position:', 'inset:', 'z-index:', 'drop-shadow']) {
      expect(body, `${banned} belongs to globals.css`).not.toContain(banned)
    }
  })

  it('scopes the rule to this theme and needs no !important to win', () => {
    const idx = tk.indexOf('[data-chassis] .app-body')
    expect(idx).toBeGreaterThan(-1)
    const selectorStart = tk.lastIndexOf('}', idx) + 1
    // Specificity does the overriding: [data-theme] + [data-chassis] + .app-body
    // beats the globals.css selector on its own.
    expect(tk.slice(selectorStart, idx)).toContain(':root[data-theme="tachikoma-red"]')
    expect(ruleBody(tk, '[data-chassis] .app-body')).not.toContain('!important')
  })

  it('keeps the optic hairline INSIDE the glass and the chassis cyan-free', () => {
    // The mock's cyan restraint: the only cyan anywhere near the outside of the
    // display is this one inset hairline. Every outer ring is metal.
    const body = ruleBody(tk, '[data-chassis] .app-body')
    // Split the shadow list on TOP-LEVEL commas only — an rgba() carries three
    // of its own, and a naive split would tear every ring apart.
    const rings: string[] = []
    let depth = 0
    let cur = ''
    for (const ch of body.slice(body.indexOf('box-shadow'))) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if ((ch === ',' || ch === ';') && depth === 0) { rings.push(cur); cur = '' } else cur += ch
    }
    rings.push(cur)
    expect(rings.some(r => /229/.test(r)), 'the optic hairline is gone').toBe(true)
    for (const ring of rings) {
      if (/229/.test(ring)) {
        expect(ring, `cyan ring outside the glass: ${ring}`).toContain('inset')
      }
    }
  })

  it('still ends with the reduced-motion block', () => {
    // House rule for every structure sheet: the kill switch is the last thing in
    // the file, so a rule appended later cannot outlive it.
    const raw = readSheet('tachikoma-red-structure.css')
    expect(raw.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
      .toBeGreaterThan(raw.lastIndexOf(':root[data-theme="tachikoma-red"][data-chassis] .app-body'))
  })
})

// в”Ђв”Ђ The chassis keys are HARDWARE, not app controls в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Live-found (driver-2, on the installed build): every one of the TK-05 slab's
// three window keys was computing `filter: drop-shadow(rgb(0,229,255) 3px 3px 0)`
// inherited from GROUP B2 вЂ” the button-wide optic offset. The caps are opaque,
// so the ghost exclusion let them through, and the shadow was INVISIBLE anyway:
// the cap's own inline clip-path is applied after the filter and eats the whole
// offset. What it cost was real, though вЂ” it contradicted the sheet's own cyan
// restraint (the slab is the one surface cyan may not touch) and promoted each
// key to its own compositing layer for a shadow that can never be seen. The fix
// is a neutral hook, `[data-chassis-key]`, excluded from B2 only.
describe('the TK-05 chassis keys are excluded from the optic offset', () => {
  const HOOK = '[data-chassis-key]'
  const sheet = readSheet('tachikoma-red-structure.css')
  const all = rules(sheet)

  it('excludes them from EVERY drop-shadow rule that reaches a button', () => {
    const shadowed = all.filter(
      (r) => /\bbutton\b/.test(r.selector) && r.body.includes('drop-shadow('),
    )
    expect(shadowed.length).toBeGreaterThan(0)
    for (const rule of shadowed) {
      expect(rule.selector, `unscoped: ${rule.selector.trim()}`).toContain(HOOK)
      // вЂ¦as a NEGATION. `:not()` is the whole point; a bare mention would be a
      // rule that targets the keys instead of sparing them.
      expect(rule.selector).toContain(`:not(${HOOK})`)
    }
  })

  it('leaves the CUT (B1) alone вЂ” the caps override it inline anyway', () => {
    // B1 is geometry and clips the border box; the caps carry their own
    // inline clip-path (the mock's key chamfer), which outranks it. Excluding
    // them there too would be dead weight in the selector.
    const b1 = all.filter(
      (r) =>
        r.selector.includes(':root[data-theme="tachikoma-red"] button:not(:disabled)') &&
        !r.selector.includes('[style*="background') &&
        !/:hover|:active|:focus/.test(r.selector) &&
        r.body.includes('clip-path'),
    )
    expect(b1.length).toBe(1)
    expect(b1[0].selector).not.toContain(HOOK)
  })

  it('is the ONLY sheet that needs the hook (it owns the TK-05 frame)', () => {
    // OpusChrome's keys are a different component in a different sheet; if this
    // ever changes, it changes deliberately and this line moves with it.
    expect(readSheet('comic-structure.css')).not.toContain(HOOK)
  })

  it('is published by the component on all three caps', () => {
    const chrome = fs.readFileSync(
      path.join(SRC_DIR, 'components/TachikomaChrome.tsx'), 'utf8',
    )
    expect((chrome.match(/data-chassis-key\b/g) ?? []).length).toBe(3)
  })
})
