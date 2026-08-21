// apps/desktop/src/components/OpusChrome.tsx
//
// OPUS-5 · CHASSIS REV 5 — the companion chrome for the `tachi-opus5` theme.
// Same contract as TachikomaChrome.tsx (mounted once in App.tsx, null on every
// other theme, restages inward instead of hiding, decoration is
// pointer-events:none) and the same shared recess mechanism: it stamps the root
// `data-chassis` attribute + the three inset custom properties that globals.css
// turns into a counterbored plate. Only the DRESSING differs — and, since
// 2026-07-27, the vertical SYMMETRY: the recess rule takes a separate top and
// bottom inset, TK-05 stamps one number into both, and this frame stamps the
// mock's 30px header rail over its 24px hint bar.
//
// WHAT THE MOCK SHOWS (notes/CHASSIS-MOCK-SPEC-2026-07-26.md — an inventory
// taken off the owner's Claude Design screens):
//
//   TOP    `OPUS-5 · CHASSIS REV 5 · <w> × <h>` (live numbers, not a fiction),
//          a segmented LED readout, the RUN IO NET PRV PWR lamp block, and the
//          window keys IN THE FRAME. A machinist's ruler too, on a rail thick
//          enough to carry one — the thin rim is not (see OPUS_RULER_MIN_RAIL_PX).
//   LEFT   the compartment stencils P·01 NAV and 02 RAIL — the app's regions are
//          numbered like bays on a rack, and the number is printed on the frame
//          beside the bay it names.
//   RIGHT  P·03 STAGE.
//   BOTTOM P·04 INPUT and the `ENTER run task` hint, on a rail SIX PX THINNER
//          than the header — the mock's own proportion, and the reason the
//          recess rule now carries a separate bottom inset (plus the second
//          ruler, on the same "is there room" terms as the first).
//   STAGE  THE CRAB ENGRAVING — a chartreuse-olive silhouette milled into the
//          plate itself. The mock's caption is the spec: "the crab moves inside
//          the stage as an engraving, so the window edge can never eat it".
//
// TWO THINGS HERE BREAK THE TK-05 FILE'S RULES, both deliberately:
//
//   1. IT USES BITMAPS. The engraving is the two claw PNGs used as a CSS MASK
//      (`mask-image`), so the pixels only decide the SHAPE — the fill is a flat
//      low-contrast olive, which is what makes it read as engraved metal rather
//      than as pasted-on art. There is no vector of the crab in the repo and
//      tracing one by hand in clip-path would be a worse likeness.
//   2. THE ENGRAVING PAINTS ABOVE THE PLATE (`z-index: 6` vs the plate's 5).
//      It has to: the plate is opaque, so anything under it is invisible, and
//      the mock puts the crab INSIDE the stage. It is `pointer-events: none`, it
//      is inset from the plate edge by `opusEngraveInsetPx` (that is the "the
//      window edge can never eat it" part), it is anchored to the plate's
//      bottom-right dead space, and its alpha is a single constant below
//      (ENGRAVE_INK) so the contrast is one edit away if it ever reads as loud
//      over content. Every other layer in this file stays below the plate.
//
//   3. IT CARRIES THE WINDOW'S DRAG REGION. The structure sheet hides the
//      TitleBar's own bar on this theme, so the frame is the only thing left to
//      grab: the top rail and both flanks publish `-webkit-app-region: drag`
//      (DragBands / HeaderRow) and every control on them publishes `no-drag`.
//      A strip OPUS_DRAG_EDGE_PX wide is left non-draggable along the outer
//      window edge, because Windows' native resize border lives there and a drag
//      region painted over it produces a window that moves but never resizes.
//
// The rest of the TK-05 rules hold exactly: no `filter: drop-shadow()` (it
// traces alpha and would ghost the 8px legends), no `cursor` (globals.css owns
// the resize affordance), `pointer-events: none` on every decorative div, and no
// width-gated early return — the mock's 1068×800 panel IS the daily size.
//
// ── HONESTY LAW (2026-07-27, same law as ChassisSidebarPanel.tsx) ───────────
// EVERY LAMP AND EVERY READOUT CELL IS A REAL READING, or it is dark. There is
// no third state on this frame — no "looks alive" cell, no placeholder level, no
// lamp whose only job is to be lit. The audit that produced this rule found
// three violations here, all of them shipped: `GPU` was hardcoded ON, the
// segmented readout was hardcoded to six of ten cells, and `IO` was wired to the
// RUN signal, so it repeated its neighbour instead of measuring anything.
//
// AND NOT ONE OF THEM MAY COST A TIMER. This component is mounted for the whole
// life of the app, so a poll here is a poll forever (the idle audit has just
// finished deleting exactly those). Every reading below is therefore a zustand
// selector, a pair of platform events, or a constant that is true by
// construction — the five signals are documented on `OpusLampMode` in the
// helpers, together with why the GPU cell could not honestly survive.
//
// LEGENDS ARE DIEGETIC HARDWARE MARKINGS, NOT UI COPY, and are deliberately not
// i18n keys: bay numbers on a rack (`P·01 NAV`), a chassis revision, a ruler and
// a key hint stencilled on metal. A bay number that changed language with the UI
// locale would read as a bug; and dragging silkscreen into the 8-locale parity
// contract buys no reader anything. Same decision as TachikomaChrome.tsx.
import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useThemeStore } from '../store/theme.store'
import { useWindowState } from '../hooks/useWindowState'
import { useChatStore } from '../store/chat.store'
import { useAgentStore, useAgentContextWindow } from '../store/agent.store'
import { contextSourceNote } from '../store/modelWindow.store'
import { useNodesRunStore, nodesRunActive } from '../store/nodesRun.store'
import { useDownloadsStore } from '../store/downloads.store'
import { usePrivacyStore } from '../store/privacy.store'
import {
  chassisChamferPx,
  type ChassisStage, type ChassisCaptionMode,
} from './tachikoma/tachikomaChrome.helpers'
import {
  OPUS_THEME, opusLayout, opusRulerStepPx, opusRulerHeightPx, opusRulerVisible,
  opusEngraveInsetPx, opusEngraveHeightPx, opusEngraveVisible, opusEngraveTopPx,
  OPUS_ENGRAVE_BURR_PX, opusLedPx, opusLegendVisible,
  opusDragBandPx, OPUS_DRAG_EDGE_PX,
  opusFrameBitePx, opusFrameCorePx, opusFrameCoreChamferPx,
  opusCaptionMode, opusBayCaptionMode,
  opusActiveBay, chassisRunActive, type OpusBay, type OpusBezel,
  opusDownloadActive, opusContextChars, opusSegmentLevel, OPUS_SEG_COUNT,
  type OpusLampMode, type OpusLampReadings,
} from './opus/opusChrome.helpers'
import clawLeft from '../assets/crab/claw-left.png'
import clawRight from '../assets/crab/claw-right.png'

/** The engraving's ink. ONE constant on purpose: it is the only thing in this
 *  file that paints over app content, so its contrast is a single edit. A hair
 *  LIGHTER than the chassis void, like a bevel catching the light — a darker
 *  fill is invisible on #0b0d0d. */
const ENGRAVE_INK = 'rgba(126,158,44,0.095)'

