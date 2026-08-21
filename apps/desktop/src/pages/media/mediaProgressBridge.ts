// apps/desktop/src/pages/media/mediaProgressBridge.ts
//
// THE PROGRESS SUBSCRIPTION HAS TO OUTLIVE THE PAGE.
//
// MediaPage subscribed to 'sd-cpp:gen-progress' inside a useEffect and dropped
// the subscription on unmount. Switch tabs mid-render and every tick after that
// went nowhere; come back and the composer showed an idle GENERATE button while
// sd-cli was still holding the GPU. The events were never the problem — main
// keeps sending them to the window the whole time — the LISTENER was tied to a
// component's lifetime.
//
// So the listener lives here instead: installed once, never removed, writing
// into the media store's `run` slice. A remount reads the live line out of the
// store immediately, and the next tick (≤1 s — the engine heartbeats) lands
// whether the page is mounted or not. Nothing polls.

import { useMediaStore } from '../../store/media.store'
import { notifySettle } from '../../components/activity/activityNotify'

/** Which part of the run the numbers describe (electron/services/util/sd-progress-parser). */
export type SdProgressPhase = 'starting' | 'loading' | 'sampling' | 'decoding'

/** The shape of one engine progress event (electron.d.ts sdCpp.onGenProgress). */
export interface SdGenProgress {
  step:      number | null
  total:     number | null
  percent:   number
  message:   string
  heartbeat: boolean
  /** Optional so a payload from an older main build still formats. */
  phase?:    SdProgressPhase
  /**
   * THE RUN'S LAST WORD — absent on every mid-run tick, present exactly once
   * per run (main sends it from both the success and the failure path).
   * Optional so a payload from an older main build is simply never terminal.
   */
  stage?:     'done' | 'error'
  /** Which generator ended. Terminal events only. */
  kind?:      'image' | 'video'
  /** How long the run took, measured in main. Terminal events only. */
  elapsedMs?: number
  /**
   * A decoded look at the latents as a `data:` URI. Present only on the ticks
   * where the engine had written a new frame — most events carry none, so the
   * store keeps the last one rather than clearing between them.
   */
  preview?:   string
}

/** Is this the event that ends the run? */
export function isTerminalGenEvent(p: SdGenProgress): boolean {
  return p?.stage === 'done' || p?.stage === 'error'
}

/**
 * The two phases whose progress is real but is NOT progress OF THE RENDER.
 * Localized; see MediaPage, which re-registers them whenever the locale changes.
 */
export interface SdPhaseLabels {
  loading(percent: number): string
  decoding(): string
}

/** English, and the shipped default until MediaPage registers the localized set.
 *  Lower-case to match the rest of media.json's `progress` block ("starting…",
 *  "rendering locally…") — these land in the same slots. */
export const FALLBACK_PHASE_LABELS: SdPhaseLabels = {
  loading: (percent) => `loading model… ${percent}%`,
  decoding: () => 'decoding…',
}

let phaseLabels: SdPhaseLabels = FALLBACK_PHASE_LABELS

/**
 * Hand over the localized phase phrases.
 *
 * A SETTER rather than an argument to `installMediaProgressBridge`, because the
 * bridge installs exactly once for the life of the app and the language does
 * not: a `t` captured at first mount would keep printing the boot locale for
 * the rest of the session.
 */
export function setSdPhaseLabels(labels: SdPhaseLabels): void {
  phaseLabels = labels
}

/**
 * The one line the Generate button and the activity strip show.
 *
 * ── WHY THE PHASE CHANGES THE SHAPE OF THE STRING ───────────────────────────
 *
 * This used to return `${step}/${total}` for whatever numbers arrived, and the
 * numbers that arrived were the WEIGHT LOADER's (see sd-progress-parser's
 * header for the driver trace: `100% · 1303/1303` held for eight minutes while
 * the render ran). Fixing the parser is only half of it — a loading fraction is
 * a true number about the loader and a false one about the render, so it must
 * not travel in the shape that means "measurement of this run".
 *
 * ActivityStrip already draws exactly that distinction and says so in its own
 * comment: a stage that parses back to a number goes on the BAR, and "prose the
 * engine writes itself parses to -1 and is the only thing this slot exists to
 * carry". So:
 *
 *   loading   → PROSE  ("Loading model… 32%")  → indeterminate bar + the phrase
 *   sampling  → N/M    ("4/20")                → a real bar, on real steps
 *   decoding  → PROSE  ("Decoding…")           → indeterminate bar + the phrase
 *
 * Sampling is deliberately NOT prefixed with its own name: the bare fraction is
 * the exact token `parseRunProgress` is built to read back, and it is the only
 * phase that leaves one — an unlabelled fraction can only be steps now that the
 * other two say their names out loud.
 */
export function formatSdProgress(p: SdGenProgress, labels: SdPhaseLabels = phaseLabels): string {
  if (p.phase === 'loading' && p.percent >= 0) return labels.loading(p.percent)
  if (p.phase === 'decoding') return labels.decoding()
  if (p.step != null && p.total != null) return `${p.step}/${p.total}`
  if (p.percent >= 0) return `${p.percent}%`
  return p.message || '…'
}

