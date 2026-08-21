// apps/desktop/src/components/tachikoma/tachikomaChrome.helpers.ts
//
// Pure, side-effect-free geometry for the TK-05 CHASSIS (TachikomaChrome.tsx):
// the milled slab the app plate is recessed into on the `tachikoma-red` theme.
// Kept separate from the component — like opus/opusChrome.helpers.ts — so the
// staging math can be unit-tested with no DOM and no Electron. See
// test/unit/tachikomaChrome.test.ts.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE — the chassis NEVER disappears.
//
// The retired crab chrome hid its claws below 1180px and collapsed the plate to
// full-bleed there, so at the owner's daily ~1068px window the theme's whole
// signature is simply absent. The chassis is a physical object: a narrow window
// does not make a machined slab evaporate, it makes the bezels THINNER. So there
// is no width at which any stage returns "nothing" — `chassisStage()` is total
// over every viewport, every stage keeps a positive bezel on both axes, and the
// component has no width-gated early return (asserted in the test).
//
// Instead of hiding, the chassis RESTAGES: at each step inward the bezels shrink
// and the loudest hardware (legends → hazard flash → grille/vents) is dropped,
// so the object stays recognisable while costing less of the workspace. Worst
// case is the widest stage, which spends ~17% of a 1400px window; the narrow
// stage the owner lives in spends ~7% of 1068px.

/** The theme id that owns the chassis chrome. */
export const TK_THEME = 'tachikoma-red'

/**
 * How much hardware the slab shows. Ordered from loudest to quietest — the
 * value is also what lands in the root `data-chassis` attribute, so the stage is
 * inspectable from a CDP probe / a screenshot review without reading React.
 *
 *   'wide'   ≥1400px — the full unit: vents, grille, legends, hazard flash.
 *   'mid'    ≥1180px — same hardware, hazard flash dropped.
 *   'narrow' <1180px — RESTAGED INWARD: thin bezels, keys + LED rack + bolts.
 *   'flush'  maximized — a thin machined bezel: bars, LED rack and the keys.
 */
export type ChassisStage = 'wide' | 'mid' | 'narrow' | 'flush'

/** Viewport width (px) at/above which the widest staging is used. */
export const TK_STAGE_WIDE_MIN_PX = 1400
/** Viewport width (px) at/above which the mid staging is used. */
export const TK_STAGE_MID_MIN_PX = 1180

/** Bezel thickness (px) per side: `x` = left/right flanks, `y` = top/bottom. */
export interface ChassisBezel { x: number; y: number }

/**
 * Nominal bezel per stage. The flanks are always thicker than the top/bottom:
 * the flanks carry the hardware (window keys, LED rack, vent bank) and vertical
 * space is the scarcer axis (the window's minHeight is 600px vs minWidth 900px).
 */
export const TK_BEZEL: Record<ChassisStage, ChassisBezel> = {
  wide:   { x: 116, y: 62 },
  mid:    { x: 84,  y: 46 },
  narrow: { x: 36,  y: 24 },
  flush:  { x: 14,  y: 10 },
}

/** Floor the bezel can never drop below — the slab must stay visible. */
export const TK_BEZEL_MIN: ChassisBezel = { x: 10, y: 8 }

/**
 * Width (px) of the strip along each outer window edge that the chassis DRAG
 * REGION must leave alone.
 *
 * The window is frameless (`frame: false` + `thickFrame: true`, electron/main),
 * so Windows draws the resize borders itself in a few px along the outside of
 * the window. `-webkit-app-region: drag` wins over that hit test wherever the
 * two overlap: a drag band pinned to `inset: 0` would make the whole chassis
 * grabbable and the window UNRESIZABLE from three of its four edges. So every
 * drag band starts this far in. 8px is the Windows sizing border (~4px) with
 * room for a shaky pointer.
 */
export const TK_RESIZE_EDGE_PX = 8

/** Thickness (px) of a drag band on a rail/flank of the given size — the band
 *  minus the resize strip, never negative (at the flush bezel the rail is 10px
 *  and the band is 2px: thin, but the flanks still give a real grab target). */
export function chassisDragBandPx(bezelSide: number): number {
  return Math.max(0, bezelSide - TK_RESIZE_EDGE_PX)
}

/** Share of the viewport a single flank / rail may take before the nominal
 *  bezel is clamped down. Keeps a short or narrow window usable: the whole
 *  chassis can never cost more than 2× these fractions. */
export const TK_BEZEL_MAX_RATIO_X = 0.085
export const TK_BEZEL_MAX_RATIO_Y = 0.075