/** The BURR — mock option 1c's second strike: the same silhouette in the signal
 *  ink, displaced by OPUS_ENGRAVE_BURR_PX, reading as the lip a tool throws up
 *  on one side of the groove. Fainter than the groove itself on purpose; the
 *  pair is what makes a flat fill read as cut metal. */
const ENGRAVE_BURR_INK = 'rgba(184,242,39,0.055)'

/** How far (px) the two claw halves of the engraving overlap on the midline, so
 *  their baked alpha ramps sum instead of abutting into a visible hairline. See
 *  the note in Engraving(). */
const ENGRAVE_SEAM_PX = 4

const CHROME_CSS = `
@keyframes opus-chassis-seg {
  0%, 100% { opacity: 1;   box-shadow: 0 0 5px 0 rgba(184,242,39,0.75); }
  50%      { opacity: 0.4; box-shadow: 0 0 9px 2px rgba(184,242,39,0.22); }
}
/* The mock's LED rack blinks in STEPS — a cell is on or off, never in between,
   which is what separates an indicator lamp from a fading decoration. */
@keyframes opus-chassis-led {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.16; }
}
/* !important: the cap's fill is an INLINE style, which outranks any normal
   author rule — without it the key would never light up under the pointer. */
.opus-chassis-key:hover  { background-color: rgba(28,36,34,0.98) !important; }
.opus-chassis-key:active { transform: translateY(1px); }
.opus-chassis-key:focus-visible { outline: 2px solid var(--opus-signal, #b8f227); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .opus-chassis * { animation: none !important; }
}`

/** Base style for EVERY div in this file — decoration only, never a hit target.
 *  The unit test asserts one `...LAYER` spread per `<div`, so a new layer cannot
 *  skip it. */
const LAYER: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  userSelect: 'none',
}

/** The ONE exception, and the only `pointerEvents: 'auto'` in the file: the
 *  window keys sit IN THE FRAME on this theme (the mock draws them there), so
 *  they are real `<button>`s on the same `window.tachi.window` IPC the TitleBar
 *  uses. Buttons, not divs, so the `<div` guard stays mechanical; and they live
 *  outside the aria-hidden scenery wrapper, because an aria-hidden ancestor over
 *  a focusable control hides it from a screen reader without removing it from
 *  the tab order. */
/** `-webkit-app-region`, which React's CSS types do not carry — same cast the
 *  TitleBar uses (components/layout/TitleBar.tsx). THE FRAME IS THE HANDLE: this
 *  theme hides the TitleBar's own bar, so with no drag region on the chassis the
 *  window could be resized but never MOVED. `drag` goes on inert bands inside
 *  the rails, `no-drag` on every control that sits on them. */
const DRAG: React.CSSProperties = {
  ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'drag',
} as React.CSSProperties
const NO_DRAG: React.CSSProperties = {
  ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'no-drag',
} as React.CSSProperties

const KEY_HIT: React.CSSProperties = {
  position: 'relative',
  pointerEvents: 'auto',
  ...NO_DRAG,
  padding: 0,
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** Anodised graphite. `background-attachment: fixed` anchors the gradients to
 *  the VIEWPORT so the four bars read as one milled frame instead of four
 *  separately-lit strips. */
const FRAME: React.CSSProperties = {
  backgroundColor: '#080a0a',
  backgroundImage: [
    'radial-gradient(120% 90% at 10% 0%, rgba(255,255,255,0.05), rgba(255,255,255,0) 58%)',
    'radial-gradient(80% 70% at 100% 100%, rgba(184,242,39,0.07), rgba(184,242,39,0) 62%)',
    'repeating-linear-gradient(90deg, rgba(255,255,255,0.02) 0 1px, rgba(255,255,255,0) 1px 3px)',
    'linear-gradient(170deg, rgba(30,36,34,0.85), rgba(7,9,9,0.96))',
  ].join(','),
  backgroundAttachment: 'fixed',
}

/** The CHARTREUSE PERIMETER. Each bar carries a signal hairline on its inner
 *  face, so the four bars together draw one continuous acid rule around the
 *  opening — the frame line the mock puts around the whole window. The rest is
 *  counterbore lighting. box-shadow only, never `filter` (see the header).
 *
 *  THE RULE IS PURE ACID, not a wash of it. It shipped at 55% alpha over the
 *  graphite, which lands around #6d8c22 — a muted olive line on a theme whose
 *  whole claim is that the acid is the only thing alive. The owner's note is
 *  the spec: "the frame has to END on the acid". At full strength this is the
 *  same ink as --opus-signal, the SEND key, the LEDs and the plate rim
 *  (structure GROUP M), so the eye reads one continuous edge rather than four
 *  differently-diluted ones. The `var()` fallback keeps the line drawn even if
 *  the layer is ever rendered before the theme sheet resolves. */
const RULE = 'var(--opus-signal, #b8f227)'
const WALL: Record<'top' | 'bottom' | 'left' | 'right', string> = {
  top: `inset 0 -2px 0 ${RULE}, inset 0 -9px 11px -8px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.05)`,
  bottom: `inset 0 2px 0 ${RULE}, inset 0 10px 12px -9px rgba(0,0,0,0.92), inset 0 -1px 0 rgba(255,255,255,0.04)`,
  left: `inset -2px 0 0 ${RULE}, inset -10px 0 12px -9px rgba(0,0,0,0.92), inset 1px 0 0 rgba(255,255,255,0.045)`,
  right: `inset 2px 0 0 ${RULE}, inset 10px 0 12px -9px rgba(0,0,0,0.92), inset -1px 0 0 rgba(255,255,255,0.045)`,
}

/** The acid a bitten rail's RIM layer is filled with — see `FrameBite` below.
 *  Same ink as RULE, as a flat fill rather than a shadow colour. */
const RIM_INK = 'var(--opus-signal, #b8f227)'

const LEGEND: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 8,
  lineHeight: 1,
  letterSpacing: '0.2em',
  color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
}

/** The LED bar a compartment stencil degrades to when the frame is too thin to
 *  print on. Nothing disappears — "chips truncate to their LED bars". */
function segBar(w: number, h: number): React.CSSProperties {
  return {
    width: w, height: h,
    backgroundColor: 'rgba(184,242,39,0.5)',
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.55)',
  }
}

/** Live viewport size — load-bearing geometry (the frame restages on width) AND
 *  real data: the header prints the panel's actual pixel size, which is what the
 *  mock's `1068 × 800` legend is. */
/** LINK STATE — the NET lamp's whole source, and a genuinely free one: the
 *  platform already knows, and it TELLS you (`online` / `offline`), so there is
 *  nothing to poll. Two listeners, no timer, and the value is re-synced on mount
 *  in case the transition happened before this hook subscribed.
 *
 *  WHAT IT HONESTLY MEANS is "this machine has a network link", not "the internet
 *  answers" — a reachability probe is a request on a schedule, i.e. exactly the
 *  timer this frame may not arm. So the lamp is a LINK lamp, which is what a NET
 *  lamp on hardware has always been: it goes dark when the interface goes, and it
 *  never claims more than that. */
function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  )
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine !== false)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])
  return online
}

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

