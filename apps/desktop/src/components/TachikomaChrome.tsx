// apps/desktop/src/components/TachikomaChrome.tsx
//
// TK-05 CHASSIS — the companion chrome for the `tachikoma-red` theme, the same
// pattern as OpusChrome.tsx: mounted once in App.tsx, renders null on every
// other theme, and everything on it is decoration EXCEPT the three window keys
// on the right flank (see WindowKeys — the one deliberate exception).
//
// WHAT IT IS — THE SLAB (mock variant 2a). The app is not a window on a desktop
// here, it is a PANEL RECESSED INTO ONE CONTINUOUS MACHINED BODY. Not a
// rectangle with things stuck to it: a single asymmetric silhouette, drawn as
// SEVEN STACKED CLIPS that all share ONE clip-path polygon —
//
//   edge   brushed metal catching a key light from the upper left
//   lip    the dark valley of the bevel
//   face   the anodised body
//   seam   the 1px parting line of a two-piece shell
//   inner  the body again, so the seam reads as a LINE and not as a border
//   grain  the WEAR — scratches, micro-pitting, panel partings, a rubbed corner
//   spec   one raking key light + an oil-slick film, painted last
//
// The mock states the material as five flat fills; five flat fills describe the
// right object and paint it as plastic. `SLAB_MATERIAL` therefore carries the
// FINISH as well as the colour — brush, machining twill, pressing seams, oxide
// patina and field wear, all as background-image layers on those same clips.
// The whole grain is NET-DARKENING because the 8px silkscreen printed on this
// face is LIGHTER than the metal, so grooves help the legends and crests hurt
// them; the unit test computes that from the material strings rather than
// trusting this sentence.
//
// — plus every piece of hardware MILLED OUT OF THAT SAME PLATE: the intake
// louvres in the top tray, the LED rack under the mandible step, the knurled
// drive wheel and the exhaust vent on the right flank, the acoustic grille and
// the hazard flash on the bottom edge, the screws, the name plate pocket, the
// barcode. The port bays are BITTEN OUT of both flanks and the unit stands on
// two feet — those are cuts in the outline, not applied decoration. NOTHING
// FLOATS: the hardware is positioned from the milled-feature list the polygon
// builder returns (`SlabCuts`), so it moves with the silhouette.
//
// THE CYAN RESTRAINT, written into the mock and pinned by the unit test: cyan is
// NOT allowed on the chassis. It is reserved for the optic, the live LEDs and
// the screen. That restraint is the difference between a product and a poster —
// so `SLAB_MATERIAL` below is warm greys and oxidised crimson, with no optic ink
// anywhere in it.
//
// The geometry the mock states at one size (1428×932 shell, 1280×800 panel,
// bezels 56/62/92/70) is DERIVED per stage in tachikoma/tachikomaChrome.helpers
// — the vertex positions are the mock's fractions, every cut depth is a fraction
// of the stage's bezel. globals.css (`[data-chassis]`) does the other half: it
// insets `.app-body` into the opening, and this theme's structure sheet gives
// that opening the mock's recessed-screen rings.
//
// EVERY PIXEL IS CSS. Stacked divs + clip-path + gradients + box-shadow. No
// bitmaps (unlike the crab claws, which are PNGs), no SVG, no canvas — the slab
// is resolution-independent and repaints instantly on a stage change.
//
// ── The rules this file is written against ───────────────────────────────────
//
// 1. IT NEVER DISAPPEARS. The crab chrome hides below 1180px, so at the owner's
//    ~1068px daily window the theme's signature is simply gone. The chassis is a
//    physical object: it RESTAGES INWARD instead — thinner bezels, shallower
//    cuts, less hardware, and any caption that no longer fits becomes the LED
//    BAR that stands for it (`chassisCaptionMode` / `chassisStatusMode`) rather
//    than vanishing. There is no width-gated early return here and no
//    `max-width` rule in the injected CSS; the only null this component returns
//    is "wrong theme".
//
// 2. NO `filter:` ANYWHERE — for two reasons, either of which is fatal on its
//    own. `drop-shadow` traces an element's ALPHA, so on a transparent element
//    that holds text it paints a copy of the TEXT (the ghosting defect that
//    shipped app-wide in two structure themes). And ANY filter creates a
//    containing block for `position: fixed` descendants — the window keys are
//    fixed, so a filter on an ancestor would tear them off the viewport. The
//    mock's `.slab { filter: drop-shadow(…) }` is therefore the ONE line of the
//    2a system deliberately not transcribed; the chamfer stack carries the
//    depth instead. Same rule bans animation/transform on any ancestor of the
//    keys.
//
// 3. NOTHING PAINTS OVER APP CONTENT. The slab is one body under the plate, and
//    the plate is lifted to `z-index: 5` by globals.css above this layer's
//    `z-index: 0`. Every decorative div is `pointer-events: none`, so no layer
//    can eat a click either.
//
// 4. NO `cursor`, EVER (test/unit/resizeCursor.test.ts): the resize affordance is
//    owned centrally by globals.css.
//
// 5. THE SLAB LAYERS ARE LEAVES. `clip-path` clips DESCENDANTS, so a hardware
//    child inside a slab layer would be sheared by the silhouette (and a fixed
//    descendant would be clipped even though it escapes the containing block).
//    The seven layers are childless; hardware lives in transparent band
//    wrappers that carry no clip of their own.
//
// 6. THE TEXTURE IS BACKGROUND-IMAGE ONLY. Every bit of the machined finish is
//    a gradient painted into a layer that already existed (or, once, into one
//    new leaf sharing the same clip and inset) — never an extra element with a
//    transform, an opacity or a blend mode on it. Those all promote a layer and
//    two of them would also create a containing block for the fixed keys, which
//    is the same trap rule 2 bans `filter` for. No layer exceeds SIX
//    background-images either: past that the raster cost on a resize drag
//    starts to show, and the silhouette already re-rasters on every frame.
//
// DRAG. The chassis is the top of the window now, so it is what the user grabs
// to move it: the top rail, both flanks and the bottom rail are
// `-webkit-app-region: drag`, each starting TK_RESIZE_EDGE_PX in from the window
// edge so Windows keeps its resize border, and every interactive child (the key
// well and the three keys) is `no-drag`.
//
// TRANSPARENT WINDOW: the window is created transparent+frameless for every
// theme, which is what lets the chamfer, the port bays and the foot gaps cut
// through to the desktop instead of to a black rectangle.
//
// LEGENDS ARE DIEGETIC HARDWARE MARKINGS, NOT UI COPY, and are therefore
// deliberately NOT i18n keys: `TK-05`, `S/N TK-05-0001`, `ACOUSTIC 2W`,
// `INTAKE · PASSIVE`, `攻殻機動隊 · 公安九課`. These are the marks a real machined
// chassis carries — a model designation, a serial plate, SI ratings, a stencil —
// and a serial-number plate that changed language when the UI locale changed
// would read as a bug, not as localisation. Translating them would also drag
// decorative silkscreen into the 8-locale parity contract for no reader benefit.
// (The i18n parity guard must therefore never demand keys for this file; the
// unit test pins the absence of `useTranslation` so the decision cannot rot.)
// All of it is real 8px copy on --text-dim (5.0:1 on base — see the tier's
// rationale in tachikoma-red.css).
//
// THE LAMPS REPORT, THEY DO NOT DECORATE (2026-07-27, the idle audit's worst
// find). Every cell on this slab used to be hardcoded — `live: true` on the
// OPTIC iris, five more lamps permanently lit, the vent sweep on an
// unconditional 7s loop — so the unit claimed a run was in flight every second
// the app was open, and the iris keyframes animate `box-shadow`, a PAINT
// property, which means the LED rack of an ALWAYS-MOUNTED chrome was repainting
// forever on an idle machine. Both halves are fixed here: state comes from
// `chassisLampLit` over signals the shell already has (the run stores, the one
// api-server call this file already made, `navigator.onLine`), and MOTION is
// gated on the run signal, so an idle chassis is a still image. The other half
// of the gate lives in the structure sheet: `:root:not([data-window-focused])`
// pauses everything under `.tk-chassis` while the window is visible but
// unfocused (a second monitor, where `backgroundThrottling` never fires).
import React, { useEffect, useState } from 'react'
import { useThemeStore } from '../store/theme.store'
import { useWindowState } from '../hooks/useWindowState'
import { useAgentStore } from '../store/agent.store'
import { useNodesRunStore, nodesRunActive } from '../store/nodesRun.store'
import { useChatStore } from '../store/chat.store'
import { chassisRunActive } from './opus/opusChrome.helpers'
import {
  TK_THEME, TK_RESIZE_EDGE_PX, chassisLayout, chassisKeySizePx, chassisBoltPx,
  chassisWheelPx, chassisCaptionMode, chassisStatusMode, chassisLinkLabel,
  chassisDragBandPx, chassisSlabInsets, chassisSlabPolygon, hasChassisFeature,
  chassisGrilleBand, chassisStatusLeftPx, chassisKeyFinish, chassisKeyWellPadPx,
  chassisLampLit,
  type ChassisStage, type ChassisBezel, type ChassisCaptionMode, type SlabCuts,
  type SlabGrille, type ChassisKeyFinish, type ChassisLampSource,
  type ChassisLampSignals,
} from './tachikoma/tachikomaChrome.helpers'