/**
 * The hardware pieces the slab can carry.
 *
 * The first eight are the Phase-1 skeleton. The seven after them are the mock's
 * full inventory (notes/CHASSIS-MOCK-SPEC-2026-07-26.md):
 *
 *   'topplate'   TACHIKOMA-RED / UNIT TK-05 · RED CRAB VARIANT name plate.
 *   'ventstrip'  perforated INTAKE · PASSIVE strip in the top rail.
 *   'ledblock'   SERVO OPTIC LINK GPU NET PWR indicator block, top-right.
 *   'marking'    TK-05 · ONE OPERATOR vertical marking on the left flank.
 *   'hazardband' full-width hazard flash + DO NOT OPEN · SANDBOXED RENDERER.
 *   'status'     the bottom status lines (PWR/LINK/SEC, licence, S/N, kanji).
 *   'wheel'      the drive wheel on the right flank.
 */
export type ChassisFeature =
  | 'bars' | 'bolts' | 'leds' | 'keys' | 'vents' | 'grille' | 'legends' | 'hazard'
  | 'topplate' | 'ventstrip' | 'ledblock' | 'marking' | 'hazardband' | 'status' | 'wheel'

/**
 * Which pieces each stage draws. `bars` (the slab itself) is in every stage —
 * that is the "never disappears" contract in data form — and so are the
 * inventory pieces that CARRY the unit's identity: the name plate, the LED
 * block and the status line survive down to the flush bezel.
 *
 * A piece leaving this list is not the same thing as a caption disappearing:
 * text degrades to an LED bar through `chassisCaptionMode` / `chassisStatusMode`
 * instead of vanishing (the mock's caption 1b: "chips truncate to their LED
 * bars"). What drops out here is only hardware that needs real room to read as
 * hardware — the vent louvres, the grille, the free-standing silkscreen and the
 * wheel.
 */
export const TK_FEATURES: Record<ChassisStage, readonly ChassisFeature[]> = {
  wide: [
    'bars', 'bolts', 'leds', 'keys', 'vents', 'grille', 'legends', 'hazard',
    'topplate', 'ventstrip', 'ledblock', 'marking', 'hazardband', 'status', 'wheel',
  ],
  mid: [
    'bars', 'bolts', 'leds', 'keys', 'vents', 'grille', 'legends',
    'topplate', 'ventstrip', 'ledblock', 'marking', 'hazardband', 'status',
  ],
  narrow: [
    'bars', 'bolts', 'leds', 'keys',
    'topplate', 'ventstrip', 'ledblock', 'marking', 'hazardband', 'status',
  ],
  // 'keys' is in EVERY stage on purpose: the structure sheet hides the
  // TitleBar's own −□✕ row whenever the chassis mounts its keys, so these are
  // the only window controls on screen — dropping them from a stage means a
  // window with ZERO controls (live-found at maximized). At flush the 14px
  // flank takes the 14px minimum key edge-to-edge; tight, but real.
  flush: ['bars', 'leds', 'topplate', 'ledblock', 'status', 'keys'],
}

/** True only for the chassis theme. */
export function isTachikomaTheme(theme: string | null | undefined): boolean {
  return theme === TK_THEME
}

