// apps/desktop/src/components/opus/opusChrome.helpers.ts
//
// Pure, side-effect-free geometry for the OPUS-5 CHASSIS REV 5 frame
// (OpusChrome.tsx): the chartreuse-perimeter instrument frame the app plate is
// recessed into on the `tachi-opus5` theme. Same split as
// tachikoma/tachikomaChrome.helpers.ts — the staging math is unit-testable with
// no DOM and no Electron (test/unit/opusChrome.test.ts).
//
// THE LADDER IS SHARED, THE BEZEL TABLE IS NOT (2026-07-27, owner directive).
// Both frames are the same physical idea (a slab with the app counterbored into
// it), so the restage-inward LADDER — the 1400 / 1180 thresholds, the ratio
// clamps, the whole-pixel rule — is still imported from the TK-05 helpers rather
// than forked: fixing the ladder fixes both themes.
//
// What is NOT shared any more is how much metal each stage spends. OPUS-5 was
// borrowing TK_BEZEL, which is a SLAB's table (116/62 wide, 84/46 mid) because
// the TK-05 frame has vents, a grille, a hazard flash and a drive wheel to put
// somewhere. The OPUS-5 mock has none of that: its 1b frame is a THIN instrument
// rim — a 2px acid rule, a 30px header row, ~16px flanks carrying one vertical
// bay stencil each, and a bottom strip with `ENTER run task` / `P·04 INPUT`.
// Rendered with the slab's table it ate ~120px per side at 1516×912, which is
// the frame the owner circled ("обрежь рамку"). OPUS_BEZEL below is the mock's
// own geometry; the DRESSING (compartment labels, the crab engraving, the header
// rack) is what always lived in this file and is unchanged.
//
// The two frames also share the root `data-chassis` attribute and therefore the
// `[data-chassis] .app-body` recess block in globals.css: the attribute means
// "the plate is inset by --chassis-inset-*", which is true for both. Only one of
// the two components is ever live (each returns null on a foreign theme) and
// each writes the attribute ONLY while active, so there is no hand-off race —
// see the comment on the effect in TachikomaChrome.tsx.
import {
  chassisStage, TK_BEZEL_MIN, TK_BEZEL_MAX_RATIO_X, TK_BEZEL_MAX_RATIO_Y,
  type ChassisStage, type ChassisBezel, type ChassisCaptionMode,
} from '../tachikoma/tachikomaChrome.helpers'

/** The theme id that owns the OPUS-5 frame. */
export const OPUS_THEME = 'tachi-opus5'

/** True only for the OPUS-5 theme. */
export function isOpusTheme(theme: string | null | undefined): boolean {
  return theme === OPUS_THEME
}

const clamp = (min: number, v: number, max: number) => Math.min(max, Math.max(min, v))

// ── The bezel — THE THIN RIM, at every stage ─────────────────────────────────
//
// Read straight off mock 1b (`Tachi OPUS-5.dc.html`, the `.opus5` panel):
//
//   TOP     a 30px header row — badge, `CHASSIS REV 5 · <w> × <h>`, the dotted
//           rule, the 5-cell LED rack + `RUN IO NET PRV PWR`, the window keys.
//           30px is not a taste, it is what that row needs: the rack stacks a
//           6px cell over an 8px legend, and the key well is 16-26px tall.
//   FLANKS  a strip wide enough for ONE vertical 8px bay stencil and the 2px
//           acid rule — 16px. The mock prints `P·01 NAV` at ~10px of glyph box.
//   BOTTOM  a 24px hint bar — `ENTER run task` on the left, the dotted rule,
//           `P·04 INPUT` on the right. SIX PX THINNER THAN THE HEADER, which is
//           what the mock draws and what the row needs: the header rail has to
//           stack a 6px LED cell over an 8px legend and hold a 20px key well,
//           the hint bar holds one 8px line of type. It used to be drawn at the
//           TOP rail's thickness — the one deliberate deviation from the mock —
//           because the shared recess rule spent a SINGLE vertical custom
//           property on both edges. That rule now takes three
//           (`inset: var(--chassis-inset-top) var(--chassis-inset-x)
//           var(--chassis-inset-bottom)`), TachikomaChrome stamps its symmetric
//           slab into both, and this table finally gets to differ.
//
// WHY EVERY STAGE IS THE SAME NUMBER. The TK-05 ladder sheds hardware as the
// window narrows because the slab HAS hardware to shed (vents, grille, wheel).
// This frame is one rim with a header on it: there is nothing to shed, and a
// 16px flank is already at the floor of "can a bay stencil be printed on it".
// So the wide / mid / narrow rows are identical on purpose — the STAGE LADDER
// still runs (the value lands in `data-chassis`, drives the caption ladder and
// the ruler/legend gates, and `flushOnMaximized` still resolves), it simply no
// longer buys thicker metal. `flush` keeps a genuinely thinner rim because that
// is the whole reason the owner asked for thin-at-maximized on this theme.
/**
 * The OPUS rim's THREE thicknesses. Extends `ChassisBezel` rather than replacing
 * it, so every consumer that only ever needed the flanks and the header rail
 * (`opusFrameBitePx`, `chassisChamferPx`, `opusEngraveInsetPx`) keeps taking the
 * shared type and keeps working unchanged — the bottom is additive.
 */