export function OpusChrome() {
  const theme = useThemeStore(s => s.theme)
  const { maximized } = useWindowState()
  const { width, height } = useViewport()
  // WHICH BAY IS LIT, from the router — the same source the sidebar CHASSIS MAP
  // reads (ChassisSidebarPanel). The flank stencils used to hardcode `lit` on
  // NAV and STAGE, so the frame claimed two bays were live at once and
  // contradicted the map three inches to its right (live-found). Safe to call
  // unconditionally: App.tsx mounts this component INSIDE the MemoryRouter, and
  // the hook has to run before the theme early-return anyway.
  const { pathname } = useLocation()
  const activeBay = opusActiveBay(pathname)
  // IS ANYTHING RUNNING — the SAME boolean the header scan bar rides
  // (AppShell publishes it on `[data-scan-bar]`), read here from the same three
  // stores rather than passed down, because nothing links the two components and
  // a prop chain through App.tsx would be a second place to keep in sync. Three
  // boolean selectors, so the frame re-renders only when the answer FLIPS —
  // never on a token, a step or a node result. Before this the RUN lamp and the
  // readout's live cell were hardcoded ON: the instrument claimed a run was in
  // flight every second the app was open, which is the same defect as an
  // animation that outlives its state.
  const agentStatus = useAgentStore(s => s.status)
  const nodesRunning = useNodesRunStore(nodesRunActive)
  // BOTH chat ids, ORed — the SAME expression AppShell publishes on the scan
  // bar, and for the same live-found reason: `streamingMessageId` only exists
  // between the provider's first chunk and its last, which on a short answer is
  // a ~0ms window, so the RUN lamp and the readout's breath stayed dark through
  // an entire send. `streamingConversationId` is armed at SEND, so the OR spans
  // the wait for first-token too. If one of the two files changes, change both.
  const chatStreaming = useChatStore(s => s.streamingConversationId !== null || s.streamingMessageId !== null)
  const runActive = chassisRunActive({ agentStatus, nodesRunning, chatStreaming })
  // ── THE OTHER FOUR READINGS (see the HONESTY LAW in the header) ────────────
  // IO — the download manager's live queue, from the SAME store the console
  // dock's DownloadStrip renders. A selector that returns the BOOLEAN, not the
  // array, so a 4/s progress broadcast on a multi-GB model re-renders the frame
  // exactly twice: once when the first byte moves and once when the last does.
  const ioActive = useDownloadsStore(s => opusDownloadActive(s.items))
  // NET — the platform's link state. Two events, no timer (see useOnline).
  const online = useOnline()
  // PRV — PRIVATE MODE, the posture that decides what the app may do with that
  // link. One boolean off a persisted store; it flips only when the operator
  // flips it.
  const privateMode = usePrivacyStore(s => s.mode === 'private')
  // CTX — the readout's level, and the SAME number the sidebar's CTX gauge
  // prints (ChassisSidebarPanel): the live agent session's context estimated at
  // chars / 4 against the store's own maximum. Derived INSIDE the selector on
  // purpose: it returns the integer 0..10, so the frame re-renders when a CELL
  // changes and never on the event that moved the count by 40 characters.
  // The denominator is the window the ROUTED MODEL actually has, resolved once
  // by useAgentContextWindow — the same call the sidebar's CTX row makes,
  // which is what keeps the ladder and the percentage from contradicting each
  // other three inches apart. It was DEFAULT_MAX_TOKENS: a flat 32k for every
  // model, so a 200k session lit a full ladder at a fifth of its context.
  // null (nobody published a window) leaves the ladder DARK — the frame has no
  // room for "unknown", and an unlit housing is the one state that claims
  // nothing. The sidebar omits its row for the same reason.
  //
  // The ladder is a percentage drawn as ten cells, so it owes the same
  // disclosure the sidebar gauge does: `ctxTitle` names the window and, when it
  // did not come from the provider live, who supplied it. The housing had NO
  // tooltip at all until 2026-08-02 — ten lit cells and no way to ask what they
  // were counted against.
  const ctxWin = useAgentContextWindow()
  const ctxWindowTokens = ctxWin === null ? null : ctxWin.tokens
  const ctxLevel = useAgentStore(
    s => ctxWindowTokens === null
      ? 0
      : opusSegmentLevel(opusContextChars(s.messages) / 4 / ctxWindowTokens),
  )
  const ctxSourceNote = ctxWin === null ? null : contextSourceNote(ctxWin.source)
  const ctxTitle = ctxWindowTokens === null
    ? 'CTX — no context window published for the routed model'
    : `CTX ${ctxLevel}/${OPUS_SEG_COUNT} of ${ctxWindowTokens.toLocaleString()} tok`
      + (ctxSourceNote === null ? '' : ` (window: ${ctxSourceNote})`)
  const layout = opusLayout({ theme, width, height, maximized })
  // PWR is the one constant: a lamp whose claim is entailed by its own
  // visibility — if this cell is on screen, the renderer is painting it.
  const lamps: OpusLampReadings = {
    run: runActive, io: ioActive, net: online, prv: privateMode, pwr: true,
  }

  // Shared recess plumbing — see the long comment on the same effect in
  // TachikomaChrome.tsx: the INACTIVE branch deliberately does nothing, because
  // both components write the same attribute and only "cleanup removes / effect
  // sets" is correctly ordered by React on a theme switch.
  //
  // THE VERTICAL AXIS IS TWO PROPERTIES, and this frame is why: the mock's
  // header rail (30px — LED rack, revision caption, window keys) is six pixels
  // thicker than its hint bar (24px — one line of `ENTER run task` type). The
  // recess rule used to spend a single `--chassis-inset-y` on both edges, which
  // made every chassis vertically symmetric BY CONSTRUCTION and forced this
  // frame to draw its bottom rail at the header's thickness. Both properties are
  // stamped unconditionally — an unset one falls back to the rule's own narrow
  // default and un-recesses that edge.
  const stage = layout?.stage ?? null
  const bx = layout?.bezel.x ?? 0
  const by = layout?.bezel.y ?? 0
  const bb = layout?.bezel.bottom ?? 0
  useEffect(() => {
    if (!stage) return
    const root = document.documentElement
    root.setAttribute('data-chassis', stage)
    root.style.setProperty('--chassis-inset-x', `${bx}px`)
    root.style.setProperty('--chassis-inset-top', `${by}px`)
    root.style.setProperty('--chassis-inset-bottom', `${bb}px`)
    return () => {
      root.removeAttribute('data-chassis')
      root.style.removeProperty('--chassis-inset-x')
      root.style.removeProperty('--chassis-inset-top')
      root.style.removeProperty('--chassis-inset-bottom')
    }
  }, [stage, bx, by, bb])

  // TITLEBAR HANDOFF. OpusKeys now renders at EVERY stage (its thin-rail
  // bail-out is gone — live-found: it silently unmounted at flush while this
  // very attribute kept the TitleBar hidden, stranding a maximized window
  // with ZERO controls; the attribute LIED and defeated the interlock). The
  // attribute must always mirror the render truth: today that is "whenever
  // the chassis is live"; if a render gate ever returns, gate this the same
  // way or the interlock lies again.
  useEffect(() => {
    if (!stage) return
    const root = document.documentElement
    root.setAttribute('data-chassis-keys', '1')
    return () => { root.removeAttribute('data-chassis-keys') }
  }, [stage])

  // THE IO LAMP'S SUBSCRIPTION, and the one line of plumbing on this frame.
  // `init()` attaches the main process's `downloads:changed` broadcast and
  // fetches the queue ONCE; it is idempotent and refcounted (the DownloadStrip
  // calls the same thing), so the chassis either joins the existing listener or
  // arms the only one. NOT A POLL — the queue is pushed, and with no bridge (a
  // test host, a non-Electron host) it is a no-op and the lamp stays dark.
  // Keyed on a BOOLEAN, not on `stage`: a restage is a resize, and re-arming an
  // IPC listener every time the window crosses 1180px would be churn for a value
  // that cannot have changed.
  const chassisLive = stage !== null
  useEffect(() => {
    if (!chassisLive) return
    return useDownloadsStore.getState().init()
  }, [chassisLive])

  if (theme !== OPUS_THEME || !layout) return null
  return (
    <Frame
      stage={layout.stage}
      bezel={layout.bezel}
      viewport={{ width, height }}
      maximized={maximized}
      activeBay={activeBay}
      lamps={lamps}
      ctxLevel={ctxLevel}
      ctxTitle={ctxTitle}
    />
  )
}