const clamp = (min: number, v: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * Which staging a viewport gets. TOTAL — every input maps to a stage, there is
 * no null / "hidden" case, which is exactly what keeps the chassis on screen at
 * the owner's ~1068px daily width.
 *
 * WIDTH DECIDES, MAXIMIZED DOES NOT (owner directive, 2026-07-27): the owner
 * runs the app maximized on a 2560px display and the old `maximized → flush`
 * short-circuit collapsed the whole SLAB into a thin rim — "рамки пропали".
 * A maximized 2560px window has MORE room for the 62px bezels, not less, so
 * the red chassis now stages purely by width and keeps its body everywhere.
 * The thin-at-maximized behaviour survives only on the OPUS-5 theme, whose
 * layout has its own ladder — the owner explicitly wants thinness there alone.
 * `flushOnMaximized` opts the OLD behaviour back in — opusLayout passes true,
 * so the OPUS-5 thin frame is the only place maximized still means flush.
 */
export function chassisStage(opts: { width: number; maximized: boolean; flushOnMaximized?: boolean }): ChassisStage {
  if (opts.maximized && opts.flushOnMaximized) return 'flush'
  if (opts.width >= TK_STAGE_WIDE_MIN_PX) return 'wide'
  if (opts.width >= TK_STAGE_MID_MIN_PX) return 'mid'
  return 'narrow'
}

/**
 * Bezel thickness for a stage on a given viewport: the stage's nominal value,
 * clamped so it never eats more than TK_BEZEL_MAX_RATIO_* of the axis and never
 * falls under TK_BEZEL_MIN. Values are whole pixels — a fractional inset makes
 * the counterbore seam land on a half-pixel and blur.
 */
export function chassisBezel(
  stage: ChassisStage,
  viewport?: { width: number; height: number },
): ChassisBezel {
  const nominal = TK_BEZEL[stage]
  if (!viewport) return nominal
  return {
    x: clamp(TK_BEZEL_MIN.x, Math.floor(viewport.width * TK_BEZEL_MAX_RATIO_X), nominal.x),
    y: clamp(TK_BEZEL_MIN.y, Math.floor(viewport.height * TK_BEZEL_MAX_RATIO_Y), nominal.y),
  }
}

/** Whether a stage draws a given piece of hardware. */
export function hasChassisFeature(stage: ChassisStage, feature: ChassisFeature): boolean {
  return TK_FEATURES[stage].includes(feature)
}

/**
 * Everything the renderer needs, or null when the theme is not ours (the ONLY
 * null this module produces — a wrong theme, never a small window).
 */
export function chassisLayout(opts: {
  theme: string | null | undefined
  width: number
  height: number
  maximized: boolean
}): { stage: ChassisStage; bezel: ChassisBezel } | null {
  if (!isTachikomaTheme(opts.theme)) return null
  const stage = chassisStage({ width: opts.width, maximized: opts.maximized })
  return { stage, bezel: chassisBezel(stage, { width: opts.width, height: opts.height }) }
}

/** Outer-corner chamfer (px) of the slab — the mech panel cut, scaled per stage
 *  so a thin bezel does not get a chamfer deeper than it is thick. */
export function chassisChamferPx(stage: ChassisStage, bezel: ChassisBezel): number {
  const nominal = stage === 'wide' ? 20 : stage === 'mid' ? 16 : stage === 'narrow' ? 10 : 6
  // A chamfer taller than the bar would cut the bar in half.
  return Math.max(4, Math.min(nominal, bezel.y - 2))
}

/** Edge length (px) of one physical window key, derived from the flank it sits
 *  in: the key well needs ~7px of clearance on each side. */
export function chassisKeySizePx(bezelX: number): number {
  return clamp(14, bezelX - 14, 30)
}

/** Diameter (px) of a corner bolt head. */
export function chassisBoltPx(stage: ChassisStage): number {
  return stage === 'narrow' ? 7 : 10
}

/** Diameter (px) of the drive wheel on the right flank, derived from the flank
 *  it is bolted to (it needs ~8px of clearance per side). */
export function chassisWheelPx(bezelX: number): number {
  return clamp(12, bezelX - 16, 30)
}

/**
 * Padding (px) between the key well's wall and the caps inside it.
 *
 * ~18% of the cap, but NEVER more than the flank can hold: at the flush bezel
 * the flank is 14px and the cap takes all of it, so a nominal 3px pad made the
 * well 20px wide inside a 14px flank — 6px of it (and 3px of every cap) ended up
 * BEHIND the app plate, which globals.css lifts to z-index 5. Sizing the pad
 * from the room that is actually left keeps the whole well inside the flank at
 * every stage, and at flush it parks the caps hard against the window edge —
 * which is where Windows puts the controls of a maximized window anyway.
 */
export function chassisKeyWellPadPx(keySize: number, bezelX: number): number {
  const nominal = Math.max(3, Math.round(keySize * 0.18))
  const room = Math.floor((bezelX - keySize) / 2)
  return Math.max(0, Math.min(nominal, room))
}

// ── The physical keys' finish — the ONE control that may carry light ─────────
//
// Everywhere but `flush` the caps are MOULDED DARK: near-black plastic in a sunk
// well on a 36–116px flank, read by their relief lip and the KEYS stencil under
// them. That is the mock's own key (`Tachi OPUS-5.dc.html` L330-331:
// `border:2px solid #6b4650; background:#1b0c10`) and it works because there is
// metal all around it.
//
// AT FLUSH THERE IS NO METAL. The flank collapses to 14px, the stencil is gone
// (the caption is in `bar` mode below 16px) and the TitleBar's own row is hidden
// by the `[data-chassis-keys="1"]` interlock — so these three caps ARE the
// window's only controls, and dark-on-dark measured 1.14:1 against the well
// behind them: a maximized TK-05 had effectively UNFINDABLE window controls
// (live-found, driver-2). So the flush caps are LIT: the face is the lit pair of
// the slab's own key-light gradient (`#9c757f`/`#8a616d`, mock L210) raked down
// to the shaded end of the shared billet (`#7a5560`, mock L229) — the caps are
// machined out of the same metal as the body, they are simply the part of it
// that catches the light — and the close key takes the alarm ink the mock's
// `.key-x` uses (`#ff2b6b` = `--danger`, mock L332, and its hover L260).
//
// NOT CYAN, DELIBERATELY. The cyan-restraint law reserves the optic for the
// lamps and the screen; a physical control may carry light, but it carries the
// unit's OWN light. The engraving flips to the chassis black on a lit cap for
// the same reason a real key does: light face, dark mark.
//
// The measured targets (WCAG 1.4.11 non-text contrast, 3:1) are pinned in
// test/unit/tachikomaChrome.test.ts, which resolves the `var(--…)` inks out of
// tachikoma-red.css and computes the ratios — so a palette change that made the
// keys invisible again would fail the suite rather than the user.
export interface ChassisKeyFinish {
  /** True only at `flush`, where the caps are the sole window controls. */
  lit: boolean
  /** The sunk well the caps sit in — the surface a cap must contrast against. */
  wellFill: string
  /** Flat fill of a minimise / maximise cap (what the contrast test measures). */
  capFill: string
  /** Its raking face gradient, painted over that fill. */
  capImage: string
  /** Flat fill + face of the close cap. */
  closeFill: string
  closeImage: string
  /** Engraving inks: the marks, the restore key's ghost box, the close cross. */
  glyph: string
  glyphMuted: string
  closeGlyph: string
  /** The relief span's seating rim (a CHILD's inset box-shadow — the cap itself
   *  is clipped, and an outer shadow on it would be sheared along the chamfer). */
  rim: string
}

export const TK_KEY_FINISH: Record<'dressed' | 'lit', ChassisKeyFinish> = {
  dressed: {
    lit: false,
    wellFill: 'rgba(4,2,3,0.85)',
    capFill: 'rgba(30,21,24,0.98)',
    capImage: 'linear-gradient(155deg, rgba(52,37,41,0.95), rgba(18,12,14,0.98) 58%, rgba(9,6,7,1))',
    closeFill: 'rgba(30,21,24,0.98)',
    closeImage: 'linear-gradient(155deg, rgba(52,37,41,0.95), rgba(18,12,14,0.98) 58%, rgba(9,6,7,1))',
    glyph: 'var(--text-primary)',
    glyphMuted: 'var(--text-dim)',
    closeGlyph: 'var(--danger)',
    rim: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.9)',
  },
  lit: {
    lit: true,
    // Opaque, not the 0.85 wash: at flush the well is 14px wide and every point
    // of contrast between it and a cap has to come from the two fills.
    wellFill: '#050304',
    // EVERY STOP CLEARS THE BAR, not just the flat fill: a raking gradient whose
    // shaded end fell back to the chassis grey would leave the bottom third of
    // each cap as invisible as before. All three are the slab's own literals —
    // the key-light stops of `.slab-edge` (mock L210) and the shaded end of the
    // shared `.metal` billet (mock L229).
    capFill: '#8a616d',
    capImage: 'linear-gradient(155deg,#9c757f 0%,#8a616d 52%,#7a5560 100%)',
    closeFill: 'var(--danger)',
    closeImage: 'linear-gradient(155deg,#ff6c98 0%,#ff2b6b 46%,#c8163c 100%)',
    glyph: 'var(--bg-base)',
    glyphMuted: 'rgba(10,7,8,0.55)',
    closeGlyph: 'var(--bg-base)',
    rim: 'inset 0 0 0 1px rgba(5,3,4,0.85), inset 0 1px 0 rgba(255,255,255,0.34)',
  },
}