export interface OpusBezel extends ChassisBezel {
  /** The HINT rail (px). Thinner than `y`: see the BOTTOM note above. */
  bottom: number
}

export const OPUS_BEZEL: Record<ChassisStage, OpusBezel> = {
  wide:   { x: 16, y: 30, bottom: 24 },
  mid:    { x: 16, y: 30, bottom: 24 },
  narrow: { x: 16, y: 30, bottom: 24 },
  flush:  { x: 12, y: 24, bottom: 20 },
}

/**
 * Bezel thickness for a stage on a given viewport. Same law as `chassisBezel`
 * and deliberately built out of the SAME constants — the nominal value, capped
 * at TK_BEZEL_MAX_RATIO_* of the axis so a tiny window is never mostly frame,
 * floored at TK_BEZEL_MIN so the rim can never vanish, whole pixels so the
 * counterbore seam does not land on a half-pixel and blur. Only the TABLE it
 * reads is this theme's own.
 *
 * In practice the ratio cap is inert at the window's own minimum size (600px of
 * height gives 45px against a 30px nominal); it only bites on a viewport far
 * shorter than the app allows, and there it shrinks the rail rather than
 * shearing what is printed on it — the rack legend, the ruler and the corner
 * bite all re-derive off the value this returns.
 *
 * THE TWO RAILS ARE CLAMPED BY THE SAME EXPRESSION, which is what keeps
 * `bottom <= y` true without a second guard: the cap and the floor are shared,
 * so the only thing that can separate them is the nominal table (where the
 * bottom is strictly thinner at every stage — pinned by the suite). On a
 * viewport short enough for the cap to bite, both rails land ON the cap and the
 * two become EQUAL; below that they meet at TK_BEZEL_MIN.y. That is correct and
 * deliberate: a 6px difference is a design intent, not a floor, and the last
 * thing a 240px-tall window needs is a bottom rail 6px under the minimum the
 * rest of the frame is already clamped to.
 */
export function opusBezel(
  stage: ChassisStage,
  viewport?: { width: number; height: number },
): OpusBezel {
  const nominal = OPUS_BEZEL[stage]
  if (!viewport) return nominal
  const railCap = Math.floor(viewport.height * TK_BEZEL_MAX_RATIO_Y)
  return {
    x: clamp(TK_BEZEL_MIN.x, Math.floor(viewport.width * TK_BEZEL_MAX_RATIO_X), nominal.x),
    y: clamp(TK_BEZEL_MIN.y, railCap, nominal.y),
    bottom: clamp(TK_BEZEL_MIN.y, railCap, nominal.bottom),
  }
}

/**
 * Everything the renderer needs, or null when the theme is not ours — the ONLY
 * null this module produces. Like the TK-05 frame there is no width at which the
 * OPUS-5 frame disappears: the mock's 1068×800 panel is the DAILY size, so a
 * narrow window has to restage inward, not evaporate.
 */
export function opusLayout(opts: {
  theme: string | null | undefined
  width: number
  height: number
  maximized: boolean
}): { stage: ChassisStage; bezel: OpusBezel } | null {
  if (!isOpusTheme(opts.theme)) return null
  // flushOnMaximized: the OWNER wants thin-at-maximized ONLY here — the TK-05
  // slab now stages purely by width (see chassisStage's 2026-07-27 note).
  const stage = chassisStage({ width: opts.width, maximized: opts.maximized, flushOnMaximized: true })
  return { stage, bezel: opusBezel(stage, { width: opts.width, height: opts.height }) }
}