/** Just the slice of `window.tachi` this needs, so a test can hand over a fake. */
interface ProgressSources {
  sdCpp?: { onGenProgress(cb: (p: SdGenProgress) => void): () => void }
  imgnaiMedia?: { onGenProgress?(cb: (p: { status: string; elapsedSec: number }) => void): () => void }
  pollinationsMedia?: { onGenProgress?(cb: (p: { status: string; elapsedSec: number }) => void): () => void }
}

let installed = false

// DEDUPE, KEYED ON THE RUN ITSELF rather than on a boolean.
//
// The run slice replaces its state object on `beginRun`, so the object identity
// IS a run id — the one the wire does not carry. A second terminal for the run
// we already reported finds the same object and stays quiet; the next run gets a
// different one and reports normally. A plain "already handled" flag would have
// swallowed the report of a run that failed before its first tick, which is
// exactly the run most worth hearing about.
let lastReportedRun: unknown = null

/**
 * THE COMPLETION REPORT (audit finding: `notification:show` had zero callers).
 *
 * The channel's terminal event is where a local render finally says it is over,
 * and it is the only place in the renderer that knows a 27-minute Wan run just
 * landed while the user was in another app.
 *
 * What it deliberately does NOT do is settle the run slice. MediaPage awaits the
 * IPC promise and calls endRun/failRun from there — that is the one owner, and
 * a second settle here would race it (and would overwrite the failure message
 * the composer shows inline). This handler only reports; the state stays where
 * it was.
 */
function handleTerminalGenEvent(p: SdGenProgress): void {
  const run = useMediaStore.getState().run
  if (run === lastReportedRun) return   // a second terminal for the same run
  // Nothing was in flight in THIS window ⇒ no row was ever shown ⇒ nothing to
  // announce (the rail's own admission rule). A canvas/headless run that never
  // opened the composer's row is reported by its own surface, not by this one.
  if (!run.busy) return
  lastReportedRun = run

  const failed = p.stage === 'error'
  // A run the user stopped is not a failure to announce — they pressed the
  // button. The store is the only place that knows the difference; the engine
  // reports a killed child exactly like any other death.
  const status = failed ? (run.stoppedByUser ? 'cancelled' : 'failed') : 'completed'

  notifySettle({
    kind: p.kind === 'video' ? 'video' : 'image',
    status,
    detail: failed ? p.message : undefined,
    elapsedMs: p.elapsedMs,
  })
}

/**
 * Wire the engine's progress events into the store. Idempotent: calling it from
 * every MediaPage mount installs exactly one listener for the life of the app.
 * Returns true when this call is the one that installed it.
 *
 * The returned unsubscribers are DELIBERATELY dropped — that is the whole point
 * of this module. There is one window and one media store; a listener that
 * writes a progress string into it costs nothing when nothing is rendering.
 */
export function installMediaProgressBridge(api?: ProgressSources): boolean {
  if (installed) return false
  const src = api ?? (globalThis as { tachi?: ProgressSources }).tachi
  if (!src?.sdCpp?.onGenProgress) return false   // preload not ready — try again next mount
  installed = true

  src.sdCpp.onGenProgress(p => {
    // A terminal is not progress: writing it as a line would leave the engine's
    // last log entry (or its death message) sitting in the composer's progress
    // slot for as long as it takes the promise to settle.
    if (isTerminalGenEvent(p)) { handleTerminalGenEvent(p); return }
    // Before the line, and unconditionally: a frame is news whatever the
    // numbers beside it say, and on the cold-load path it is the ONLY news for
    // minutes at a time.
    if (p.preview) useMediaStore.getState().setRunPreview(p.preview)
    useMediaStore.getState().setRunProgress(formatSdProgress(p))
  })

  // imgnAI polls server-side in MAIN and ticks here. Optional-chained so a stale
  // preload (pre-imgnAI build) is a silent no-op, exactly as it was in the page.
  src.imgnaiMedia?.onGenProgress?.(p => {
    useMediaStore.getState().setRunProgress(`${p.status} · ${p.elapsedSec}s`)
  })

  // Pollinations ticks the same honest shape: a state word ('queued' while its
  // 1-per-15s pacing slot waits, 'generating' while the single long GET runs)
  // plus elapsed seconds — there is no step signal to draw a bar from, so none
  // is drawn. Optional-chained for a pre-pollinations preload.
  src.pollinationsMedia?.onGenProgress?.(p => {
    useMediaStore.getState().setRunProgress(`${p.status} · ${p.elapsedSec}s`)
  })
  return true
}

/** Tests only — the module-level latch is per-process, and specs need a fresh one. */
export function resetMediaProgressBridge(): void {
  installed = false
  lastReportedRun = null
  phaseLabels = FALLBACK_PHASE_LABELS
}