/** Which finish a stage's caps take. */
export function chassisKeyFinish(stage: ChassisStage): ChassisKeyFinish {
  return stage === 'flush' ? TK_KEY_FINISH.lit : TK_KEY_FINISH.dressed
}

// ── Caption degradation: RESTAGE, never hide ─────────────────────────────────
//
// The mock's own caption for the 1068px frame is explicit: "Rail narrows, chips
// truncate to their LED bars". So a caption that no longer fits does not get
// removed — it is REPLACED by the LED bar that stands for it. That is why the
// modes below are a rendering decision (a function of the room available) and
// NOT another entry in TK_FEATURES: a feature that only existed on the small
// stage would break the strict-subset staging chain, and "the legend is gone"
// and "the legend is now a bar" are different products.

/** Silkscreen height budget: 8px type on a 1.0 line box plus its 4px lip
 *  clearance top and bottom. Below this a rail cannot hold a legible caption. */
export const TK_CAPTION_MIN_PX = 16

/** How a silkscreen caption renders.
 *   'full'  the whole marking            (TACHIKOMA-RED · UNIT TK-05 · RED CRAB VARIANT)
 *   'short' the designation only         (TK-05)
 *   'bar'   an LED bar standing in for it (no text at all) */
export type ChassisCaptionMode = 'full' | 'short' | 'bar'