// ── The frame's own corner bite ───────────────────────────────────────────────
// PATCH-01's caption for this theme is "the pincer profile is the corner bite
// cut into every control" — and until now the biggest control in the app, the
// chassis itself, was the one exception: the four bars were chamfered
// symmetrically on all four outer corners (chassisChamferPx), which is a bevel,
// not a bite. The frame now takes the SAME asymmetric cut the structure sheet's
// GROUP B puts on every button:
//
//   TOP-LEFT      a stepped notch — two cuts, the claw's jaw profile
//   BOTTOM-RIGHT  a 45° chamfer
//   the other two corners stay SQUARE, exactly as they do on a button
//
// and both cuts terminate on the acid: a signal-filled RIM layer sits behind
// each bitten rail and shows through as an `rim`-wide band along every cut
// face, so the frame ends on the theme's own light instead of on dark metal.
//
// WHY IT ALL FITS IN THE RAILS. The left/right flanks are inset by the rail
// height (`top: y; bottom: y`), so BOTH bitten corners are wholly inside the
// top and bottom rails — the flanks need no clip at all. That only holds while
// `notch + rim <= bezel.y`, which is the invariant the derivation below is
// written around and the unit test pins at every stage.

/** Widest the frame bite is ever cut, however thick the rail. Past ~22px the
 *  notch stops reading as a machined step and starts reading as a missing
 *  corner — the mock cuts 9px at control scale, and the frame is not 3× the
 *  drama, just 3× the metal. */
export const OPUS_FRAME_BITE_MAX_PX = 22

/** Thinnest rail that still gets a 2px acid rim; below it the rim is 1px, so a
 *  flush 10px rail spends 1px on the rim instead of 2 and keeps its notch. */
export const OPUS_FRAME_RIM_STEP_PX = 14

export interface OpusFrameBite {
  /** Depth (px) of the top-left stepped notch AND of the bottom-right chamfer
   *  — one number, because they are the same bite seen from two corners. */
  notch: number
  /** The staircase's inner tread (px): the short leg of the top-left step. */
  step: number
  /** Width (px) of the acid rim left visible along every cut face. */
  rim: number
}

/**
 * The frame bite for a bezel. Derived from the RAIL (`bezel.y`), never from a
 * stage constant: the rail is what has to contain the cut, and `opusBezel`
 * already clamps it against the viewport, so a short window shrinks the bite
 * instead of having it sheared by the rail's own edge. That derivation is also
 * what made the 2026-07-27 thinning free: on the 30px header rail the cut is a
 * 17px notch with a 2px rim instead of the slab-era 22+2 on 62px, and on a rail
 * clamped down to 16px it is 9+2 — proportional at every size, sheared at none.
 *
 * The guarantees, all pinned in test/unit/opusChrome.test.ts over every bezel
 * `opusBezel` can actually produce (its floor is TK_BEZEL_MIN.y = 8):
 *   notch + rim <= bezel.y   (the cut and its rim stay inside the rail)
 *   step < notch             (a staircase, not a single square)
 *   rim >= 1                 (the cut always terminates on acid)
 * Below that floor the function does not throw or overflow, it simply runs out
 * of metal and returns a cut of zero — a rail with no room for a bite gets no
 * bite, which is the same "shed the part, never shear it" rule the ruler and
 * the rack legend already follow.
 */
export function opusFrameBitePx(bezel: ChassisBezel): OpusFrameBite {
  const rail = Math.max(0, Math.round(bezel.y))
  const rim = Math.min(rail, rail >= OPUS_FRAME_RIM_STEP_PX ? 2 : 1)
  const room = Math.max(0, rail - rim)
  const notch = Math.min(room, clamp(6, Math.round(rail * 0.55), OPUS_FRAME_BITE_MAX_PX))
  const step = Math.min(Math.max(0, notch - 1), clamp(2, Math.round(notch * 0.45), 10))
  return { notch, step, rim }
}

/**
 * The bite the frame METAL takes, i.e. the same cut grown by the rim so the
 * acid layer underneath shows through as a band of uniform `rim` width along
 * every face. Axis-aligned faces grow by exactly `rim`; the 45° chamfer grows
 * by `rim * √2`, which is what makes the band PERPENDICULAR width `rim` there
 * too rather than `rim / √2`.
 */
export function opusFrameCorePx(bite: OpusFrameBite): OpusFrameBite {
  return {
    notch: bite.notch + bite.rim,
    step: bite.step + bite.rim,
    rim: bite.rim,
  }
}

/** Depth (px) of the grown BOTTOM-RIGHT chamfer — the diagonal case of
 *  `opusFrameCorePx`, kept separate because √2 is not 1. */
export function opusFrameCoreChamferPx(bite: OpusFrameBite): number {
  return bite.notch + Math.round(bite.rim * Math.SQRT2)
}

// ── Ruler ────────────────────────────────────────────────────────────────────
// The top and bottom rails carry a machinist's scale across the full width. It
// is drawn as ONE repeating-linear-gradient, so the tick pitch is the only
// number that matters — but it is derived, not hardcoded, so a thin rail gets a
// coarser scale instead of a grey smear.