// Motion: one LED iris and one slow optic sweep behind the vent, and NEITHER
// runs while the unit is idle — both are gated on the run signal, which is the
// difference between an instrument and a screensaver. Both are opacity /
// transform / box-shadow on decorative leaf divs that hold no fixed descendant,
// both die under reduced motion, and both are additionally PAUSED by the theme
// sheet while the window is unfocused. There is NO `max-width` media query in
// here on purpose: the chassis restages in JS, it never hides.
const CHASSIS_CSS = `
@keyframes tk-chassis-led {
  0%, 100% { opacity: 1;    box-shadow: 0 0 4px 1px rgba(0,229,255,0.85), inset 0 0 0 1px rgba(255,255,255,0.55); }
  50%      { opacity: 0.5;  box-shadow: 0 0 9px 3px rgba(0,229,255,0.30), inset 0 0 0 1px rgba(255,255,255,0.22); }
}
@keyframes tk-chassis-sweep {
  0%   { transform: translateY(-140%); opacity: 0; }
  12%  { opacity: 0.9; }
  88%  { opacity: 0.9; }
  100% { transform: translateY(460%); opacity: 0; }
}
/* !important is load-bearing: the cap's fill is an INLINE style, and an author
   !important declaration is the only thing that outranks one — without it the
   key would never light up under the pointer.
   The DRESSED caps (every stage but flush) wake by lifting their fill; the LIT
   caps at flush already carry the unit's key light, so they brighten the whole
   face instead — a darker hover on a lit cap would read as a press, not a
   hover. data-lit is set by the component from chassisKeyFinish(). */
.tk-chassis-key:not([data-lit="1"]):hover { background-color: rgba(58,42,46,0.95) !important; }
.tk-chassis-key[data-lit="1"]:hover {
  background-image: linear-gradient(155deg,#d3b6bd 0%,#a8828d 46%,#7d5661 100%) !important;
}
.tk-chassis-key[data-lit="1"][data-key="close"]:hover {
  background-image: linear-gradient(155deg,#ff9cba 0%,#ff5c8c 46%,#e01a5c 100%) !important;
}
.tk-chassis-key:active { transform: translateY(1px); }
.tk-chassis-key:focus-visible { outline: 2px solid var(--accent-alt); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .tk-chassis * { animation: none !important; }
}`

/** Base style for EVERY div in this file — decoration only, never a hit target.
 *  The unit test asserts one `...LAYER` spread per `<div`, so a new layer cannot
 *  be added without inheriting pointer-events: none. */
const LAYER: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  userSelect: 'none',
}

/** The ONE exception to LAYER, and the only `pointerEvents: 'auto'` in the file:
 *  the three window keys on the right flank are REAL controls wired to the same
 *  `window.tachi.window` IPC the TitleBar uses, because on this theme they are
 *  the keys the mock draws as the unit's physical controls — a dead moulded cap
 *  next to a live one is worse than no cap at all. They are `<button>` elements
 *  (not divs, so the pointer-events guard on `<div` stays mechanical), they
 *  carry titles + aria-labels, they opt OUT of the flank's drag region, and
 *  their well is the only part of the slab outside the `aria-hidden` scenery
 *  wrapper — an aria-hidden ancestor around a focusable control is an a11y
 *  defect. */