/** Caption mode for a stage on a given rail thickness. */
export function chassisCaptionMode(stage: ChassisStage, bezelY: number): ChassisCaptionMode {
  if (bezelY < TK_CAPTION_MIN_PX) return 'bar'
  if (!hasChassisFeature(stage, 'legends')) return 'bar'
  return stage === 'wide' ? 'full' : 'short'
}

/** Rail thickness (px) needed for the status block's two stacked text rows
 *  (hazard flash + 2 × 8px rows + lips). */
export const TK_STATUS_STACK_MIN_PX = 34
/** Rail thickness (px) needed for a single status row. */
export const TK_STATUS_LINE_MIN_PX = 14

/** How the bottom status block renders.
 *   'stacked' hazard flash + two text rows (the full mock inventory)
 *   'single'  one row: LINK + SEC + S/N
 *   'bar'     LED bars only — the rail is thinner than one line of type */
export type ChassisStatusMode = 'stacked' | 'single' | 'bar'

/** Status mode for a given bottom-rail thickness. */
export function chassisStatusMode(bezelY: number): ChassisStatusMode {
  if (bezelY >= TK_STATUS_STACK_MIN_PX) return 'stacked'
  if (bezelY >= TK_STATUS_LINE_MIN_PX) return 'single'
  return 'bar'
}

// ── THE SLAB — one continuous machined body ──────────────────────────────────
//
// The 2a frame in the mock (`Tachi OPUS-5.dc.html`, the `.tkred .slab*` block)
// is NOT a rectangle with things stuck to it. It is ONE asymmetric silhouette
// drawn five times — edge / lip / face / seam / inner, each inset a little
// further and all sharing the SAME clip-path polygon, so the stack reads as a
// real machined chamfer instead of a neon outline — with a raking key light
// painted last on top.
//
// The mock states the geometry at ONE size: a 1428×932 shell around a 1280×800
// panel, bezels 56/62/92/70, and a literal 31-vertex polygon. A single hardcoded
// polygon would break the chassis' one law (restage, never hide), so the shape
// is DERIVED here instead: the vertex POSITIONS are the mock's own fractions of
// 1428×932, and every CUT DEPTH is derived from the stage's bezel. Feed it the
// wide stage and it reproduces the mock's numbers almost exactly (chamfer 72,
// tray 15/20, mandible 22, bays 30/28, feet 40/22); feed it the flush bezel and
// the same silhouette survives with shallow cuts.
//
// The invariant that makes that safe — and that the unit test pins by ray-casting
// every stage at every viewport — is that NO CUT MAY REACH THE SCREEN: every
// depth is a fraction < 1 of the bezel it bites into, and the two corner
// diagonals are proportioned so the plate's corners stay inside the body.

/** The mock's own shell, the size every fraction below was measured at. */
export const TK_MOCK_W = 1428
export const TK_MOCK_H = 932

/** Where each silhouette layer sits, in px in from the slab's outer edge:
 *  lip = the dark valley of the bevel, face = the anodised body, seam = the 1px
 *  parting line of a two-piece shell, inner = the body again (so the seam reads
 *  as a LINE and not as a border). `inner` is always `seam + 1`. */
export interface SlabInsets { lip: number; face: number; seam: number; inner: number }

/**
 * The five insets for a rail thickness. At the wide stage's 62px rail this
 * returns the mock's literal 5 / 7 / 20 / 21; below that every band shrinks but
 * the ORDER is preserved (lip < face < seam < inner) and `inner` is kept at
 * least 1px clear of the plate edge, so the parting line never hides under the
 * app plate at the flush bezel.
 */
export function chassisSlabInsets(bezelY: number): SlabInsets {
  const t = Math.max(0, bezelY)
  const lip = clamp(2, Math.round(t * 0.08), 5)
  const face = Math.max(lip + 1, clamp(3, Math.round(t * 0.113), 7))
  const seam = Math.min(
    Math.max(face + 2, clamp(6, Math.round(t * 0.32), 20)),
    Math.max(face + 1, t - 2),
  )
  return { lip, face, seam, inner: seam + 1 }
}

/** A span milled out of one edge of the body: where it starts along that edge,
 *  how long it is, and how deep it bites in. `null` when the viewport got too
 *  small for the feature to survive as anything but a fold in the clip. */
export interface SlabCut { at: number; span: number; depth: number }

/**
 * The milled features of the silhouette, in px.
 *
 * This is what makes "NOTHING FLOATS" mechanical rather than a promise: the
 * hardware in TachikomaChrome.tsx is positioned FROM these numbers (the intake
 * louvres sit in `tray`, the LED rack answers `mandible`, the grille and the
 * hazard flash start where the bottom shears end), so a change to the silhouette
 * moves the hardware with it instead of leaving it hanging over a cut.
 */