// ── The frame ────────────────────────────────────────────────────────────────
// Four bars around a hole. The hole is EMPTY: no decorative layer covers the
// plate. The single exception — the engraving — is a sibling of the frame with
// its own z-index, documented in the header.
//
// THE OUTER CORNERS CARRY THE THEME'S BITE. They used to take a symmetric
// chamfer on all four (chassisChamferPx), which is a bevel — a shape the theme
// says nothing with. PATCH-01's caption for OPUS-5 is "the pincer profile is
// the corner bite cut into every control", and the frame is the biggest control
// in the app, so it now takes the SAME cut GROUP B puts on every button: a
// stepped notch out of the top-left, a 45° chamfer off the bottom-right, the
// other two corners square. Each cut also terminates on the acid — every bitten
// rail is drawn TWICE, an acid RIM layer under the metal, both clipped with the
// same polygon at two sizes so their difference is a uniform band along the cut
// faces (opusFrameBitePx / opusFrameCorePx). `chassisChamferPx` survives as the
// floor for the ruler inset only.
//
// NOTHING ABOUT THE WINDOW'S HANDLING MOVES. The cuts are clip-path on the two
// RAILS; the drag bands and the resize strip are separate siblings (DragBands)
// that are not clipped by them, so the grab and resize areas are byte-identical
// to before — the bite costs a few px of PAINT in two corners and nothing else.
function Frame({ stage, bezel, viewport, maximized, activeBay, lamps, ctxLevel, ctxTitle }: {
  stage: ChassisStage
  bezel: OpusBezel
  viewport: { width: number; height: number }
  maximized: boolean
  /** The bay the operator is working in — exactly one stencil lights up. */
  activeBay: OpusBay
  /** The rack's five readings. `lamps.run` also drives the readout's live cell. */
  lamps: OpusLampReadings
  /** Lit cells (0..OPUS_SEG_COUNT) of the readout — the live session's CTX. */
  ctxLevel: number
  /** What those cells were counted against, and who supplied that window. */
  ctxTitle: string
}) {
  const { x, y } = bezel
  // THE HINT RAIL, six px under the header. Everything the bottom bar draws is
  // derived from THIS number and never from `y` — the chamfer and its acid rim,
  // the pad the hint type sits on, the flanks' lower end, the plate height.
  const foot = bezel.bottom
  const ch = chassisChamferPx(stage, bezel)
  // Three captions, one per surface, each asking its OWN surface whether it can
  // print — see `opusCaptionMode` / `opusBayCaptionMode`. One `cap` derived from
  // the top rail is what used to turn the 16px flanks into LED bars below 1180px
  // (the flanks are the same 16px at every stage; nothing about them was short).
  const capRail = opusCaptionMode(stage, y)
  const capFoot = opusCaptionMode(stage, foot)
  const capBay = opusBayCaptionMode(x)
  const rulerH = opusRulerHeightPx(y)
  const footRulerH = opusRulerHeightPx(foot)
  const step = opusRulerStepPx(stage)
  const plateW = viewport.width - 2 * x
  const plateH = viewport.height - y - foot
  // Rails carry the RULER on their outer edge and everything else on the
  // plate-facing side, so the two can never stack on a thin bezel.
  const railPad = Math.max(3, Math.round(y * 0.2))
  const footPad = Math.max(3, Math.round(foot * 0.2))
  // THE FRAME'S OWN PINCER BITE — a stepped notch out of the window's top-left
  // corner and a chamfer off its bottom-right, the same asymmetric cut the
  // structure sheet's GROUP B puts on every button, at frame scale. Both cuts
  // live wholly inside the rails (the flanks are inset by the rail they meet),
  // so the flanks stay unclipped and their drag bands are untouched.
  //
  // TWO BITES, ONE PER RAIL. `opusFrameBitePx` derives the cut from the rail it
  // is milled into, so the thinner bottom rail gets its own — passing the top
  // rail's bite to a 24px bar is exactly how a cut ends up sheared by the metal's
  // own edge, and the `notch + rim <= rail` invariant is stated per rail.
  const bite = opusFrameBitePx(bezel)
  const core = opusFrameCorePx(bite)
  const footBite = opusFrameBitePx({ x, y: foot })
  const footChamfer = opusFrameCoreChamferPx(footBite)
  // The ruler starts clear of the cut it would otherwise be sheared by: the
  // scale is on the rail's OUTER edge, which is exactly where the metal is
  // missing. `ch` is still the floor — the ruler never ran to the corner.
  const rulerInset = Math.max(ch, bite.notch + bite.rim)
  const footRulerInset = Math.max(ch, footBite.notch + footBite.rim)

  return (
    <>
    <div className="opus-chassis"
      style={{ ...LAYER, position: 'fixed', inset: 0, zIndex: 0 }}>
      <style>{CHROME_CSS}</style>

      {/* ── SCENERY ── silkscreen, lamps, rulers and metal. */}
      <div aria-hidden style={{ ...LAYER, inset: 0 }}>

        {/* TOP RAIL · RIM — the acid the notch terminates on. Same box and the
            same polygon as the metal above it, only UNGROWN, so the only place
            it is ever visible is the `rim`-wide band along the two cut faces. */}
        <div style={{
          ...LAYER, top: 0, left: 0, right: 0, height: y,
          backgroundColor: RIM_INK,
          clipPath: notchPath(bite.notch, bite.step),
        }} />

        {/* TOP RAIL */}
        <div style={{
          ...LAYER, ...FRAME, top: 0, left: 0, right: 0, height: y,
          boxShadow: WALL.top,
          clipPath: notchPath(core.notch, core.step),
        }}>
          {opusRulerVisible(y) && <Ruler side="top" inset={rulerInset} height={rulerH} step={step} />}
          <HeaderRow
            cap={capRail} rail={y} bottom={railPad}
            left={x + 4} right={x + keysWidth(y) + 16}
            viewport={viewport} lamps={lamps} ctxLevel={ctxLevel} ctxTitle={ctxTitle}
          />
        </div>

        {/* BOTTOM RAIL · RIM — the same trick on the bottom-right chamfer, cut
            to the HINT rail's own thickness. */}
        <div style={{
          ...LAYER, bottom: 0, left: 0, right: 0, height: foot,
          backgroundColor: RIM_INK,
          clipPath: chamferPath(footBite.notch),
        }} />

        {/* BOTTOM RAIL — the mock's 24px hint bar: `ENTER run task`, the dotted
            datum, `P·04 INPUT`. Thinner than the header rail, which is the whole
            of this bar's job — one line of type, no rack and no keys. */}
        <div style={{
          ...LAYER, ...FRAME, bottom: 0, left: 0, right: 0, height: foot,
          boxShadow: WALL.bottom,
          clipPath: chamferPath(footChamfer),
        }}>
          {opusRulerVisible(foot) && (
            <Ruler side="bottom" inset={footRulerInset} height={footRulerH} step={step} />
          )}
          {capFoot === 'bar' ? (
            <>
              <div style={{ ...LAYER, ...segBar(30, 3), left: x + 4, top: footPad }} />
              <div style={{ ...LAYER, ...segBar(44, 3), right: x + 4, top: footPad }} />
            </>
          ) : (
            <>
              <div style={{
                ...LAYER, ...LEGEND, left: x + 4, top: footPad,
              }}>ENTER run task</div>
              <div style={{
                ...LAYER, ...LEGEND, right: x + 4, top: footPad,
                color: 'var(--accent-text)',
              }}>P·04 INPUT</div>
            </>
          )}
        </div>

        {/* LEFT FLANK — bays 01 NAV and 02 RAIL, printed beside what they name.
            `lit` is ROUTE-DRIVEN, never hardcoded: the stencil is the same
            reading as the sidebar CHASSIS MAP, so exactly one of the three bays
            on the frame is alight at any time. */}
        <div style={{
          ...LAYER, ...FRAME, top: y, bottom: foot, left: 0, width: x,
          boxShadow: WALL.left,
        }}>
          <Bay cap={capBay} flank={x} at="20%" id="P·01" label="NAV" lit={activeBay === 'nav'} />
          <Bay cap={capBay} flank={x} at="56%" id="02" label="RAIL" lit={activeBay === 'rail'} />
        </div>

        {/* RIGHT FLANK — bay 03 STAGE. */}
        <div style={{
          ...LAYER, ...FRAME, top: y, bottom: foot, right: 0, width: x,
          boxShadow: WALL.right,
        }}>
          <Bay cap={capBay} flank={x} at="38%" id="P·03" label="STAGE" lit={activeBay === 'stage'} />
        </div>

        {/* DRAG BANDS — the frame is the window's handle (see DRAG). Painted
            last inside the scenery so they sit over the rails; the keys are
            outside this wrapper and later still, so their `no-drag` wins. */}
        <DragBands bezel={bezel} />
      </div>

      {/* WINDOW KEYS — real controls, in the frame, outside the aria-hidden wrap. */}
      <OpusKeys rail={y} inset={x + 4} maximized={maximized} />
    </div>

    {/* THE ENGRAVING — the one layer above the plate, and therefore a SIBLING of
        the frame, not a child: the frame's container carries `z-index: 0`, which
        opens a stacking context, and a child of it can never paint above the
        plate no matter what z-index it asks for. See the file header. */}
    {opusEngraveVisible(plateW, plateH) && (
      <Engraving
        inset={opusEngraveInsetPx(bezel)}
        height={opusEngraveHeightPx(plateH)}
        bezel={bezel}
        plateH={plateH}
      />
    )}
    {/* …and its BURR: the same silhouette, same size, same anchor, displaced by
        OPUS_ENGRAVE_BURR_PX in the signal ink (mock option 1c). Rendered as a
        second strike rather than as a shadow because `filter: drop-shadow` is
        banned in this file and would trace the mask's alpha anyway. */}
    {opusEngraveVisible(plateW, plateH) && (
      <Engraving
        burr
        inset={opusEngraveInsetPx(bezel)}
        height={opusEngraveHeightPx(plateH)}
        bezel={bezel}
        plateH={plateH}
      />
    )}
    </>
  )
}