/** Tick pitch (px) of the rail ruler. */
export function opusRulerStepPx(stage: ChassisStage): number {
  return stage === 'wide' ? 8 : stage === 'mid' ? 8 : stage === 'narrow' ? 6 : 5
}

/** Height (px) of the ruler band inside a rail of thickness `bezelY`. Every
 *  fifth tick is drawn double height, so this is the tall one. */
export function opusRulerHeightPx(bezelY: number): number {
  return clamp(4, Math.round(bezelY * 0.26), 12)
}

/**
 * Rail thickness (px) below which the ruler is not drawn.
 *
 * RAISED FROM 14 TO 34 WITH THE THIN RIM (2026-07-27), and this is the shed the
 * doc below describes actually firing. The scale lived on the rail's OUTER edge
 * and the header row on the plate-facing side, which fits while the rail is
 * 46-62px. On the thin frame the top rail IS the header row: a 30px rail spends
 * ~6px of pad and 17px on the LED rack + its legend, leaving 7px — less than the
 * 8px band the scale wants, so the ticks would surface between the lamp cells as
 * exactly the grey smear this gate exists to prevent. The mock agrees: frame 1b
 * prints no scale on either rail (the ruler belongs to the fat 2a rails), and
 * the number is kept as a THRESHOLD rather than deleting the Ruler so a future
 * thicker rail gets its scale back without re-deriving it.
 */
export const OPUS_RULER_MIN_RAIL_PX = 34

/**
 * Whether a rail is thick enough to carry a scale AT ALL. This is the one place
 * the frame sheds a part instead of shrinking it — and it sheds the part that is
 * pure texture, never the ones that carry identity (the perimeter line, the
 * header, the lamps and the bay markings are on every stage).
 */
export function opusRulerVisible(bezelY: number): boolean {
  return bezelY >= OPUS_RULER_MIN_RAIL_PX
}

// ── Caption ladder — THIS FRAME'S OWN (2026-07-27, owner directive) ──────────
//
// "метки текстом на узких если будет лучше" — it is better, and the reason it
// was not already true is a borrowed gate. The frame was reading
// `chassisCaptionMode(stage, bezel.y)`, whose middle clause is
// `if (!hasChassisFeature(stage, 'legends')) return 'bar'` — and `legends` is a
// SLAB feature, present only on the TK-05 wide and mid stages. So on the OPUS
// rim every stencil below 1180px (and every one at flush) degraded to an LED
// bar while the flank carrying it was the SAME 16px it is at 2560px. The frame
// was not out of room; it was inheriting another object's inventory ladder.
//
// The gate below asks the only question that is actually load-bearing here:
// CAN THIS SURFACE PRINT AN 8px LINE OF TYPE? The stage no longer decides
// whether there is text at all — it only decides how LONG the header row's text
// is, which is genuinely a width question. The LED bar survives as the
// degradation for the one case that is genuinely too small: a rail or flank
// clamped by `opusBezel`'s ratio cap on a viewport far shorter than the app's
// own 600px minimum ("shed the part, never shear it", same rule as the ruler
// and the rack legend).

/** Thinnest surface (px) that can still carry a printed marking: the LEGEND
 *  style's 8px type on a 1.0 line box, plus a 2px lip either side so the glyphs
 *  do not fuse with the frame's acid rule. Under the TK slab's own 16px budget
 *  on purpose — a 12px flush flank prints, and that is the whole point of the
 *  directive; the 8px type is the same size the mock silkscreens. */
export const OPUS_CAPTION_MIN_PX = 12

/**
 * How a caption printed ACROSS a rail renders — the header badge and the bottom
 * hint bar. Text whenever the rail can hold the line box; `full` only on the
 * wide stage, because for a row that runs the whole width of the window the
 * stage IS the room available.
 */
export function opusCaptionMode(stage: ChassisStage, rail: number): ChassisCaptionMode {
  if (rail < OPUS_CAPTION_MIN_PX) return 'bar'
  return stage === 'wide' ? 'full' : 'short'
}

/**
 * How a BAY STENCIL on a flank renders. Deliberately not a function of the
 * stage: the stencil is set vertically (`writing-mode: vertical-rl`), so the
 * flank's WIDTH is what has to hold the type's line box, while the marking's
 * length runs down an axis hundreds of pixels long that no stage ever
 * constrains. A flank that can print at all therefore prints the FULL marking
 * (`P·01 NAV`, not a bare `NAV`) — dropping the bay NUMBER on a narrow window
 * would be shedding the half of the silkscreen that carries the information,
 * and it buys back nothing on an axis that was never short.
 */
export function opusBayCaptionMode(flank: number): ChassisCaptionMode {
  return flank < OPUS_CAPTION_MIN_PX ? 'bar' : 'full'
}