export interface SlabCuts {
  /** Leg length of the 45° top-left chamfer. */
  chamfer: number
  /** Horizontal / vertical legs of the bottom-left and bottom-right shears. */
  shearBl: { x: number; y: number }
  shearBr: { x: number; y: number }
  /** Depth of the two foot gaps in the bottom edge. */
  foot: number
  tray: SlabCut | null
  mandible: SlabCut | null
  rightBay: SlabCut | null
  leftBay: SlabCut | null
}

/** A silhouette: the vertex list (for geometry tests), the milled feature list
 *  the hardware bolts onto, and the ready CSS value every layer shares. */
export interface SlabPolygon {
  points: ReadonlyArray<readonly [number, number]>
  cuts: SlabCuts
  path: string
}

/** Fractional vertex positions, straight off the mock's polygon at 1428×932. */
const SLAB_F = {
  trayA: 470 / TK_MOCK_W, trayB: 820 / TK_MOCK_W,          // top intake tray
  mandA: 1150 / TK_MOCK_W, mandB: 1186 / TK_MOCK_W,        // mandible step
  rBayA: 240 / TK_MOCK_H, rBayB: 420 / TK_MOCK_H,          // right port bay
  lBayA: 374 / TK_MOCK_H, lBayB: 566 / TK_MOCK_H,          // left port bay
  footA1: 930 / TK_MOCK_W, footA2: 1120 / TK_MOCK_W,       // right foot gap
  footB1: 280 / TK_MOCK_W, footB2: 470 / TK_MOCK_W,        // left foot gap
} as const

/**
 * The one polygon every slab layer shares.
 *
 * Clockwise from the top-left chamfer: the chamfer, the intake tray, the
 * mandible step at the top-right, the right port bay, the bottom-right shear,
 * the two feet, the bottom-left shear and the left port bay.
 *
 * A feature whose span has collapsed at a tiny viewport is SKIPPED rather than
 * emitted inverted — an inverted vertex pair would fold the clip inside out and
 * punch a hole through the middle of the body.
 */