// ── The bite, as two polygons ────────────────────────────────────────────────
// Written out here rather than inline so the RIM layer and the METAL layer of a
// rail are provably the SAME shape at two sizes — the whole acid-band trick is
// that their difference is a uniform band, and two hand-typed polygons drift.
//
// GROUP B's button bite, for reference:
//   polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%,
//           0 100%, 0 4px, 4px 4px, 4px 0)
// — a step out of the top-left, a 45° chamfer off the bottom-right, the other
// two corners square. The frame takes the same two cuts; because the frame is
// four bars and not one box, the step lands on the TOP rail and the chamfer on
// the BOTTOM one, and each bar keeps its other three corners square.

/** The TOP rail: a two-cut staircase out of its top-left corner.
 *  `n` is the cut's depth on both axes, `s` its inner tread. */
function notchPath(n: number, s: number): string {
  if (n <= 0) return 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
  return `polygon(${n}px 0, 100% 0, 100% 100%, 0 100%, 0 ${n}px, ${s}px ${n}px, ${s}px ${s}px, ${n}px ${s}px)`
}

/** The BOTTOM rail: a 45° chamfer off its bottom-right corner, `c` deep. */
function chamferPath(c: number): string {
  if (c <= 0) return 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
  return `polygon(0 0, 100% 0, 100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, 0 100%)`
}

/** Width (px) the in-frame key row occupies — needed by the top rail to keep the
 *  lamp block clear of it, so it is derived once here rather than guessed twice. */
function keysWidth(rail: number): number {
  const s = keySizePx(rail)
  const gap = Math.max(4, Math.round(s * 0.3))
  const pad = Math.max(2, Math.round(s * 0.16))
  return s * 3 + gap * 2 + pad * 2
}

/** Edge length (px) of one in-frame window key, derived from the RAIL it sits in
 *  (the TK-05 keys derive from the flank — different mount, different axis).
 *
 *  THE CLEARANCE IS 10px, NOT 20 (2026-07-27). `rail - 20` was written against
 *  the slab-era rails (46-62px), where it returned the 22px cap; on the thin
 *  rim's 30px header rail it collapsed to the 12px FLOOR — i.e. the frame got
 *  thinner and the only window controls on screen got smaller with it, which is
 *  the opposite of what the room allows. 10px of clearance keeps the whole key
 *  well inside the rail at every thickness the bezel can produce (30 → 20px cap
 *  in a 26px well, 24 → 14 in 18, a viewport-clamped 16 → the 12px floor, which
 *  stands proud exactly as it always did) while the `Math.max(12, …)` floor —
 *  the clickable minimum, pinned by the suite — is untouched. */
function keySizePx(rail: number): number {
  return Math.min(22, Math.max(12, rail - 10))
}