// ── Header rack (mock option 1b) ─────────────────────────────────────────────
// The 1068×800 panel — the DAILY size — puts a 30px header row on the frame:
//   OPUS-5 badge · CHASSIS REV 5 · <w> × <h> · dotted rule · 5-LED rack ·
//   RUN IO NET PRV PWR legend · the window keys.
// Everything on that row except the rack and the keys is TEXT, and text is what
// runs out of room first. The ladder below is the "restage, never hide" rule
// applied to the row: the captions degrade through `chassisCaptionMode`, and the
// last thing standing is the rack — the mock's own caption for this panel is
// "chips truncate to their LED bars", so the bar IS the truncation.

/** Cells in the header LED rack — one per lamp in `RUN IO NET PRV PWR`. */
export const OPUS_LED_COUNT = 5

/**
 * Size (px) of one LED cell in the header rack, derived from the rail it is
 * milled into. The mock's daily panel gives 16×6, which is what the thin frame's
 * 30px header rail returns; a fraction of the rail (not `rail - k`) is what
 * keeps the cell inside a rail clamped down on a short viewport instead of
 * being sheared by the rail's own clip-path — the same mistake the segmented
 * readout already had to fix.
 */
export function opusLedPx(rail: number): { w: number; h: number } {
  const h = clamp(3, Math.round(rail * 0.25), 6)
  return { w: clamp(8, Math.round(h * 2.67), 16), h }
}

/** Rail thickness (px) at/above which the rack still gets its printed legend. */
export const OPUS_LEGEND_MIN_RAIL_PX = 20

/**
 * Whether `RUN IO NET PRV PWR` is printed beside the rack. Below the threshold
 * the LEGEND goes and the RACK stays — never the other way round: the lamps
 * carry state, the words only name it, and a rack with no words is still an
 * instrument reading (this is the mock's "chips truncate to their LED bars").
 */
export function opusLegendVisible(rail: number): boolean {
  return rail >= OPUS_LEGEND_MIN_RAIL_PX
}

// ── Window drag ──────────────────────────────────────────────────────────────
// The chassis covers the window's whole margin, so with no drag region on it the
// frame is a picture of a machine you cannot pick up — the native TitleBar is
// hidden on this theme and there is nothing else to grab. The rails get
// `-webkit-app-region: drag`; every control on them takes `no-drag`.

/**
 * Clear strip (px) left NON-draggable along the outer window edge. Windows keeps
 * a native resize border on the frameless window (`thickFrame: true`), and a
 * draggable region painted right up to the edge is the classic way to make a
 * window that can be moved but never resized. Kept wider than the 4px OS border.
 */
export const OPUS_DRAG_EDGE_PX = 6

/** Thickness (px) of the draggable band inside a rail/flank of size `bezel`,
 *  after the resize strip is taken off the outer edge. Zero (= draw nothing)
 *  when the bezel is too thin to give the resize strip AND a grab band. */
export function opusDragBandPx(bezel: number): number {
  return Math.max(0, bezel - OPUS_DRAG_EDGE_PX)
}

// ── Compartments ─────────────────────────────────────────────────────────────
// The mock numbers the app's regions like bays on a rack — P·01 NAV, 02 RAIL,
// P·03 STAGE, P·04 INPUT — and prints those numbers on the frame next to the
// region each one names. The ids are diegetic hardware markings (bay numbers on
// a plate), not UI copy, so they are literal and never translated.

export interface OpusCompartment {
  /** Bay id as silkscreened: '01' … '04'. */
  id: string
  /** Bay name as silkscreened. */
  label: string
  /** Which frame edge carries the marking. */
  edge: 'left' | 'right' | 'bottom'
}

/**
 * The bay manifest — the CONTRACT (which bays exist, what they are called, which
 * edge carries each one). OpusChrome renders the markings itself rather than
 * mapping over this list, because the mock prefixes them inconsistently on
 * purpose: `P·01 NAV`, then a bare `02 RAIL`, then `P·03 STAGE` / `P·04 INPUT`.
 * Deriving the strings would tidy that away and lose the likeness; the unit test
 * pins the manifest, and the component is checked against the same marks.
 */
export const OPUS_COMPARTMENTS: readonly OpusCompartment[] = [
  { id: '01', label: 'NAV',   edge: 'left' },
  { id: '02', label: 'RAIL',  edge: 'left' },
  { id: '03', label: 'STAGE', edge: 'right' },
  { id: '04', label: 'INPUT', edge: 'bottom' },
]

/** The three bays the sidebar CHASSIS MAP shows as mini-cells. */
export type OpusBay = 'nav' | 'rail' | 'stage'