export function chassisSlabPolygon(opts: {
  width: number
  height: number
  bezel: ChassisBezel
}): SlabPolygon {
  const w = Math.max(1, Math.round(opts.width))
  const h = Math.max(1, Math.round(opts.height))
  const bx = Math.max(1, opts.bezel.x)
  const by = Math.max(1, opts.bezel.y)
  const fx = (f: number) => Math.round(w * f)
  const fy = (f: number) => Math.round(h * f)

  // Every depth is a FRACTION OF THE BEZEL it bites into, which is what keeps
  // the cut off the plate at every stage. The caps are the mock's own numbers.
  const cham = clamp(8, Math.round((bx + by) * 0.62), 72)
  const trayD = clamp(2, Math.round(by * 0.24), 15)
  const trayR = clamp(3, Math.round(by * 0.32), 20)
  const mandD = clamp(3, Math.round(by * 0.355), 22)
  const bayD = clamp(3, Math.round(bx * 0.33), 30)
  const bayR = clamp(3, Math.round(by * 0.45), 28)
  const shearBrY = clamp(10, Math.round(by * 3.2), 202)
  const shearBrX = clamp(6, Math.round(bx * 0.85), 98)
  const shearBlX = clamp(6, Math.round(bx * 1.3), 150)
  const shearBlY = clamp(10, Math.round(by * 2.1), 132)
  const footD = clamp(4, Math.round(by * 0.645), 40)
  const footR = clamp(3, Math.round(footD * 0.55), 22)

  /** A ramp can never exceed half the span it ramps into. */
  const ramp = (a: number, b: number, r: number) =>
    Math.max(0, Math.min(r, Math.floor((b - a) / 2) - 1))

  const pts: Array<readonly [number, number]> = []
  const p = (x: number, y: number) => { pts.push([x, y] as const) }
  const cuts: SlabCuts = {
    chamfer: cham,
    shearBl: { x: shearBlX, y: shearBlY },
    shearBr: { x: shearBrX, y: shearBrY },
    foot: footD,
    tray: null, mandible: null, rightBay: null, leftBay: null,
  }

  // Top-left chamfer.
  p(0, cham); p(cham, 0)

  // Top edge — the intake tray, then the mandible step.
  const tA = fx(SLAB_F.trayA), tB = fx(SLAB_F.trayB)
  if (tA - cham >= 6 && tB - tA >= 10) {
    const r = ramp(tA, tB, trayR)
    p(tA, 0); p(tA + r, trayD); p(tB - r, trayD); p(tB, 0)
    cuts.tray = { at: tA + r, span: (tB - r) - (tA + r), depth: trayD }
  }
  const mA = fx(SLAB_F.mandA), mB = fx(SLAB_F.mandB)
  if (mA - Math.max(cham, tB) >= 6 && mB - mA >= 4 && w - mB >= 6) {
    p(mA, 0); p(mA, mandD); p(mB, mandD); p(mB, 0)
    cuts.mandible = { at: mA, span: mB - mA, depth: mandD }
  }
  p(w, 0)

  // Right flank — the port bay bitten out of the edge.
  const rA = fy(SLAB_F.rBayA), rB = fy(SLAB_F.rBayB)
  if (rA >= 8 && rB - rA >= 10 && h - shearBrY - rB >= 8) {
    const r = ramp(rA, rB, bayR)
    p(w, rA); p(w - bayD, rA + r); p(w - bayD, rB - r); p(w, rB)
    cuts.rightBay = { at: rA + r, span: (rB - r) - (rA + r), depth: bayD }
  }

  // Bottom-right shear, the two feet, bottom-left shear.
  p(w, h - shearBrY); p(w - shearBrX, h)
  const aA = fx(SLAB_F.footA1), aB = fx(SLAB_F.footA2)
  if (w - shearBrX - aB >= 6 && aB - aA >= 12) {
    const r = ramp(aA, aB, footR)
    p(aB, h); p(aB - r, h - footD); p(aA + r, h - footD); p(aA, h)
  }
  const bA = fx(SLAB_F.footB1), bB = fx(SLAB_F.footB2)
  if (aA - bB >= 6 && bB - bA >= 12 && bA - shearBlX >= 6) {
    const r = ramp(bA, bB, footR)
    p(bB, h); p(bB - r, h - footD); p(bA + r, h - footD); p(bA, h)
  }
  p(shearBlX, h); p(0, h - shearBlY)

  // Left flank — the mirrored port bay, travelling back up to the chamfer.
  const lA = fy(SLAB_F.lBayA), lB = fy(SLAB_F.lBayB)
  if (lA - cham >= 8 && lB - lA >= 10 && h - shearBlY - lB >= 8) {
    const r = ramp(lA, lB, bayR)
    p(0, lB); p(bayD, lB - r); p(bayD, lA + r); p(0, lA)
    cuts.leftBay = { at: lA + r, span: (lB - r) - (lA + r), depth: bayD }
  }

  return {
    points: pts,
    cuts,
    path: `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(',')})`,
  }
}

// ── The bottom rail — the grille and the legends that must clear it ─────────
//
// MOCK AUTHORITY (`Tachi OPUS-5.dc.html`, frame 2a, on the 1428×932 shell):
//   L340  grille    left 152, top 870, 128 × 44
//   L341  etch  ACOUSTIC 2W                      left 152, top 920
//   L342  hazard    left 286, top 870, 184 × 8
//   L343  etch  DO NOT OPEN · SANDBOXED RENDERER left 286, top 884
//   L344  rule      left 286, top 902, 184 × 1
//
// Read them together and the rail has TWO columns: the perforated panel runs
// 152→280 with its own rating stencilled UNDER it at the same x, and every other
// bottom-rail legend starts at 286 — 6px clear of the panel. Nothing is printed
// on top of the speaker.
//
// The first cut of the rail lost that: the status rows started at `bezel.x + 4`
// (120px at the wide stage) while the grille started at `shearBl.x + 8` (158px),
// so the SANDBOXED RENDERER stencil painted straight across the middle of the
// perforated panel — grille [158,847,126,31] under legend [120,856,187,8],
// measured on the installed build (driver-2). The grille's band is therefore
// computed HERE, once, and the status block's left margin is derived FROM it, so
// the two can never be laid out against different numbers again.

/** Panel width as a fraction of the shell — mock L340: 128/1428. */
export const TK_GRILLE_W_F = 128 / TK_MOCK_W
/** Clearance between the panel and the first legend — mock L340 vs L342/L343:
 *  the grille ends at 280, the hazard flash and the stencil start at 286. */
export const TK_GRILLE_GAP_F = 6 / TK_MOCK_W
/** …and never less than this, so a narrow window keeps a readable parting. */
export const TK_GRILLE_GAP_MIN_PX = 6

/** Where the acoustic grille sits on the bottom rail, in px from the left. */
export interface SlabGrille { left: number; width: number; right: number }

/**
 * The grille's band. It starts where the bottom-left shear ends (+8px of lip),
 * so the panel can never hang over a corner the polygon has already cut away,
 * and it is the mock's own fraction of the shell wide.
 */