const KEY_HIT: React.CSSProperties = {
  position: 'relative',
  pointerEvents: 'auto',
  padding: 0,
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** `WebkitAppRegion` is a non-standard property React's CSS types do not carry,
 *  so it is cast the same way components/layout/TitleBar.tsx casts it.
 *
 *  DRAG bands are what let the user move the window by the chassis — before
 *  this, no chassis element had a region at all and the only grab handle was
 *  the TitleBar INSIDE the recessed plate. NO_DRAG goes on every interactive
 *  child: a drag region swallows clicks whole, so a key inside one would be
 *  unpressable. */
const DRAG: React.CSSProperties = {
  ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'drag',
} as React.CSSProperties
const NO_DRAG: React.CSSProperties = {
  ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'no-drag',
} as React.CSSProperties

/** THE MATERIAL — the mock's five stacked clips, plus a WEAR pass and the
 *  raking key light, transcribed from `.tkred .slab-*` and then FINISHED.
 *
 *  WHY IT GREW. The mock states the material as five flat fills: they describe
 *  the right OBJECT (a machined billet with a five-facet chamfer) but they paint
 *  it as anodised plastic, because a plain `linear-gradient` has no grain and a
 *  surface with no grain has no scale — at 1x the widest bezel is 116px of one
 *  smooth ramp. Real gunmetal reads through its MICRO-DETAIL: the brush the
 *  finishing wheel left, the machining twill crossing it, the parting lines of
 *  the panels it was pressed from, the scratches the field put on it and the
 *  oxide that settled in the low corner. All of that is added here as extra
 *  BACKGROUND-IMAGE layers on the existing clips — no bitmap, no `filter`, no
 *  animation, no new element that could become a containing block.
 *
 *  THE GRAIN IS NET-DARKENING, and that is a legibility decision, not a taste
 *  one: 8px `--text-dim` silkscreen is printed straight onto the `inner` face,
 *  and the ink is LIGHTER than the metal — so grooves (black) raise legend
 *  contrast while crests (white) lower it. Every layer here therefore spends
 *  most of its duty cycle on black and only a sub-pixel sliver on white, and on
 *  the three legend-bearing facets no white stop is brighter than the 0.085 the
 *  mock's own key light already put on the same pixels. (`edge` and `face` are
 *  the chamfer rings — 5px and 13px of pure bevel at the widest stage, no copy
 *  on them ever — so their brush runs hotter, which is what a cut face does.)
 *  It measures out BETTER than the flat fill it replaced, not merely no worse:
 *  the mock's smooth ramp put its worst legend bed at 4.40:1, under AA, and the
 *  grain takes that bed to 4.54:1. The unit test computes all of it from these
 *  strings — duty-cycle means for the hairlines, a full pile-up for the washes.
 *
 *  THE CYAN RESTRAINT LIVES HERE: not one optic literal in this object, and no
 *  ink in it may be cool-cast at all (the test checks `b > r && g > r` on every
 *  colour, which is the actual signature of teal, rather than one hex string).
 *  Cyan belongs to the optic, the live LEDs and the screen; a chassis that glows
 *  is a poster. The oil-slick sheen on `spec` is the one iridescence allowed and
 *  it runs amber → rose → violet, never through the optic's hue. */
const SLAB_MATERIAL = {
  // EDGE — the outer chamfer facet, the brightest thing on the unit. A tight
  // brushed pass along the mock's own 157° so the rim reads as TURNED metal
  // catching the key light, not as a lit stroke around a shape.
  edge: [
    'repeating-linear-gradient(157deg,rgba(255,255,255,0.10) 0 0.5px,rgba(0,0,0,0.22) 0.5px 1.6px,rgba(0,0,0,0) 1.6px 3px)',
    'linear-gradient(157deg,#9c757f 0%,#5a3941 14%,#2a1a20 38%,#160d10 58%,#3a2229 80%,#8a616d 100%)',
  ].join(','),
  // LIP — the dark valley of the bevel. Stays a flat black: it is a shadow, and
  // a shadow with a texture in it stops being a shadow.
  lip: '#050303',
  // FACE — the bevel flank. Same brush as the edge, run at the BODY's 163°
  // instead of the rim's 157°, so the two facets visibly disagree about which
  // way the wheel went — which is what makes them read as two cut surfaces.
  face: [
    'repeating-linear-gradient(163deg,rgba(255,255,255,0.045) 0 0.5px,rgba(0,0,0,0.26) 0.5px 1.5px,rgba(0,0,0,0) 1.5px 3.5px)',
    'linear-gradient(163deg,#2f1920 0%,#1c1014 28%,#120b0e 56%,#1f1116 80%,#341a22 100%)',
  ].join(','),
  // SEAM — the 1px parting line of a two-piece shell. Flat by definition.
  seam: '#63404b',
  // INNER — THE BIG MACHINED FACE. This is the surface the owner is looking at:
  // 95px of it down each flank and 41px along each rail at the wide stage, and
  // it is where the whole "gunmetal, not maroon plastic" verdict is won. Six
  // images, top to bottom:
  //   1 panel micro-seams — the vertical parting lines of the pressing, one
  //     dark groove with a lit lower lip, every 137px
  //   2 machining twill — the carapace weave of GROUP A, run 45° off the grain
  //   3 brush BEAT — a second, slower brush frequency (7px against 3px) whose
  //     interference is what stops the grain reading as a printed screen
  //   4 brush — the finishing wheel, along the anodising
  //   5 oxide patina — the low corner darkens, so the unit sits DOWN in its own
  //     shadow instead of floating evenly lit
  //   6 the anodised body itself (the mock's fill)
  inner: [
    'repeating-linear-gradient(90deg,rgba(0,0,0,0) 0 136px,rgba(0,0,0,0.42) 136px 136.8px,rgba(255,255,255,0.05) 136.8px 137.4px,rgba(0,0,0,0) 137.4px 274px)',
    'repeating-linear-gradient(118deg,rgba(255,255,255,0.020) 0 0.5px,rgba(0,0,0,0.16) 0.5px 1.6px,rgba(0,0,0,0) 1.6px 6px)',
    'repeating-linear-gradient(163deg,rgba(255,255,255,0.022) 0 0.5px,rgba(0,0,0,0.14) 0.5px 2.5px,rgba(0,0,0,0) 2.5px 7px)',
    'repeating-linear-gradient(163deg,rgba(255,255,255,0.038) 0 0.5px,rgba(0,0,0,0.22) 0.5px 1.4px,rgba(0,0,0,0) 1.4px 3px)',
    'radial-gradient(120% 90% at 84% 108%,rgba(0,0,0,0.34) 0%,rgba(0,0,0,0.10) 42%,rgba(0,0,0,0) 74%)',
    'linear-gradient(163deg,#241318 0%,#170d11 34%,#0e080a 64%,#190e12 86%,#271419 100%)',
  ].join(','),
  // GRAIN — THE WEAR PASS, the one new leaf. It shares the polygon and the
  // `inner` inset, so it is the same facet: a service history laid over the
  // finish rather than a seventh facet of the chamfer. Six images:
  //   1-2 scratches, two angles, two periods, sub-pixel — each a lit hairline
  //       with a dark trailing burr, which is what a scratch in metal is
  //   3   the horizontal panel parting, offset in period from the vertical set
  //       so the two never lay a cross on the same spot twice
  //   4-5 micro-pitting: two high-frequency fields at opposing angles whose
  //       beat is a speckle, not a stripe (a single field would be corduroy)
  //   6   the rubbed-bright patch at the top-left chamfer — the corner a hand
  //       actually touches, so the finish there is polished thin
  grain: [
    'repeating-linear-gradient(24deg,rgba(0,0,0,0) 0 57px,rgba(255,255,255,0.075) 57px 57.6px,rgba(0,0,0,0.30) 57.6px 58.4px,rgba(0,0,0,0) 58.4px 119px)',
    'repeating-linear-gradient(-8deg,rgba(0,0,0,0) 0 83px,rgba(255,255,255,0.055) 83px 83.5px,rgba(0,0,0,0.18) 83.5px 84.2px,rgba(0,0,0,0) 84.2px 191px)',
    'repeating-linear-gradient(0deg,rgba(0,0,0,0) 0 91px,rgba(0,0,0,0.34) 91px 91.7px,rgba(255,255,255,0.04) 91.7px 92.2px,rgba(0,0,0,0) 92.2px 197px)',
    'repeating-linear-gradient(41deg,rgba(255,255,255,0.030) 0 0.4px,rgba(0,0,0,0) 0.4px 2.7px)',
    'repeating-linear-gradient(-49deg,rgba(0,0,0,0.16) 0 0.4px,rgba(0,0,0,0) 0.4px 3.3px)',
    'radial-gradient(58% 42% at 3% 2%,rgba(255,255,255,0.024) 0%,rgba(255,255,255,0) 68%)',
  ].join(','),
  // SPEC — painted last, over every facet: the mock's one raking key light,
  // now with a whisper of oil-slick under it so the metal has a FILM on it.
  // The sheen runs amber → rose → violet at 2-3%: enough that the sweep across
  // the face shifts hue like a clear coat, nowhere near a colour a lamp uses.
  spec: [
    [
      'linear-gradient(112deg,',
      'rgba(255,176,120,0.022) 0%,rgba(255,120,160,0.022) 22%,',
      'rgba(0,0,0,0) 46%,rgba(150,120,220,0.022) 72%,',
      'rgba(214,160,120,0.018) 100%)',
    ].join(''),
    [
      'linear-gradient(148deg,',
      'rgba(255,255,255,0.085) 0%,rgba(255,255,255,0.022) 13%,',
      'rgba(255,255,255,0) 30%,rgba(0,0,0,0.16) 62%,',
      'rgba(255,255,255,0.030) 86%,rgba(255,255,255,0) 100%)',
    ].join(''),
  ].join(','),
} as const

/** Laser-etched micro type — ONE size, ONE tracking, everywhere on the shell. */
const LEGEND: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 8,
  lineHeight: 1,
  letterSpacing: '0.22em',
  color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
}

/** Status rows are the longest copy on the slab, so they trade letter-spacing
 *  for width and TRUNCATE instead of wrapping — a wrapped 8px legend inside a
 *  24px rail would overflow the bar and paint on the desktop. */
const STATUS_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  overflow: 'hidden',
}

/** Milled surface treatments, straight off the mock's hardware rules. */
const KNURL = 'repeating-linear-gradient(180deg,rgba(255,255,255,0.10) 0 2px,rgba(0,0,0,0.45) 2px 4px,rgba(0,0,0,0) 4px 8px)'
const VENT_H = 'repeating-linear-gradient(90deg,#050304 0 5px,rgba(0,0,0,0) 5px 11px)'
const VENT_V = 'repeating-linear-gradient(180deg,#050304 0 5px,rgba(0,0,0,0) 5px 11px)'
const GRILLE = 'radial-gradient(circle at 50% 50%,#050304 0 1.7px,rgba(0,0,0,0) 1.9px)'
const HAZARD = 'repeating-linear-gradient(135deg,rgba(255,179,0,0.42) 0 8px,rgba(10,7,8,0.42) 8px 16px)'
const BARCODE = 'repeating-linear-gradient(90deg,#0b0708 0 2px,rgba(0,0,0,0) 2px 4px,#0b0708 4px 5px,rgba(0,0,0,0) 5px 9px,#0b0708 9px 12px,rgba(0,0,0,0) 12px 14px)'

/** The LED bar that stands in for a caption too small to print. Same footprint,
 *  no text: "chips truncate to their LED bars" (mock caption 1b). */
function bar(w: number, ink: string): React.CSSProperties {
  return {
    width: w,
    height: 3,
    backgroundColor: ink,
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
  }
}

/** Live viewport size. The chassis restages on WIDTH and the silhouette is
 *  literally a function of the viewport box, so this is load-bearing geometry,
 *  not cosmetics — a CSS media query could not also scale the cut depths, the
 *  keys and the screws, which is what makes the narrow stage read as the same
 *  object rather than a different one. */