/**
 * Which bay the operator is working in, from the router path. COARSE and
 * deliberately so — it is a status lamp, not navigation:
 *   'nav'   the hub / config surfaces, where the sidebar IS the work
 *   'rail'  the two conversation surfaces, which own a session rail
 *   'stage' everything else (one big work surface)
 */
export function opusActiveBay(pathname: string | null | undefined): OpusBay {
  const p = (pathname ?? '').toLowerCase()
  if (/^\/(home|settings|studio|learn)\b/.test(p)) return 'nav'
  if (/^\/(chat|agent|tachiapp|inbox)\b/.test(p)) return 'rail'
  return 'stage'
}

// ── Run signal ───────────────────────────────────────────────────────────────
// The mock's header carries a SCAN BAR — an LED strip that sweeps while a run is
// in flight (CHASSIS-MOCK-SPEC / PATCH-01 "Not in this patch"). It needs one
// boolean the whole shell agrees on, and the app has never had one: "something
// is running" lives in three separate stores, each already driving its own dot
//   • the agent harness   (agent.store `status`)
//   • a Nodes "Run all"   (nodesRun.store `status.kind`)
//   • a streaming answer  (chat.store `streamingMessageId`)
// so the OR of the three is the honest reading. Kept PURE here rather than
// inlined in AppShell so the truth table is a unit test instead of something you
// reproduce by starting a run.
//
// It lives with the chassis helpers because the chassis is its only CONSUMER
// (AppShell publishes the boolean on an inert strip and nothing else reads it),
// but it names no theme and no geometry — a second frame can read it as-is.

/** What the shell knows about work in flight, as read from the three stores. */
export interface ChassisRunInput {
  /** `useAgentStore(s => s.status)` — 'idle'|'starting'|'running'|'done'|'error'. */
  agentStatus?: string | null
  /** `useNodesRunStore(s => s.status.kind === 'running')`. */
  nodesRunning?: boolean
  /**
   * `useChatStore(s => s.streamingConversationId !== null || s.streamingMessageId !== null)`.
   *
   * BOTH ids, never just the message one. `streamingMessageId` is set on the
   * provider's FIRST CHUNK and cleared on `done`, so a short answer opens and
   * closes it in ~0ms — a bar driven off it alone stayed dark for a whole real
   * send (live-found on the installed build). `streamingConversationId` is armed
   * at SEND, which is exactly when the chat's own WaitingIndicator starts, so
   * the OR covers "waiting for the first token" as well as "streaming". Both
   * are cleared by the same `done`/`error` chunk and by `reset`, so the OR is
   * still terminal — it cannot leave the strip sweeping forever.
   */
  chatStreaming?: boolean
}

/**
 * Is any run in flight? `'starting'` counts on purpose: booting a harness
 * session costs real seconds, and a lamp that stays dark through them reads as a
 * hang. `'done'` and `'error'` are terminal and must NOT keep the strip
 * sweeping — a scan bar that never stops is a decoration, not an instrument.
 */
export function chassisRunActive(s: ChassisRunInput): boolean {
  return !!s.nodesRunning
    || !!s.chatStreaming
    || s.agentStatus === 'running'
    || s.agentStatus === 'starting'
}

// ── The lamp rack's readings ─────────────────────────────────────────────────
//
// THE HONESTY LAW, applied to the FRAME (ChassisSidebarPanel.tsx states it in
// full for the sidebar): every lamp is a real reading or it is not lit. There is
// no decorative branch and no "looks alive" cell.
//
// The rack shipped with two cells that broke it — `GPU` was hardcoded lit and
// `IO` was wired to the RUN signal, so one lamp claimed a measurement nothing
// took and another repeated its neighbour. Both are fixed by the same rule: a
// cell names a SIGNAL, and the signal is a boolean the renderer already holds.
//
// EVERY READING IS SUBSCRIPTION-DRIVEN. The chrome is mounted for the whole life
// of the app, so a poll here is a poll forever — the idle audit (lane V) has just
// finished deleting exactly those. So: a zustand selector (run / io / prv), a
// pair of platform events (net), or a constant that is true by construction
// (pwr). No lamp may ever arm a timer.
//
//   RUN  chassisRunActive — agent | nodes | chat, the shared boolean.
//   IO   the download manager's queue: a transfer in flight (see OPUS_IO_STATES).
//   NET  navigator.onLine + the online/offline events.
//   PRV  PRIVATE MODE (privacy.store). Was `GPU`, which was a lie: llama.cpp and
//        sd.cpp only report through a request/response IPC (`status()`), so a
//        local-engine lamp needs a POLL — forbidden here — and the push channels
//        they do have (`onGenProgress`) carry no terminal event, so a lamp
//        driven off them would stick lit after a crashed generation, which is the
//        same defect one step later. Private mode is a real posture, held in a
//        store, that changes what the app may do with the network — the one thing
//        worth a dedicated lamp next to NET.
//   PWR  a constant. The only claim whose truth is entailed by its own
//        visibility: if the cell is on screen, the renderer is painting it.