// ── Ruler ────────────────────────────────────────────────────────────────────
// A machinist's scale across the rail: minor ticks at `step`, a major tick every
// fifth one drawn at full height. Two repeating gradients, one element.
function Ruler({ side, inset, height, step }: {
  side: 'top' | 'bottom'; inset: number; height: number; step: number
}) {
  return (
    <div style={{
      // The rail's OUTER edge — the plate-facing side carries the legends, so a
      // thin bezel never has to stack a scale under a lamp.
      ...LAYER, left: inset, right: inset, height,
      ...(side === 'top' ? { top: 2 } : { bottom: 2 }),
      backgroundImage: [
        `repeating-linear-gradient(to right, rgba(184,242,39,0.5) 0 1px, rgba(0,0,0,0) 1px ${step * 5}px)`,
        `repeating-linear-gradient(to right, rgba(255,255,255,0.16) 0 1px, rgba(0,0,0,0) 1px ${step}px)`,
      ].join(','),
      backgroundSize: '100% 100%, 100% 45%',
      backgroundRepeat: 'no-repeat, no-repeat',
      // Minor ticks grow from the ruler's baseline, and the baseline is the
      // frame's OUTER edge — top rail measures downward, bottom rail upward.
      backgroundPosition: side === 'top' ? '0 0, 0 0' : '0 100%, 0 100%',
    }} />
  )
}

// ── The header row (mock option 1b) ──────────────────────────────────────────
// ONE flex row across the top rail, in the mock's order and nothing else:
//
//   OPUS-5 │ CHASSIS REV 5 · 1068 × 800 │ ·····dotted rule····· │ ▮▮▯ readout │
//   ▬▬▬▬▬ rack │ RUN IO NET PRV PWR │ (the window keys, mounted separately)
//
// A ROW, not four independently-anchored layers: the mock's dotted rule is the
// thing that takes up the slack (`flex: 1`), which is what lets every chip keep
// its natural size and still land where the mock puts it at any width. The old
// version pinned the readout at a hardcoded `left: 41%`, so it drifted into the
// caption on a narrow window and into the lamps on a wide one.
//
// The row is also a DRAG surface — see DRAG. It sits inside the top rail, so
// grabbing the frame's top edge moves the window like a title bar would.
function HeaderRow({ cap, rail, bottom, left, right, viewport, lamps, ctxLevel, ctxTitle }: {
  cap: ChassisCaptionMode
  rail: number
  bottom: number
  left: number
  right: number
  viewport: { width: number; height: number }
  lamps: OpusLampReadings
  ctxLevel: number
  ctxTitle: string
}) {
  return (
    <div style={{
      ...LAYER, ...DRAG, left, right, bottom,
      display: 'flex', alignItems: 'flex-end', gap: cap === 'bar' ? 6 : 11,
    }}>
      {cap === 'bar' ? (
        // The caption's LED-bar truncation — the mock's own "chips truncate to
        // their LED bars". The badge does not vanish, it becomes a bar.
        <div style={{ ...LAYER, position: 'relative', flexShrink: 0, ...segBar(52, 3) }} />
      ) : (
        <>
          <div style={{
            ...LAYER, ...LEGEND, position: 'relative', flexShrink: 0,
            color: 'var(--accent-alt)', letterSpacing: '0.22em', fontSize: 9, fontWeight: 800,
          }}>OPUS-5</div>
          <div style={{
            ...LAYER, ...LEGEND, position: 'relative', flexShrink: 0,
            letterSpacing: '0.16em', fontSize: 9, fontWeight: 500,
          }}>
            {cap === 'full'
              ? `CHASSIS REV 5 · ${viewport.width} × ${viewport.height}`
              : `REV 5 · ${viewport.width}×${viewport.height}`}
          </div>
        </>
      )}

      {/* THE DOTTED RULE — a 1px-on / 8px-off datum scale that eats the slack.
          `minWidth: 0` so it collapses instead of pushing the rack off the rail
          when the row runs out of room. */}
      <div style={{
        ...LAYER, position: 'relative', flex: 1, minWidth: 0, height: 9, marginBottom: 1,
        backgroundImage: 'repeating-linear-gradient(to right, var(--border) 0 1px, rgba(0,0,0,0) 1px 9px)',
      }} />

      <SegmentReadout rail={rail} level={ctxLevel} runActive={lamps.run} title={ctxTitle} />
      <LampBlock rail={rail} lamps={lamps} />
    </div>
  )
}

// ── Segmented LED readout — THE CTX LADDER ───────────────────────────────────
// Ten cells. It shipped with SIX OF THEM HARDCODED LIT: an instrument face
// showing a number nothing had measured, which is the sidebar's retired
// SERVO/OPTIC needles in a different housing. The cells now show the live agent
// session's CONTEXT LOAD — the SAME reading the sidebar's CTX gauge prints
// (ChassisSidebarPanel), estimated the way every CTX surface in this app
// estimates it (chars / 4 against the store's own maximum). One number, two
// surfaces: the sidebar prints the percentage, the frame lights the ladder.
//
// AN EMPTY GAUGE IS A READING. With no agent session there is no context and no
// cell is lit — the unlit cells are still drawn in their housing, so the ladder
// reads as EMPTY rather than as absent. The old comment argued the opposite ("a
// readout that blanks when idle reads as a dead instrument"), which is how six
// cells of nothing got shipped in the first place.
//
// The BREATH still rides the run: the LEADING lit cell pulses while a run is in
// flight and holds steady otherwise. With nothing lit there is no leading cell
// and nothing breathes — the RUN lamp two chips to the right is what carries
// "something is happening" when the ladder is empty.
const SEG_COUNT = OPUS_SEG_COUNT

function SegmentReadout({ rail, level, runActive, title }: {
  rail: number
  /** Lit cells, 0..SEG_COUNT — the CTX reading, never a constant. */
  level: number
  runActive: boolean
  /** The reading in words, including the PROVENANCE of its denominator: ten
   *  lit cells are a percentage, and a percentage owes the same disclosure the
   *  sidebar's CTX gauge makes. */
  title: string
}) {
  // Sized off a FRACTION of the rail, not `rail - k`: a subtracted constant
  // outgrows the rail at the flush bezel and gets sheared by the rail's clip.
  const h = Math.max(4, Math.min(9, Math.round(rail * 0.2)))
  const w = Math.max(3, Math.round(h * 0.55))
  return (
    <div title={title} style={{
      ...LAYER, position: 'relative', flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 2,
      padding: 2,
      backgroundColor: '#050706',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.9), inset 0 2px 4px rgba(0,0,0,0.75)',
    }}>
      {Array.from({ length: SEG_COUNT }, (_, i) => {
        const live = runActive && i === level - 1
        return (
          <div key={i} style={{
            ...LAYER, position: 'relative', width: w, height: h,
            backgroundColor: i < level ? 'var(--opus-signal, #b8f227)' : 'rgba(120,132,118,0.22)',
            // The live cell's shadow belongs to the keyframes.
            boxShadow: live ? undefined : 'inset 0 0 0 1px rgba(0,0,0,0.5)',
            animation: live ? 'opus-chassis-seg 1.6s ease-in-out infinite' : undefined,
          }} />
        )
      })}
    </div>
  )
}