function useViewport(): { width: number; height: number } {
  const [v, setV] = useState(() => ({
    width: typeof window === 'undefined' ? 1400 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setV({ width: window.innerWidth, height: window.innerHeight })
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return v
}

/** The LINK legend's port AND the LINK lamp's state, from the local
 *  OpenAI-compatible API server. One IPC call on mount, no polling: the slab is
 *  silkscreen, not a monitor, and a port does not change while the process
 *  lives. A missing bridge or a stopped server falls back to the documented
 *  default inside `chassisLinkLabel`, so the LEGEND is never blank — but the
 *  LAMP takes `running`, not the port, because a port the server is not
 *  listening on is exactly the invented reading this pass exists to remove.
 *
 *  A MOUNT-TIME READING, DELIBERATELY. The server's lifecycle is a settings
 *  toggle (Studio → local API), not something that flips on its own, and the
 *  alternative is a poll on an always-mounted component — the precise cost this
 *  batch is paying down. If the bridge ever grows a change event, subscribe to
 *  it here; do not add a timer. */
function useApiServer(active: boolean): { port: number | null; up: boolean } {
  const [state, setState] = useState<{ port: number | null; up: boolean }>({ port: null, up: false })
  useEffect(() => {
    if (!active) return
    let live = true
    window.tachi?.apiServer?.status?.()
      .then(s => {
        if (!live) return
        setState({
          port: typeof s?.port === 'number' ? s.port : null,
          up: s?.running === true,
        })
      })
      .catch(() => { /* bridge unavailable — the legend prints the default, the lamp stays dark */ })
    return () => { live = false }
  }, [active])
  return state
}

/** The NET lamp's reading: does the OS say this machine has a network link?
 *
 *  EVENT-DRIVEN, ZERO TIMERS — `online`/`offline` fire from the platform, so an
 *  idle app pays nothing for this lamp. It is a LINK reading and the comment on
 *  the cell says so: `navigator.onLine` cannot promise the internet is
 *  reachable, only that the machine is plugged into something, and a lamp that
 *  claimed more than its source knows would be the same defect as a hardcoded
 *  one. Listeners are only attached while the chassis is actually live. */
function useOnline(active: boolean): boolean {
  const [online, setOnline] = useState(() => {
    try { return typeof navigator === 'undefined' || navigator.onLine !== false } catch { return true }
  })
  useEffect(() => {
    if (!active) return
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [active])
  return online
}

export function TachikomaChrome() {
  const theme = useThemeStore(s => s.theme)
  const { maximized } = useWindowState()
  const { width, height } = useViewport()
  const layout = chassisLayout({ theme, width, height, maximized })
  const api = useApiServer(!!layout)
  const online = useOnline(!!layout)
  // IS ANYTHING RUNNING — the SAME boolean the header scan bar rides (AppShell
  // publishes it on `[data-scan-bar]` and mirrors it onto `:root`), read here
  // from the same three stores rather than passed down: nothing links this
  // component to the shell, and a prop chain through App.tsx would be a second
  // place to keep in sync. This is the batch27 fix the OPUS frame already
  // carries, ported — three boolean selectors, so the chassis re-renders only
  // when the answer FLIPS, never on a token, a step or a node result.
  const agentStatus = useAgentStore(s => s.status)
  const nodesRunning = useNodesRunStore(nodesRunActive)
  // BOTH chat ids, ORed — live-found on the installed build: `streamingMessageId`
  // exists only between the provider's first chunk and its last, which on a short
  // answer is a ~0ms window. `streamingConversationId` is armed at SEND, so the
  // OR also covers the wait for the first token. Same expression as AppShell and
  // OpusChrome; if one of the three changes, change all three.
  const chatStreaming = useChatStore(s => s.streamingConversationId !== null || s.streamingMessageId !== null)
  const runActive = chassisRunActive({ agentStatus, nodesRunning, chatStreaming })

  // Drive the recess CSS (globals.css `[data-chassis]`). Present only while the
  // chassis is live, torn down on theme change / unmount so it can never leak
  // into another theme.
  //
  // THE INACTIVE BRANCH DELIBERATELY DOES NOTHING. `data-chassis` is shared with
  // OpusChrome (same recess, same three custom properties, different dressing),
  // so an effect that removed the attribute whenever ITS theme was inactive would
  // race the other component: React runs every cleanup in tree order and only
  // then every effect, so "cleanup removes, effect sets" is ordered correctly,
  // while "inactive component removes" would run after the active one had
  // already set it and blank the recess on one of the two switch directions.
  //
  // THE SLAB IS VERTICALLY SYMMETRIC, so `by` is stamped into BOTH vertical
  // properties. The recess rule used to take one `--chassis-inset-y` for the
  // pair, which was fine for this frame and wrong for the OPUS-5 rim (a 30px
  // header rail over a 24px hint bar in its mock). Splitting it there means
  // stamping both here: an unset `--chassis-inset-bottom` would fall back to the
  // rule's narrow default and un-recess the bottom of the slab.
  const stage = layout?.stage ?? null
  const bx = layout?.bezel.x ?? 0
  const by = layout?.bezel.y ?? 0
  useEffect(() => {
    if (!stage) return
    const root = document.documentElement
    root.setAttribute('data-chassis', stage)
    root.style.setProperty('--chassis-inset-x', `${bx}px`)
    root.style.setProperty('--chassis-inset-top', `${by}px`)
    root.style.setProperty('--chassis-inset-bottom', `${by}px`)
    return () => {
      root.removeAttribute('data-chassis')
      root.style.removeProperty('--chassis-inset-x')
      root.style.removeProperty('--chassis-inset-top')
      root.style.removeProperty('--chassis-inset-bottom')
    }
  }, [stage, bx, by])

  // TITLEBAR HANDOFF. The structure sheet hides the TitleBar's own −□✕ row
  // ONLY under [data-chassis-keys="1"] — i.e. while the chassis actually
  // mounts its replacement keys. Live-found regression: at `flush` this
  // theme's feature set drops the flank keys, and an UNCONDITIONAL hide left
  // a maximized window with ZERO controls. Same shared-attribute rules as
  // data-chassis above: only the active component sets it, cleanup removes.
  const keysMounted = stage ? hasChassisFeature(stage, 'keys') : false
  useEffect(() => {
    if (!keysMounted) return
    const root = document.documentElement
    root.setAttribute('data-chassis-keys', '1')
    return () => { root.removeAttribute('data-chassis-keys') }
  }, [keysMounted])

  if (theme !== TK_THEME || !layout) return null
  return (
    <Chassis
      stage={layout.stage}
      bezel={layout.bezel}
      viewport={{ width, height }}
      maximized={maximized}
      link={chassisLinkLabel(api.port)}
      signals={{ runActive, linkUp: api.up, online }}
    />
  )
}

// ── The slab ─────────────────────────────────────────────────────────────────
// ONE body. Seven leaf layers share one polygon; four transparent band wrappers
// carry the hardware; the key well is a SIBLING of the aria-hidden scenery so no
// aria-hidden ancestor sits over a focusable control.
function Chassis({ stage, bezel, viewport, maximized, link, signals }: {
  stage: ChassisStage
  bezel: ChassisBezel
  viewport: { width: number; height: number }
  maximized: boolean
  link: string
  /** What the lamps and the optic sweep are allowed to read. One object rather
   *  than three props: the rack, the flank repeater and the vent all take the
   *  same set, so a new signal is wired in one place. */
  signals: ChassisLampSignals
}) {
  const { x, y } = bezel
  const slab = chassisSlabPolygon({ width: viewport.width, height: viewport.height, bezel })
  const ins = chassisSlabInsets(y)
  const cuts = slab.cuts
  const keyS = chassisKeySizePx(x)
  const screw = chassisBoltPx(stage)
  const cap = chassisCaptionMode(stage, y)
  const status = chassisStatusMode(y)
  const has = (f: Parameters<typeof hasChassisFeature>[1]) => hasChassisFeature(stage, f)
  const hazardH = Math.max(3, Math.round(y * 0.1))
  const dragX = chassisDragBandPx(x)
  const dragY = chassisDragBandPx(y)
  // THE BOTTOM RAIL HAS TWO COLUMNS (mock 2a L340-344): the perforated speaker
  // panel with its rating under it, then — 6px clear of it — every other legend.
  // Both columns are laid out from ONE band, so the stencil can never be printed
  // across the grille again (it was, at the wide stage: driver-2).
  const grille = has('grille')
    ? chassisGrilleBand({ width: viewport.width, shearBlX: cuts.shearBl.x })
    : null
  const statusLeft = chassisStatusLeftPx({ width: viewport.width, inset: x + 4, grille })
  // Every layer is clipped by the SAME polygon. The inner ones are also inset,
  // which SHIFTS that polygon inward by the inset — which is exactly how five
  // identical clips become a chamfer with five distinct facets. Seven layers,
  // five insets: `grain` doubles up on `inner` (it is that facet's wear, not a
  // facet) and `spec` doubles up on `edge` (it lights all five at once).
  const clip = { clipPath: slab.path } as const

  return (
    <div className="tk-chassis"
      style={{ ...LAYER, position: 'fixed', inset: 0, zIndex: 0 }}>
      <style>{CHASSIS_CSS}</style>

      {/* ── SCENERY ── everything below is silkscreen, lamps and metal. */}
      <div aria-hidden style={{ ...LAYER, inset: 0 }}>

        {/* ── THE BODY ── five stacked clips, the wear pass, the raking key
            light. LEAVES: clip-path clips descendants, so nothing may be
            nested in here. `grain` rides the SAME inset as `inner` on purpose —
            it is not a sixth facet of the chamfer, it is the service history of
            the fifth, and giving it its own inset would have cut a visible
            step where the wear starts. */}
        <div style={{ ...LAYER, ...clip, inset: 0, background: SLAB_MATERIAL.edge }} />
        <div style={{ ...LAYER, ...clip, inset: ins.lip, background: SLAB_MATERIAL.lip }} />
        <div style={{ ...LAYER, ...clip, inset: ins.face, background: SLAB_MATERIAL.face }} />
        <div style={{ ...LAYER, ...clip, inset: ins.seam, background: SLAB_MATERIAL.seam }} />
        <div style={{ ...LAYER, ...clip, inset: ins.inner, background: SLAB_MATERIAL.inner }} />
        <div style={{ ...LAYER, ...clip, inset: ins.inner, background: SLAB_MATERIAL.grain }} />
        <div style={{ ...LAYER, ...clip, inset: 0, background: SLAB_MATERIAL.spec }} />

        {/* ── TOP RAIL ── name plate, intake louvres in the tray, LED rack under
            the mandible step. The wrapper is transparent and clips only by
            overflow, so a plate that outgrows a thin rail is sheared instead of
            painting onto the desktop. */}
        <div style={{ ...LAYER, top: 0, left: 0, right: 0, height: y, overflow: 'hidden' }}>
          {has('topplate') && <NamePlate cap={cap} left={cuts.chamfer + 6} rail={y} />}
          {has('ventstrip') && <IntakeStrip cap={cap} rail={y} cuts={cuts} />}
          {has('hazard') && (
            <div style={{
              ...LAYER, top: Math.max(4, Math.round(y * 0.2)), right: x + 4, width: 54, height: 4,
              backgroundImage: HAZARD,
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
            }} />
          )}
          {has('ledblock') && <LedBlock cap={cap} right={x + 4} rail={y} hazard={has('hazard')} signals={signals} />}
          {has('bolts') && (
            <Bolt size={screw} pos={{ right: Math.max(4, Math.round(x * 0.2)), top: Math.max(3, Math.round(y * 0.48)) }} slot={-38} />
          )}
        </div>

        {/* ── BOTTOM RAIL ── the acoustic grille, the hazard flash and the
            status block. Both flashes start where the shears end, so nothing
            hangs over a cut corner. */}
        <div style={{ ...LAYER, bottom: 0, left: 0, right: 0, height: y, overflow: 'hidden' }}>
          {grille && <Grille band={grille} rail={y} cap={cap} />}
          {has('hazardband') && (
            <div style={{
              ...LAYER, top: 0, left: cuts.shearBl.x, right: cuts.shearBr.x, height: hazardH,
              backgroundImage: HAZARD,
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.55)',
            }} />
          )}
          {has('status') && (
            <StatusBlock
              mode={status} cap={cap} left={statusLeft} right={x + 4}
              rail={y} top={hazardH} link={link} acoustic={!grille}
            />
          )}
        </div>

        {/* ── LEFT FLANK ── the unit marking, an index mark and a screw. The
            port bay is a CUT in the outline, not an applied part. */}
        <div style={{ ...LAYER, top: y, bottom: y, left: 0, width: x, overflow: 'hidden' }}>
          {has('marking') && <Marking cap={cap} flank={x} />}
          {has('bolts') && (
            <div style={{
              ...LAYER, top: '59%', left: Math.max(2, Math.round((x - 16) / 2)),
              width: Math.min(16, x - 4), height: 4, backgroundColor: 'var(--accent)',
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
            }} />
          )}
          {has('bolts') && (
            <Bolt size={screw} pos={{ left: Math.max(2, Math.round((x - screw) / 2)), top: '80%' }} slot={-12} />
          )}
        </div>

        {/* ── RIGHT FLANK ── the control side: the knurled drive wheel, the
            exhaust vent, the LED rack and a screw. The KEY WELL is mounted
            outside this aria-hidden wrapper, below. */}
        <div style={{ ...LAYER, top: y, bottom: y, right: 0, width: x, overflow: 'hidden' }}>
          {has('wheel') && <Wheel size={chassisWheelPx(x)} cap={cap} />}
          {has('vents') && <Vents flank={x} runActive={!!signals.runActive} />}
          {has('leds') && <LedRack flank={x} rail={y} signals={signals} />}
          {has('bolts') && (
            <Bolt size={screw} pos={{ left: Math.max(2, Math.round((x - screw) / 2)), top: '82%' }} slot={52} />
          )}
        </div>

        {/* ── DRAG BANDS ── the chassis IS the window's grab handle. Each band
            starts TK_RESIZE_EDGE_PX in from the window edge so Windows keeps
            its own sizing border: a band pinned to the outer edge would make
            the window unresizable from three sides. */}
        <div style={{ ...LAYER, ...DRAG, top: TK_RESIZE_EDGE_PX, left: TK_RESIZE_EDGE_PX, right: TK_RESIZE_EDGE_PX, height: dragY }} />
        <div style={{ ...LAYER, ...DRAG, bottom: TK_RESIZE_EDGE_PX, left: TK_RESIZE_EDGE_PX, right: TK_RESIZE_EDGE_PX, height: dragY }} />
        <div style={{ ...LAYER, ...DRAG, top: y, bottom: y, left: TK_RESIZE_EDGE_PX, width: dragX }} />
        <div style={{ ...LAYER, ...DRAG, top: y, bottom: y, right: TK_RESIZE_EDGE_PX, width: dragX }} />
      </div>

      {/* ── THE ONLY LIVE HARDWARE ── three real window keys on the flank. */}
      {has('keys') && <WindowKeys size={keyS} flank={x} maximized={maximized} cap={cap} finish={chassisKeyFinish(stage)} />}
    </div>
  )
}

// ── Name plate ───────────────────────────────────────────────────────────────
// The unit's identity plate: a MILLED POCKET in the top rail (the mock's
// `.nameplate` — a sunk shadow, a lit lower lip, a cut corner pair) with the
// model name in the backlit legend ink and the variant line under it. On the
// narrow stage the plate keeps its footprint and drops to an LED bar — the
// pocket is still machined into the plate, you just cannot read it at that size.
function NamePlate({ cap, left, rail }: { cap: ChassisCaptionMode; left: number; rail: number }) {
  const pad = rail >= 34 ? 5 : rail >= 20 ? 3 : 1
  return (
    <div style={{
      ...LAYER, left, bottom: Math.max(4, Math.round(rail * 0.18)),
      padding: `${pad}px ${pad + 3}px`,
      backgroundColor: '#0c0708',
      boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.05), 0 1px 0 rgba(255,255,255,0.07)',
      clipPath: 'polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px)',
      display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      {cap === 'bar' ? (
        <div style={{ ...LAYER, ...bar(48, 'var(--accent)'), position: 'relative' }} />
      ) : (
        <div style={{
          ...LAYER, ...LEGEND, position: 'relative',
          color: 'var(--accent-text)', letterSpacing: '0.34em', fontSize: 9,
        }}>
          {cap === 'full' ? 'TACHIKOMA-RED' : 'TK-05'}
        </div>
      )}
      {cap === 'full' && (
        <div style={{ ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.26em' }}>
          UNIT TK-05 · RED CRAB VARIANT
        </div>
      )}
    </div>
  )
}

// ── Intake strip ─────────────────────────────────────────────────────────────
// The passive-intake louvres, sunk INTO the tray the silhouette steps down for
// (mock: `.vent` at 492,19 — the tray floor runs 490→800). Its position and
// width come from the cut list, so it can never end up hanging in mid-air over a
// tray that the current stage cut somewhere else — or at all.
function IntakeStrip({ cap, rail, cuts }: {
  cap: ChassisCaptionMode; rail: number; cuts: SlabCuts
}) {
  // RESTAGE, NEVER HIDE: if the viewport got small enough that the tray folded
  // out of the silhouette, the louvres keep their nominal band rather than
  // disappearing — the panel is bolted to the unit either way.
  const tray = cuts.tray && cuts.tray.span >= 24 ? cuts.tray : null
  const h = Math.max(4, Math.min(11, Math.round(rail * 0.18)))
  return (
    <div style={{
      ...LAYER,
      left: tray ? tray.at + 2 : '34%',
      width: tray ? tray.span - 4 : '24%',
      top: (tray ? tray.depth : 0) + Math.max(2, Math.round(rail * 0.06)),
      display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <div style={{
        ...LAYER, position: 'relative', width: '100%', height: h,
        backgroundColor: '#0a0607',
        backgroundImage: VENT_H,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)',
      }} />
      {cap === 'bar'
        ? <div style={{ ...LAYER, ...bar(30, 'var(--text-dim)'), position: 'relative' }} />
        : <div style={{ ...LAYER, ...LEGEND, position: 'relative' }}>INTAKE · PASSIVE</div>}
    </div>
  )
}

// ── LED rack (top) ───────────────────────────────────────────────────────────
// The unit's indicator block on the top-right, under the mandible step: six
// rectangular lamps (the mock's 18×7 `.led`) over one stencilled row of names.
//
// EVERY NAME IS A PROMISE, so every name is now kept (see `chassisLampLit`).
// The table used to hardcode five lit cells and one dead one, with OPTIC blinking
// forever; the six lamps now read:
//
//   SERVO  run    the actuators move while work is in flight
//   OPTIC  run    the same signal, and the ONE cell that blinks — the iris only
//                 opens while the unit is actually looking at something
//   LINK   link   the local OpenAI-compatible API server reported itself up;
//                 the host:port under it on the bottom rail is that same server
//   GPU    dead   THE DEAD CELL. The renderer has no cheap, honest GPU reading
//                 (nothing here may spend a timer or an IPC round-trip on one),
//                 so the lamp stays dark rather than claiming a load it cannot
//                 measure. It moved here from NET, which DID gain a source.
//   NET    net    navigator.onLine — the machine has a link, not "the internet
//                 works"; the OS pushes both edges, so it costs nothing
//   PWR    power  the renderer is executing (the one tautology, and a true one)
//
// An unlit cell keeps its housing and takes LED_OFF, exactly as before — a lamp
// that is OFF is what makes an indicator block read as an indicator block rather
// than a progress bar, and at idle most of this rack is off. That is the point.
const LED_OFF = 'rgba(120,100,105,0.30)'

const LED_BLOCK: readonly {
  name: string; source: ChassisLampSource; ink: string; glow: string | null; blink?: true
}[] = [
  { name: 'SERVO', source: 'run',   ink: 'var(--accent)',     glow: 'rgba(168,18,50,0.50)' },
  { name: 'OPTIC', source: 'run',   ink: 'var(--accent-alt)', glow: null, blink: true },
  { name: 'LINK',  source: 'link',  ink: 'var(--success)',    glow: 'rgba(0,224,138,0.55)' },
  { name: 'GPU',   source: 'dead',  ink: 'var(--warning)',    glow: 'rgba(255,179,0,0.45)' },
  { name: 'NET',   source: 'net',   ink: 'var(--success)',    glow: 'rgba(0,224,138,0.40)' },
  { name: 'PWR',   source: 'power', ink: 'var(--success)',    glow: 'rgba(0,224,138,0.40)' },
]

/** One lamp's FACE — the fill, the glow and whether it blinks. A style FRAGMENT,
 *  never a whole `style` value: every call site spreads LAYER first, which is
 *  what keeps the "one `...LAYER` per `<div`" guard mechanical. Shared by the top
 *  block and the flank repeater so the two racks can never disagree about the
 *  same reading. */
function lampFace(
  cell: { source: ChassisLampSource; ink: string; glow: string | null; blink?: true },
  signals: ChassisLampSignals,
  w: number,
  h: number,
): React.CSSProperties {
  const lit = chassisLampLit(cell.source, signals)
  // MOTION IS A STATE, NOT A FINISH. The iris keyframes animate `box-shadow` —
  // a paint property — so an unconditional blink repaints the rack of an
  // always-mounted chrome on every frame, forever, on an idle machine. It runs
  // only while the cell is genuinely lit by a run.
  const blink = lit && cell.blink === true
  return {
    position: 'relative', width: w, height: h,
    backgroundColor: lit ? cell.ink : LED_OFF,
    // The blinking cell's shadow is owned by the keyframes (setting it here
    // would be overwritten mid-animation anyway).
    boxShadow: blink
      ? undefined
      : `${lit && cell.glow ? `0 0 3px 0 ${cell.glow}, ` : ''}inset 0 0 0 1px rgba(0,0,0,0.55)`,
    animation: blink ? 'tk-chassis-led 1.7s ease-in-out infinite' : undefined,
  }
}

function LedBlock({ cap, right, rail, hazard, signals }: {
  cap: ChassisCaptionMode; right: number; rail: number; hazard: boolean
  signals: ChassisLampSignals
}) {
  const lw = Math.max(6, Math.min(18, Math.round(rail * 0.29)))
  const lh = Math.max(3, Math.min(7, Math.round(rail * 0.113)))
  return (
    <div style={{
      ...LAYER, right, bottom: Math.max(4, Math.round(rail * (hazard ? 0.18 : 0.24))),
      display: 'flex', alignItems: 'flex-end', gap: cap === 'bar' ? 5 : 9,
    }}>
      {LED_BLOCK.map(cell => (
        <div key={cell.name} style={{
          ...LAYER, position: 'relative',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
        }}>
          <div style={{ ...LAYER, ...lampFace(cell, signals, lw, lh) }} />
          {cap !== 'bar' && (
            <div style={{
              ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.1em',
            }}>{cell.name}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Status block ─────────────────────────────────────────────────────────────
// The bottom rail's copy, in the mock's own left-to-right order (hazard stencil
// → power/link/security → licence → Section 9 → serial with its barcode), in
// three staged forms (see chassisStatusMode):
//   'stacked' two rows — the whole mock inventory
//   'single'  one row: LINK + SEC and the serial
//   'bar'     three LED bars where the rows would be
// PWR is a plate RATING (the nominal supply silkscreened on a real unit's foot,
// like ACOUSTIC 2W is the speaker's), the LINK host:port is REAL — it comes from
// the local API server when it is up — and SEC OK is the privacy posture the
// whole app is built on, not a probe.
//
// IT USED TO READ `PWR 12.4V`, and one decimal place is the whole difference
// between a rating and a LIE: a stencilled `12V 4A` is what the plate says, while
// `12.4V` is what a voltmeter says, so a constant printed in that form claimed a
// live measurement of a rail this app does not have and cannot read. Same law
// the sidebar panel was rewritten under (its SERVO 62 / OPTIC 84 needles), and
// the same one the LED rack above now follows.
//
// `left` IS NOT `right`. The mock's rail has two columns and the legends live in
// the second one (L342-344, all at x=286, clear of the grille that ends at 280),
// so the block takes its left margin from chassisStatusLeftPx — the grille's own
// right edge plus the mock's parting — and only its right margin from the flank.
// ACOUSTIC 2W travels WITH the panel it rates (it is drawn by <Grille/>, mock
// L341: same x as the grille, printed under it), so this block prints it only
// when the stage mills no grille to hang it on.
function StatusBlock({ mode, cap, left, right, rail, top, link, acoustic }: {
  mode: 'stacked' | 'single' | 'bar'
  cap: ChassisCaptionMode
  left: number
  right: number
  rail: number
  top: number
  link: string
  acoustic: boolean
}) {
  if (mode === 'bar') {
    return (
      <div style={{
        ...LAYER, left, right, top: top + 2,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <div style={{ ...LAYER, ...bar(34, 'rgba(255,179,0,0.45)'), position: 'relative' }} />
        <div style={{ ...LAYER, ...bar(26, 'var(--success)'), position: 'relative' }} />
        <div style={{ ...LAYER, ...bar(18, 'var(--text-dim)'), position: 'relative' }} />
      </div>
    )
  }

  const linkLine = (
    <div style={{ ...LAYER, ...LEGEND, position: 'relative', color: 'var(--success)', letterSpacing: '0.16em' }}>
      {mode === 'stacked' ? `PWR 12V 4A · LINK ${link} · SEC OK` : `LINK ${link} · SEC OK`}
    </div>
  )
  // The serial plate the mock prints under its barcode. The barcode is a real
  // tiled gradient, not a picture — same law as the rest of the slab.
  const serial = (
    <div style={{
      ...LAYER, position: 'relative',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3,
    }}>
      {mode === 'stacked' && (
        <div style={{
          ...LAYER, position: 'relative', width: 90, height: Math.max(6, Math.round(rail * 0.16)),
          backgroundImage: BARCODE,
        }} />
      )}
      <div style={{ ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.16em' }}>
        S/N TK-05-0001
      </div>
    </div>
  )

  if (mode === 'single') {
    return (
      <div style={{ ...LAYER, ...STATUS_ROW, left, right, top: top + 3 }}>
        {linkLine}
        {serial}
      </div>
    )
  }

  return (
    <>
      {/* Row A — the hazard stencil and the serial plate. */}
      <div style={{ ...LAYER, ...STATUS_ROW, left, right, top: top + 5 }}>
        <div style={{ ...LAYER, ...LEGEND, position: 'relative', color: 'var(--warning)', letterSpacing: '0.18em' }}>
          DO NOT OPEN · SANDBOXED RENDERER
        </div>
        {serial}
      </div>
      {/* Row B — the acoustic rating, power/link/security, the licence stencil
          and the Section-9 mark. */}
      <div style={{
        ...LAYER, ...STATUS_ROW, left, right,
        bottom: Math.max(4, Math.round(rail * 0.14)),
      }}>
        {acoustic && (
          <div style={{ ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.16em' }}>ACOUSTIC 2W</div>
        )}
        {linkLine}
        {cap === 'full' && (
          <div style={{ ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.16em' }}>
            LOCAL-FIRST · NO CLOUD REQUIRED · MIT
          </div>
        )}
        {/* Section 9, in the language it belongs to. Not a translated string —
            a stencil, same as the model number. letterSpacing stays wide so the
            glyphs do not touch at 9px. */}
        <div style={{
          ...LAYER, ...LEGEND, position: 'relative',
          fontSize: 9, letterSpacing: '0.2em', color: 'var(--accent-text)',
        }}>攻殻機動隊 · 公安九課</div>
      </div>
    </>
  )
}

// ── Unit marking ─────────────────────────────────────────────────────────────
// The stencil down the left flank, high on the hull where the mock carries it
// (492… no: 30,116 — just under the chamfer). Vertical because that is where a
// walker's hull carries its crew rating, and because a horizontal string does
// not fit a 36px flank at the owner's daily width.
function Marking({ cap, flank }: { cap: ChassisCaptionMode; flank: number }) {
  if (cap === 'bar') {
    return (
      <div style={{
        ...LAYER, top: '12%', left: Math.max(2, Math.round((flank - 3) / 2)),
        width: 3, height: 46,
        backgroundColor: 'var(--accent)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
      }} />
    )
  }
  return (
    <div style={{
      ...LAYER, ...LEGEND, top: '12%', left: Math.max(2, Math.round((flank - 9) / 2)),
      writingMode: 'vertical-rl', letterSpacing: '0.28em',
    }}>
      {cap === 'full' ? 'TK-05 · ONE OPERATOR' : 'TK-05'}
    </div>
  )
}

// ── Exhaust vent ─────────────────────────────────────────────────────────────
// The vertical louvre bank milled into the right flank (mock `.vent-v` at
// 1354,590): dark slots with a lit lip on each blade, and the optic sweep
// crossing behind them — the one cyan the flank is allowed, because it is the
// optic and not the metal.
//
// THE SWEEP IS MOUNTED ONLY WHILE SOMETHING RUNS. It used to be an
// unconditional `7s linear infinite`, which is compositor-only work but pins the
// compositor awake permanently — a machine that never idles because a decorative
// bar is crossing a 60px vent on an app nobody is using. Gating it on the run
// signal makes it an instrument (the optic sweeps while the unit is working) and
// costs the idle app exactly nothing.
//
// It is CONDITIONALLY RENDERED rather than paused-in-place on purpose: the
// keyframe's 0% is `translateY(-140%); opacity: 0`, so an element left in the
// tree without its animation parks a lit cyan band at the TOP of the vent —
// visibly wrong, and a static bar is exactly the "decoration that outlived its
// state" this pass removes. Unmounted, the vent is just louvres; a fresh mount
// restarts the sweep from 0%.
function Vents({ flank, runActive }: { flank: number; runActive: boolean }) {
  const pad = Math.max(3, Math.round(flank * 0.14))
  return (
    <div style={{
      ...LAYER, left: pad, right: pad, top: '63%', height: '15%',
      overflow: 'hidden',
      backgroundColor: '#0a0607',
      backgroundImage: VENT_V,
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.85), inset 0 0 9px rgba(0,0,0,0.9), 0 1px 0 rgba(255,255,255,0.04)',
    }}>
      {runActive && (
        <div style={{
          ...LAYER, left: 0, right: 0, top: 0, height: 10,
          backgroundImage: 'linear-gradient(to bottom, rgba(0,229,255,0), rgba(0,229,255,0.40), rgba(0,229,255,0))',
          animation: 'tk-chassis-sweep 7s linear infinite',
        }} />
      )}
    </div>
  )
}

// ── Acoustic grille ──────────────────────────────────────────────────────────
// The perforated speaker panel on the bottom edge (mock L340: 152,870 — 128×44)
// AND the rating stencilled under it (mock L341: ACOUSTIC 2W at 152,920 — the
// same x, printed below the panel, never across it). A real dot matrix: one
// tiled radial-gradient, not a texture image.
//
// The rating belongs to the panel, so it is drawn HERE rather than in the status
// row: a rating that lived in the row would be laid out against the row's own
// left margin and drift off the hardware it describes — which is exactly how the
// SANDBOXED RENDERER stencil ended up painted over the perforations. The band
// comes in already computed (chassisGrilleBand), so the status block and the
// panel are dimensioned from ONE source.
function Grille({ band, rail, cap }: { band: SlabGrille; rail: number; cap: ChassisCaptionMode }) {
  const top = Math.max(3, Math.round(rail * 0.14))
  const height = Math.max(10, Math.round(rail * 0.5))
  return (
    <>
      <div style={{
        ...LAYER, left: band.left, width: band.width, top, height,
        backgroundColor: '#080506',
        backgroundImage: GRILLE,
        backgroundSize: '9px 9px',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)',
      }} />
      {cap !== 'bar' && (
        <div style={{
          ...LAYER, ...LEGEND, left: band.left, top: top + height + 4, letterSpacing: '0.16em',
        }}>ACOUSTIC 2W</div>
      )}
    </>
  )
}

// ── Drive wheel ──────────────────────────────────────────────────────────────
// The unit rolls. The mock puts the wheel on the right flank as a KNURLED DRUM
// seen edge-on (`.knurl`, 42×110, hard black rim, WHEEL stencilled under it) —
// not a disc, because a disc drawn flat on a flank is a sticker.
function Wheel({ size, cap }: { size: number; cap: ChassisCaptionMode }) {
  return (
    <div style={{
      ...LAYER, top: '44%', left: '50%', width: size, height: Math.round(size * 2.6),
      transform: 'translateX(-50%)',
      backgroundColor: '#150c0f',
      backgroundImage: KNURL,
      boxShadow: 'inset 0 0 0 2px #070405, inset 0 0 10px rgba(0,0,0,0.85), 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {cap !== 'bar' && (
        <div style={{
          ...LAYER, ...LEGEND, left: 0, top: 'calc(100% + 5px)', letterSpacing: '0.14em',
        }}>WHEEL</div>
      )}
    </div>
  )
}

// ── LED rack (flank) ─────────────────────────────────────────────────────────
// Five lamps in a sunk housing on the right flank, between the keys and the
// vent. THE SAME INSTRUMENT AS THE TOP BLOCK, repeated — a repeater panel, which
// is what a machine with two indicator racks actually has, and the reason this
// list is a SLICE of `LED_BLOCK` instead of a second table: five unlabelled
// lamps with their own private states would be five more claims nobody can
// check, and the two racks could drift into contradicting each other about the
// same reading. It sheds the last cell (PWR) because the housing holds five;
// the ones it keeps carry the same source, the same ink and the same blink.
const LED_RACK_CELLS = LED_BLOCK.slice(0, 5)

function LedRack({ flank, rail, signals }: {
  flank: number; rail: number; signals: ChassisLampSignals
}) {
  const lw = Math.max(5, Math.min(18, flank - 10))
  const lh = Math.max(3, Math.min(7, Math.round(rail * 0.113)))
  return (
    <div style={{
      ...LAYER, top: '31%', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.max(3, lh - 2),
      padding: `${Math.max(3, lh - 2)}px ${Math.max(2, Math.round(lh / 2))}px`,
      backgroundColor: '#050304',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.9), inset 0 2px 4px rgba(0,0,0,0.8), 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {LED_RACK_CELLS.map(cell => (
        <div key={cell.name} style={{ ...LAYER, ...lampFace(cell, signals, lw, lh) }} />
      ))}
    </div>
  )
}

// ── Physical window keys — REAL CONTROLS ─────────────────────────────────────
// Three moulded caps in a sunk key well on the right flank (mock: 1348,76 —
// 48×28 each, stacked, KEYS stencilled under them), engraved with the minimise /
// maximise / close marks and wired to the SAME `window.tachi.window` IPC the
// TitleBar's controls use. This is the one place on the slab where a click does
// something, and the reason is the mock: it draws these as the unit's physical
// keys, and a moulded cap that looks like a key but is dead is a worse lie than
// no cap at all.
//
// What keeps them safe:
//   • `<button>`, not a div — so the pointer-events guard on `<div` in the unit
//     test stays mechanical and the caps are keyboard-reachable.
//   • title + aria-label on each, and the well is OUTSIDE the aria-hidden
//     scenery wrapper (an aria-hidden ancestor over a focusable control hides it
//     from a screen reader while leaving it in the tab order — a real defect).
//   • NO_DRAG on the well and on every cap: they sit inside the right flank's
//     drag band, and a drag region swallows the click whole.
//   • close is engraved in the alarm ink, the same signal the TitleBar's × uses.
//   • the glyphs are BARS AND BOXES, not glyph text: no font dependency, no
//     text-shadow, no alpha for a shadow filter to trace.
//
// THE FLUSH STAGE LIGHTS THEM. Everywhere else these caps are moulded dark in a
// well on a wide metal flank; at flush the flank is 14px, the KEYS stencil is
// gone and the TitleBar's row is hidden by the interlock, so dark-on-dark left a
// maximized window with controls nobody could find (1.14:1 against the well —
// live-found, driver-2). `chassisKeyFinish(stage)` swaps the caps to the lit
// stop of the slab's own key light, with the close cap in the alarm ink and the
// engraving flipped to the chassis black; see the helper for the reasoning and
// the measured ratios. Nothing about the geometry, the IPC or the a11y changes.
function WindowKeys({ size, flank, maximized, cap, finish }: {
  size: number; flank: number; maximized: boolean; cap: ChassisCaptionMode
  finish: ChassisKeyFinish
}) {
  const bar_ = Math.max(6, Math.round(size * 0.42))
  const cut = Math.max(3, Math.round(size * 0.16))
  const pad = chassisKeyWellPadPx(size, flank)
  const well = size + pad * 2
  const lit = finish.lit ? '1' : undefined
  // CAP is a style FRAGMENT, never used as a whole `style` value: each button
  // spreads KEY_HIT first and the fragment after.
  //
  // NOTE THE MISSING box-shadow. The cap carries an inline clip-path, and a
  // clip shears an outer shadow along the chamfer — so the moulding is carried
  // by the gradient plus the RELIEF span inside each cap. (Until this batch the
  // sheet's GROUP B2 also force-cleared box-shadow on these buttons; the keys
  // are excluded from that rule now, but the clip reason stands on its own.)
  const capStyle: React.CSSProperties = {
    ...NO_DRAG,
    width: size, height: size,
    backgroundColor: finish.capFill,
    backgroundImage: finish.capImage,
    clipPath: `polygon(${cut}px 0, 100% 0, 100% calc(100% - ${cut}px), calc(100% - ${cut}px) 100%, 0 100%, 0 ${cut}px)`,
  }
  // The close key is the one cap that may differ: on a lit chassis it takes the
  // alarm ink for its FACE (a red mark on a lit face would be the unreadable
  // pair), on a dressed one it is identical and only the cross is red.
  const closeCapStyle: React.CSSProperties = {
    ...capStyle,
    backgroundColor: finish.closeFill,
    backgroundImage: finish.closeImage,
  }
  const relief: React.CSSProperties = {
    position: 'absolute', inset: 0, pointerEvents: 'none',
    boxShadow: finish.rim,
  }
  const engrave: React.CSSProperties = {
    position: 'absolute', backgroundColor: finish.glyph,
    boxShadow: '0 1px 0 rgba(0,0,0,0.9)',
  }
  const onMin = () => { void window.tachi?.window?.minimize?.().catch(() => {}) }
  const onMax = () => { void window.tachi?.window?.maximizeToggle?.().catch(() => {}) }
  const onClose = () => { void window.tachi?.window?.close?.().catch(() => {}) }

  return (
    <div style={{
      ...LAYER, ...NO_DRAG, position: 'fixed', top: '9%', right: Math.max(0, Math.round((flank - well) / 2)),
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: Math.max(5, Math.round(size * 0.3)), padding: pad,
      backgroundColor: finish.wellFill,
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.9), inset 0 3px 6px rgba(0,0,0,0.75)',
    }}>
      {/* minimise — one bar */}
      <button className="tk-chassis-key" data-chassis-key data-lit={lit}
        onClick={onMin} title="Minimize" aria-label="Minimize"
        style={{ ...KEY_HIT, ...capStyle }}>
        <span style={relief} />
        <span style={{ ...engrave, width: bar_, height: 2 }} />
      </button>
      {/* maximise / restore — an open box, doubled when already maximized */}
      <button className="tk-chassis-key" data-chassis-key data-lit={lit} onClick={onMax}
        title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'}
        style={{ ...KEY_HIT, ...capStyle }}>
        <span style={relief} />
        <span style={{
          position: 'absolute', width: bar_, height: bar_,
          boxShadow: `inset 0 0 0 2px ${finish.glyph}`,
          transform: maximized ? 'translate(1px,1px)' : undefined,
        }} />
        {maximized && (
          <span style={{
            position: 'absolute', width: bar_ - 2, height: bar_ - 2,
            boxShadow: `inset 0 0 0 2px ${finish.glyphMuted}`,
            transform: 'translate(-3px,-3px)',
          }} />
        )}
      </button>
      {/* close — two crossed bars, engraved in the ink the face can carry */}
      <button className="tk-chassis-key" data-chassis-key data-lit={lit} data-key="close"
        onClick={onClose} title="Close" aria-label="Close"
        style={{ ...KEY_HIT, ...closeCapStyle }}>
        <span style={relief} />
        <span style={{ ...engrave, width: bar_, height: 2, backgroundColor: finish.closeGlyph, transform: 'rotate(45deg)' }} />
        <span style={{ ...engrave, width: bar_, height: 2, backgroundColor: finish.closeGlyph, transform: 'rotate(-45deg)' }} />
      </button>
      {/* The well's own stencil. aria-hidden on the CAPTION rather than on an
          ancestor: the keys above are focusable and must stay announced. */}
      {cap !== 'bar' && (
        <div aria-hidden style={{ ...LAYER, ...LEGEND, position: 'relative', letterSpacing: '0.14em' }}>
          KEYS
        </div>
      )}
    </div>
  )
}

// ── Screw ────────────────────────────────────────────────────────────────────
// The mock's `.screw`: a hex-socket head sunk into the plate with a slot across
// it, at a lazy angle so the three do not look stamped from one sprite. Kept
// under the name the feature list uses ('bolts').
function Bolt({ size, pos, slot }: {
  size: number
  pos: { top?: number | string; bottom?: number | string; left?: number | string; right?: number | string }
  slot: number
}) {
  return (
    <div style={{
      ...LAYER, ...pos, width: size, height: size,
      backgroundColor: '#241014',
      backgroundImage: 'linear-gradient(150deg, rgba(120,86,94,0.55), rgba(10,7,8,0) 62%)',
      boxShadow: 'inset 0 0 0 2px #050304',
      clipPath: 'polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%)',
    }}>
      <div style={{
        ...LAYER, top: '50%', left: '50%', width: Math.round(size * 0.58), height: 2,
        transform: `translate(-50%,-50%) rotate(${slot}deg)`,
        backgroundColor: '#050304',
      }} />
    </div>
  )
}