/** Which reading a rack cell shows. One key per lamp, so a cell cannot be added
 *  without naming the signal that lights it. */
export type OpusLampMode = 'run' | 'io' | 'net' | 'prv' | 'pwr'

/** The five readings, as taken by the always-mounted chrome. */
export type OpusLampReadings = Record<OpusLampMode, boolean>

/**
 * Download states that mean the IO lamp should be lit. `active` and `queued` are
 * the pair DownloadStrip itself calls active (a queued item is accepted work the
 * manager will start on its own); `verifying` is the sha256/size pass, which is
 * reading the whole file back off disk. `paused`, `done` and `error` are settled
 * — a lamp still lit over a finished row is the "animation that outlived its
 * state" defect in five pixels.
 */
export const OPUS_IO_STATES: readonly string[] = ['queued', 'active', 'verifying']

/** Does the download manager have a transfer in flight? Tolerant of a queue that
 *  is missing or oddly shaped (the
 *  bridge is absent in tests and in any non-Electron host) — an unreadable queue
 *  is NOT activity. */
export function opusDownloadActive(
  items: readonly ({ state?: string | null } | null | undefined)[] | null | undefined,
): boolean {
  if (!Array.isArray(items)) return false
  return items.some(i => !!i && typeof i.state === 'string' && OPUS_IO_STATES.includes(i.state))
}

// ── The segmented readout's level ────────────────────────────────────────────
// The readout shipped as `SEG_LIT = 6` — ten cells with six lit, forever. It
// looked like an instrument and measured nothing, which is the sidebar's retired
// SERVO/OPTIC needles in a different housing.
//
// It now shows the SAME NUMBER the sidebar's CTX gauge does: the live agent
// session's context load, estimated the way every other CTX surface in the app
// estimates it (chars / 4 ≈ tokens, against the store's own max). Two surfaces,
// one reading — the sidebar prints the percentage, the frame lights the ladder.
//
// The chars are counted here, and the DENOMINATOR is not: it is the ROUTED
// MODEL's published window, which only a store can answer
// (`useAgentContextWindow` in agent.store), and this module is
// deliberately free of stores (its test runs with no DOM and no Electron). The
// caller divides — by that one hook, the same call ChassisSidebarPanel's CTX row
// makes, which is the equality the suite pins across the two files. It was a
// flat `DEFAULT_MAX_TOKENS` on both sides until 2026-08-02: consistent, and
// consistently wrong for every model whose window is not 32k.

/** Cells in the header readout. */
export const OPUS_SEG_COUNT = 10

/** One entry of the agent log, as far as the CTX estimate cares. */
export interface OpusCtxMessage { event?: unknown }

/**
 * Characters of context in the live agent session — the same four event fields
 * ChassisSidebarPanel's CTX row counts (`text` / `input` / `output` / `message`).
 * Pure and total: a missing log, a null entry or an event with none of the four
 * fields all read as zero rather than throwing on the always-mounted chrome.
 */
export function opusContextChars(
  messages: readonly (OpusCtxMessage | null | undefined)[] | null | undefined,
): number {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) {
    const ev = (m?.event ?? null) as {
      text?: unknown; input?: unknown; output?: unknown; message?: unknown
    } | null
    if (!ev) continue
    if (typeof ev.text === 'string') n += ev.text.length
    if (typeof ev.input === 'string') n += ev.input.length
    if (typeof ev.output === 'string') n += ev.output.length
    if (typeof ev.message === 'string') n += ev.message.length
  }
  return n
}

/**
 * Lit cells for a context fraction (0..1). Zero context lights NOTHING — an
 * empty gauge is a reading, and the unlit cells are still drawn in their housing
 * so it reads as "empty", not as "broken". Any non-zero reading lights at least
 * one cell, because rounding a real 2% session down to a dark ladder is the same
 * lie in the other direction. Saturates at the top rather than overflowing: past
 * 100% the ladder is full and the number belongs to the sidebar's own readout.
 */
export function opusSegmentLevel(frac: number): number {
  if (!Number.isFinite(frac) || frac <= 0) return 0
  return clamp(1, Math.round(frac * OPUS_SEG_COUNT), OPUS_SEG_COUNT)
}

// ── Crab engraving ───────────────────────────────────────────────────────────
// The mock's caption 1b is the requirement: "the crab moves inside the stage as
// an engraving, so the window edge can never eat it". So the silhouette is
// anchored to the PLATE, inset from the plate's own edge by a margin that
// scales with the frame — never to the viewport, which is what let the crab
// theme's claws get sliced by the screen edge.