// ── Lamp block — the mock's 5-cell LED rack ──────────────────────────────────
// RUN IO NET PRV PWR, drawn as the mock's `led5` rack: five hard-edged cells in
// the signal ink, dim cells in the dead olive, and ONE legend under them instead
// of five. Cells are discrete — a lamp is on or off, never dimmed to taste.
//
// EVERY CELL NAMES ITS OWN SIGNAL (`mode`), and the component only looks the
// answer up. That is the whole shape of the honesty fix: there is no `'on'` mode
// any more — a lamp cannot be lit by its manifest entry, only by a reading. The
// five signals, and why `GPU` is not among them, are documented on
// `OpusLampMode` in opusChrome.helpers.ts.
const LAMPS: readonly { name: string; mode: OpusLampMode }[] = [
  { name: 'RUN', mode: 'run' },
  { name: 'IO',  mode: 'io'  },
  { name: 'NET', mode: 'net' },
  { name: 'PRV', mode: 'prv' },
  { name: 'PWR', mode: 'pwr' },
]

/** The dim cell — the mock's `.led5-dim`, an unlit LED still visible in its
 *  housing rather than an empty hole. */
const LED_DIM = '#22300a'

function LampBlock({ rail, lamps }: { rail: number; lamps: OpusLampReadings }) {
  const { w, h } = opusLedPx(rail)
  return (
    <div style={{
      ...LAYER, position: 'relative', flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3,
    }}>
      <div style={{
        ...LAYER, position: 'relative', display: 'flex', gap: 4,
      }}>
        {LAMPS.map(lamp => {
          const lit = lamps[lamp.mode]
          return (
            <div key={lamp.name} style={{
              ...LAYER, position: 'relative', width: w, height: h,
              backgroundColor: lit ? 'var(--opus-signal, #b8f227)' : LED_DIM,
              // The RUN cell is the one that BLINKS, and only while it is lit.
              animation: lamp.name === 'RUN' && lit
                ? 'opus-chassis-led 1.05s steps(1, end) infinite'
                : undefined,
            }} />
          )
        })}
      </div>
      {/* The legend truncates to the rack alone on a rail too thin to print on
          — the lamps carry the state, the words only name it. */}
      {opusLegendVisible(rail) && (
        <div style={{ ...LAYER, ...LEGEND, position: 'relative', fontWeight: 800 }}>
          {LAMPS.map(l => l.name).join(' ')}
        </div>
      )}
    </div>
  )
}

// ── Drag bands ───────────────────────────────────────────────────────────────
// The window's handle. This theme hides the TitleBar's own bar (GROUP Q in the
// structure sheet), so without these the frame is a picture of a machine that
// cannot be picked up — live-found the moment the chassis covered the margin.
//
// THE OUTER STRIP IS LEFT ALONE. Windows keeps its native resize border on the
// frameless window (`thickFrame: true`), and a drag region painted right up to
// the window edge is the classic way to ship a window that moves but never
// resizes. `opusDragBandPx` takes OPUS_DRAG_EDGE_PX off the outer edge of every
// band; a bezel too thin to give both gets a band of zero and is skipped, so the
// resize strip always wins the tie.
//
// WHAT THE THIN RIM COSTS THE GRAB (2026-07-27). The flanks are 16px now, so
// their bands are 16 − 6 = 10px each, and 12 − 6 = 6px at flush; the top rail
// still gives 24px (30 − 6) and IT is the primary handle, exactly as a title bar
// would be — the header row on it is a drag surface in its own right. Nothing
// about the mechanism moved: the bands are still siblings of the rails, still
// start OPUS_DRAG_EDGE_PX in, and still lose the tie to the resize strip.
//
// The BOTTOM rail is deliberately not a band: it is the edge a person reaches
// for to make the window taller, and it carries no title. Its thickness still
// bounds the two FLANK bands — they end where the hint rail begins, which is 6px
// lower than before; the bands themselves are otherwise byte-identical (same
// three, same OPUS_DRAG_EDGE_PX inset, same tie lost to the resize strip).
function DragBands({ bezel }: { bezel: OpusBezel }) {
  const e = OPUS_DRAG_EDGE_PX
  const bandY = opusDragBandPx(bezel.y)
  const bandX = opusDragBandPx(bezel.x)
  return (
    <>
      {bandY > 0 && (
        <div style={{ ...LAYER, ...DRAG, top: e, left: e, right: e, height: bandY }} />
      )}
      {bandX > 0 && (
        <div style={{ ...LAYER, ...DRAG, top: bezel.y, bottom: bezel.bottom, left: e, width: bandX }} />
      )}
      {bandX > 0 && (
        <div style={{ ...LAYER, ...DRAG, top: bezel.y, bottom: bezel.bottom, right: e, width: bandX }} />
      )}
    </>
  )
}

// ── Compartment stencil ──────────────────────────────────────────────────────
// A bay number on the flank, vertical because a flank is tall and narrow. `lit`
// bays get a signal tick beside the number, so the frame itself shows which bay
// the marking belongs to without any text growing.
function Bay({ cap, flank, at, id, label, lit }: {
  cap: ChassisCaptionMode; flank: number; at: string; id: string; label: string; lit?: boolean
}) {
  if (cap === 'bar') {
    return (
      <div style={{
        ...LAYER, top: at, left: Math.max(2, Math.round((flank - 3) / 2)),
        width: 3, height: 34,
        backgroundColor: lit ? 'rgba(184,242,39,0.6)' : 'rgba(120,132,118,0.35)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.5)',
      }} />
    )
  }
  return (
    <div style={{
      ...LAYER, top: at, left: Math.max(2, Math.round((flank - 10) / 2)),
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
    }}>
      {lit && (
        <div style={{
          ...LAYER, position: 'relative', width: 4, height: 4,
          backgroundColor: 'var(--opus-signal, #b8f227)',
          boxShadow: '0 0 4px 0 rgba(184,242,39,0.55)',
        }} />
      )}
      <div style={{
        ...LAYER, ...LEGEND, position: 'relative',
        writingMode: 'vertical-rl', letterSpacing: '0.26em',
        color: lit ? 'var(--accent-text)' : 'var(--text-dim)',
      }}>
        {cap === 'full' ? `${id} ${label}` : label}
      </div>
    </div>
  )
}