export function chassisGrilleBand(opts: { width: number; shearBlX: number }): SlabGrille {
  const w = Math.max(1, Math.round(opts.width))
  const left = Math.max(0, Math.round(opts.shearBlX)) + 8
  const width = Math.max(40, Math.round(w * TK_GRILLE_W_F))
  return { left, width, right: left + width }
}

/**
 * Left margin (px) for the bottom rail's legends: the nominal flank inset, or
 * clear of the grille when one is milled — whichever is further in. At the wide
 * stage on a 1400px window this returns 290px against the mock's own 286.
 */
export function chassisStatusLeftPx(opts: {
  width: number
  inset: number
  grille: SlabGrille | null
}): number {
  if (!opts.grille) return opts.inset
  const gap = Math.max(
    TK_GRILLE_GAP_MIN_PX,
    Math.round(Math.max(1, opts.width) * TK_GRILLE_GAP_F),
  )
  return Math.max(opts.inset, opts.grille.right + gap)
}

/** Loopback port the local OpenAI-compatible API server listens on when it has
 *  not reported one yet (see `window.tachi.apiServer.status()`); matches the
 *  documented default in electron/api-server. */
export const TK_DEFAULT_API_PORT = 11435

/**
 * The LINK legend on the bottom rail — REAL data when the local API server has
 * reported a port, the documented default otherwise. Pure so the formatting is
 * testable without an Electron bridge.
 */
export function chassisLinkLabel(port: number | null | undefined): string {
  const p = typeof port === 'number' && Number.isFinite(port) && port > 0
    ? Math.floor(port)
    : TK_DEFAULT_API_PORT
  return `127.0.0.1:${p}`
}

// ── The lamps — every cell is a real reading, or it is dark ──────────────────
//
// THE HONESTY LAW, applied to hardware (the same one ChassisSidebarPanel's
// header states for the sidebar gauges): a lamp stencilled with a name claims to
// report that thing. Until this batch the TK-05 rack claimed six: SERVO, OPTIC,
// LINK, GPU, NET and PWR were all hardcoded — five permanently lit and one
// permanently dead — so the block was a PICTURE of an instrument, and the OPTIC
// cell animated `box-shadow` (a paint property) forever to sell it.
//
// The rule now has no decorative branch. A cell is wired to a signal the shell
// can actually read for free, or it is a DEAD CELL — dark metal in its housing,
// which is what a real indicator block looks like when that subsystem has no
// sensor on this unit. Nothing here may cost a timer: every source below is
// either a store the shell already subscribes to, one IPC call the chrome
// already makes, or an OS event.
//
// This is deliberately theme-agnostic (it names no colour and no geometry) and
// deliberately NOT merged with the OPUS frame's `LAMPS` table — that frame's
// lamps are a different inventory on a different mock, and the sibling lane owns
// them. What the two share is `chassisRunActive`, which stays in the opus
// helpers where it was written.

/** Where one lamp gets its state.
 *   run    a harness run, a Nodes run or a streaming answer (chassisRunActive)
 *   link   the local OpenAI-compatible API server reported itself running
 *   net    the OS says this machine has a network link (navigator.onLine)
 *   power  the renderer is executing — the one tautology, and a true one
 *   dead   NO source exists for this reading on this unit; the cell never lights
 */
export type ChassisLampSource = 'run' | 'link' | 'net' | 'power' | 'dead'

/** What the shell can tell the rack, all optional so a caller may wire one lamp
 *  without pretending to know the others (absent reads as "not lit"). */
export interface ChassisLampSignals {
  /** `chassisRunActive({ agentStatus, nodesRunning, chatStreaming })`. */
  runActive?: boolean
  /** `window.tachi.apiServer.status()` answered `running: true`. */
  linkUp?: boolean
  /** `navigator.onLine` — a LINK reading, never a reachability one. */
  online?: boolean
}

/**
 * Is this lamp lit? Pure, so the whole truth table is a unit test instead of
 * something you reproduce by starting a run and pulling an ethernet cable.
 *
 * `power` is the one cell that answers `true` unconditionally, and it is not an
 * invented reading: the function only runs inside a renderer that is executing,
 * so "this unit has power" is observably true whenever the lamp can be seen at
 * all. `dead` is its opposite and the escape hatch that keeps the rest honest —
 * a cell with no source is dark, never dressed up as one that has one.
 */
export function chassisLampLit(source: ChassisLampSource, s: ChassisLampSignals): boolean {
  switch (source) {
    case 'run':   return !!s.runActive
    case 'link':  return !!s.linkUp
    case 'net':   return !!s.online
    case 'power': return true
    case 'dead':  return false
  }
}