/** Clear margin (px) between the engraving and the plate edge. */
export function opusEngraveInsetPx(bezel: ChassisBezel): number {
  return clamp(10, Math.round(bezel.x * 0.35), 46)
}

// THE DEAD-SPACE BAND. The mock draws the engraving on an IDLE stage, so
// "centred in the plate" was a fair reading of it — until the same anchor was
// checked against a live CHAT, where it landed squarely on the GET MODELS row
// and the answer bubbles (live-found on the installed build). The plate is not
// uniform: the app always puts a header strip at the top of the stage and a
// composer at the bottom, and both are DENSE. Everything between them is where
// live content is ragged and rarely reaches the right edge, so that band — not
// the plate — is what the mark is centred in, and the two constants below are
// the strips it is kept out of.
//
// They are generous on purpose: an engraving that clips a composer by 4px is
// the failure this is fixing, so the bands are rounded UP past the tallest
// version of each (a two-row composer with chips under it, a header with a
// breadcrumb). Being 20px too shy costs nothing; being 4px too greedy costs the
// whole point of the mark.

/** Top strip (px) of the plate the engraving is kept out of — the page header. */
export const OPUS_ENGRAVE_HEAD_PX = 56

/** Bottom strip (px) of the plate the engraving is kept out of — the composer
 *  band (input + chips + footer hints). */
export const OPUS_ENGRAVE_FOOT_PX = 120

/** The plate height (px) left between those two strips. Never negative. */
export function opusEngraveBandPx(plateH: number): number {
  return Math.max(0, plateH - OPUS_ENGRAVE_HEAD_PX - OPUS_ENGRAVE_FOOT_PX)
}

/**
 * Rendered height (px) of the engraving. Derived from the DEAD-SPACE BAND, not
 * from the whole plate: sizing off `plateH` let the silhouette grow taller than
 * the space it is allowed to occupy, and the overflow is exactly the part that
 * ended up over the composer and the header.
 *
 * The fraction and the ceiling are both lower than the old plate-relative pair
 * (0.46 / 420px): at the owner's 1068×800 that produced a 346×239 mark across
 * the middle of the stage — wallpaper, and unavoidably over the conversation.
 * 0.42 of the band with a 260px ceiling gives 242×167 there, which is a MARK in
 * the right third and leaves the reading column alone.
 *
 * Floored so it never degrades into an unreadable smudge — under the floor the
 * caller should draw nothing at all (`opusEngraveVisible`). The floor is also
 * kept under the band at the smallest plate `opusEngraveVisible` allows
 * (320px → a 144px band), so the mark can always be placed legally.
 */
export function opusEngraveHeightPx(plateH: number): number {
  return clamp(96, Math.round(opusEngraveBandPx(plateH) * 0.42), 260)
}

/**
 * Top offset (px) of the engraving INSIDE the plate — the caller adds the bezel,
 * so this is measured from the plate's own top edge.
 *
 * Centred in the dead-space band, then clamped so the mark can never cross into
 * either strip even if a caller hands in a height this module did not choose.
 * The clamp resolves in favour of the HEADER when a plate is too short to hold
 * both (`Math.max` on the upper bound): overlapping a header once is survivable,
 * sitting under the text field is the thing the mock's caption forbids.
 */
export function opusEngraveTopPx(plateH: number, height: number): number {
  const band = opusEngraveBandPx(plateH)
  const centred = OPUS_ENGRAVE_HEAD_PX + Math.round((band - height) / 2)
  const lowest = Math.max(OPUS_ENGRAVE_HEAD_PX, plateH - OPUS_ENGRAVE_FOOT_PX - height)
  return clamp(OPUS_ENGRAVE_HEAD_PX, centred, lowest)
}

/** Whether there is enough plate left to engrave on. */
export function opusEngraveVisible(plateW: number, plateH: number): boolean {
  return plateW >= 620 && plateH >= 320
}

/**
 * Offset (px) of the BURR — mock option 1c: "struck into the plate at 6%, with a
 * 2px signal offset copy reading as the burr of the engraving tool". The second
 * strike is the same silhouette in the signal ink, displaced by exactly this,
 * which is what makes the mark read as cut metal (a tool leaves a raised lip on
 * one side of the groove) rather than as a flat watermark.
 *
 * A CONSTANT, not a fraction of the size: a burr is a property of the tool, so
 * it must not grow with the engraving — scaling it turns the lip into a visible
 * doubled outline, which is the failure mode this number is tuned against.
 */
export const OPUS_ENGRAVE_BURR_PX = 2