// ── The crab engraving ───────────────────────────────────────────────────────
// The claw PNGs used as a MASK: the art decides the shape, the fill is one flat
// low-contrast olive, so the result reads as milled INTO the plate rather than
// stuck onto it. Anchored to the plate's RIGHT-THIRD DEAD SPACE — inset from the
// plate edge (the whole point of the mock's caption: the window edge can never
// eat it, because it is not near the window edge) and vertically centred between
// the page header strip and the composer band rather than in the plate, so it
// cannot land on the conversation. See the long note in the body.
function Engraving({ inset, height, bezel, plateH, burr }: {
  inset: number; height: number; bezel: OpusBezel; plateH: number
  /** Draw the tool BURR instead of the groove: identical silhouette, signal ink,
   *  displaced up-and-left by OPUS_ENGRAVE_BURR_PX (mock 1c). */
  burr?: boolean
}) {
  // The two claws sit side by side, mirrored, forming the pincer pair; 282+285
  // over 826 tall is the source aspect.
  const width = Math.round(height * 0.69)
  const mask = `url(${clawLeft}), url(${clawRight})`
  // THE CENTRE SEAM. Two mask layers pinned to opposite edges at exactly 50%
  // each meet on the midline, and the art ramps its alpha to ~0 on the edge that
  // lands there (that ramp is baked into the PNGs by extract-claws.py for the
  // old claw chrome). Two fading edges abutting read as a hairline slit down the
  // middle of the engraving — live-found. Overlapping the halves by SEAM_PX
  // makes the two ramps sum instead of meet: layered mask images composite by
  // union, so the overlap band is the only place both contribute and the slit
  // closes. Kept in px, not %, so the overlap does not grow with the plate; a
  // few px is under the ink's own contrast threshold, so nothing reads doubled.
  const half = `calc(50% + ${ENGRAVE_SEAM_PX}px)`
  // WHERE IT SITS, and why. Two axes, two different rules:
  //
  //   RIGHT — hard against the bezel plus the inset, i.e. the right third of the
  //   stage. Live content is ragged there (bubbles wrap long before the right
  //   edge, the model/CTX chips sit left of it); the LEFT third is the reading
  //   column and the one place a mark would fight the text.
  //
  //   TOP — centred in the DEAD-SPACE BAND (opusEngraveTopPx), not in the plate.
  //   Centring in the plate is what put the silhouette over the GET MODELS row
  //   and the answer bubbles on a live chat — live-found. The band excludes the
  //   page header strip and the whole composer band, which is the mock's own
  //   caption applied to a stage that has content in it: the mock draws this on
  //   an IDLE stage, so "the middle" and "the dead space" happen to coincide
  //   there and do not coincide here.
  //
  // THE ANCHOR IS THE PLATE, NEVER THE VIEWPORT. Both coordinates start at the
  // bezel — the frame's own thickness — and add a clear inset on top, so the
  // silhouette is positioned relative to the STAGE INTERIOR at every stage. That
  // is the whole of the mock's caption: "the window edge can never eat it".
  //
  // ...LAYER carries `pointerEvents: 'none'`, so nothing here can ever swallow a
  // click on the content it floats over — the one non-negotiable for a layer
  // that paints above the app.
  const nudge = burr ? OPUS_ENGRAVE_BURR_PX : 0
  return (
    <div style={{
      ...LAYER, ...NO_DRAG, position: 'fixed',
      right: bezel.x + inset + nudge,
      top: bezel.y + opusEngraveTopPx(plateH, height) - nudge,
      width, height,
      // The single layer in this file that paints above the plate (z 5).
      zIndex: 6,
      backgroundColor: burr ? ENGRAVE_BURR_INK : ENGRAVE_INK,
      maskImage: mask,
      maskSize: `${half} 100%, ${half} 100%`,
      maskPosition: 'left center, right center',
      maskRepeat: 'no-repeat, no-repeat',
      WebkitMaskImage: mask,
      WebkitMaskSize: `${half} 100%, ${half} 100%`,
      WebkitMaskPosition: 'left center, right center',
      WebkitMaskRepeat: 'no-repeat, no-repeat',
    }} />
  )
}

// ── In-frame window keys — REAL CONTROLS ─────────────────────────────────────
// Three keys milled into the top rail, wired to the same `window.tachi.window`
// IPC the TitleBar uses. Separate from TachikomaChrome's WindowKeys on purpose:
// the two frames mount them on different axes (rail vs flank) and dress them in
// different inks; only the three IPC calls are shared, and they are one line
// each. Close is engraved in --danger, the same signal the TitleBar's × uses.
function OpusKeys({ rail, inset, maximized }: {
  rail: number; inset: number; maximized: boolean
}) {
  const s = keySizePx(rail)
  const glyph = Math.max(6, Math.round(s * 0.44))
  const gap = Math.max(4, Math.round(s * 0.3))
  const pad = Math.max(2, Math.round(s * 0.16))
  // NO bail-out on a thin rail — these keys are the ONLY window controls once
  // the structure sheet hides the TitleBar row, so unmounting them stranded a
  // maximized window with ZERO controls (live-found; the old comment claimed
  // "the TitleBar's own controls are untouched", which stopped being true the
  // moment the !important hide landed). On the 10px flush rail the 12px caps
  // sit PROUD of the rail by ~a pixel a side — machined buttons standing off
  // the surface, same spirit as TK-05's edge-to-edge flank keys.
  // NOTE THE MISSING box-shadow: these are `<button>`s, so the theme's own
  // structure layer (tachi-opus5-structure.css GROUP B) matches them and sets
  // `box-shadow: none !important`. An inline shadow would be deleted, so the
  // moulding rides the gradient plus the RELIEF span inside each cap.
  const capStyle: React.CSSProperties = {
    width: s, height: s,
    backgroundColor: 'rgba(18,24,22,0.98)',
    backgroundImage: 'linear-gradient(160deg, rgba(44,54,50,0.95), rgba(14,18,17,0.99) 60%, rgba(7,9,9,1))',
    clipPath: `polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)`,
  }
  const relief: React.CSSProperties = {
    position: 'absolute', inset: 0, pointerEvents: 'none',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.9)',
  }
  const onMin = () => { void window.tachi?.window?.minimize?.().catch(() => {}) }
  const onMax = () => { void window.tachi?.window?.maximizeToggle?.().catch(() => {}) }
  const onClose = () => { void window.tachi?.window?.close?.().catch(() => {}) }
  return (
    <div style={{
      // NO_DRAG on the well AND on every cap (KEY_HIT): the top rail is a drag
      // band, and a drag region swallows the clicks of anything inside it that
      // does not opt out — the keys would look alive and do nothing.
      ...LAYER, ...NO_DRAG,
      position: 'fixed', right: inset, top: Math.max(2, Math.round((rail - s - pad * 2) / 2)),
      display: 'flex', alignItems: 'center', gap, padding: pad,
      backgroundColor: 'rgba(4,6,5,0.85)',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.9), inset 0 2px 5px rgba(0,0,0,0.7)',
    }}>
      <button className="opus-chassis-key" data-chassis-key="" onClick={onMin} title="Minimize" aria-label="Minimize"
        style={{ ...KEY_HIT, ...capStyle }}>
        <span style={relief} />
        <span style={{ position: 'absolute', width: glyph, height: 2, backgroundColor: 'var(--text-primary)' }} />
      </button>
      <button className="opus-chassis-key" data-chassis-key="" onClick={onMax}
        title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'}
        style={{ ...KEY_HIT, ...capStyle }}>
        <span style={relief} />
        <span style={{
          position: 'absolute', width: glyph, height: glyph,
          boxShadow: 'inset 0 0 0 2px var(--text-primary)',
          transform: maximized ? 'translate(1px,1px)' : undefined,
        }} />
        {maximized && (
          <span style={{
            position: 'absolute', width: glyph - 2, height: glyph - 2,
            boxShadow: 'inset 0 0 0 2px var(--text-dim)',
            transform: 'translate(-3px,-3px)',
          }} />
        )}
      </button>
      <button className="opus-chassis-key" data-chassis-key="" onClick={onClose} title="Close" aria-label="Close"
        style={{ ...KEY_HIT, ...capStyle }}>
        <span style={relief} />
        <span style={{ position: 'absolute', width: glyph, height: 2, backgroundColor: 'var(--danger)', transform: 'rotate(45deg)' }} />
        <span style={{ position: 'absolute', width: glyph, height: 2, backgroundColor: 'var(--danger)', transform: 'rotate(-45deg)' }} />
      </button>
    </div>
  )
}
