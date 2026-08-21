// apps/desktop/src/components/activity/activityCancel.ts
//
// THE STOP BUTTON'S ONE DISPATCHER.
//
// The rail's whole reason to exist is the incident behind media.store's `run`
// slice: a Wan render was started on the Media tab, the owner switched tabs, and
// there was no indicator and no way to stop it. A rail that SHOWS the run but
// cannot stop it from where it is shown would only make the loss legible, so
// every row that advertises `cancel` must reach a real kill from the rail
// itself — not from the page that started the work.
//
// This module is that reach, and it is deliberately its own file rather than a
// closure inside ActivityStrip:
//
//   • the strip cannot be rendered in this repo's test environment (vitest runs
//     `environment: 'node'` and there is no testing-library), so a Stop that
//     lived in the component would be untestable — the exact class of wiring
//     that shipped broken before (`cancelGeneration` was dead code with no
//     caller, audit finding #1);
//   • `ActivityCancel` is a DATA descriptor, so the mapping descriptor → IPC is
//     a pure decision table. It belongs somewhere a test can call it.
//
// NO CONFIRM DIALOG, EVER. `window.confirm` freezes the renderer in this app
// (house gotcha) and a Stop that asks "are you sure" while a GPU burns is the
// wrong answer anyway. The click IS the decision; the button latches so it
// cannot be pressed twice, and the real state change arrives when the producer
// reports it.

import { useMediaStore } from '../../store/media.store'
import { cancelAudioOverviewRun } from '../../pages/media/audioOverviewRun'
import type { ActivityCancel } from '../../store/activity.store'

/** Just the slice of `window.tachi` a cancel needs, so a test can hand a fake. */
export interface ActivityCancelSources {
  sdCpp?: { cancelGeneration(): Promise<unknown> }
  modelStorage?: { abort(engine?: string): Promise<unknown> }
  rife?: { cancel(path: string): Promise<unknown> }
}

export interface ActivityCancelOutcome {
  /** The IPC call was made and did not throw. */
  ok: boolean
  /** Which descriptor was acted on — a test's proof the right wire was picked. */
  kind: ActivityCancel['kind']
  /** Why nothing happened (no bridge, or the call threw). Never invented copy. */
  error?: string
}

function bridge(api?: ActivityCancelSources): ActivityCancelSources {
  if (api) return api
  try {
    return (globalThis as { tachi?: ActivityCancelSources }).tachi ?? {}
  } catch {
    return {}
  }
}

/**
 * Issue the cancel a row claims to have. Returns an outcome instead of throwing:
 * a Stop that fails must not take the rail down with it, and the row's real
 * state still arrives on the producer's own terminal event.
 *
 * The LATCH is applied before the await (`markRunStopping`), so the button is
 * already un-clickable while the kill is in flight. Nothing here sets a row to
 * "stopped" on its own authority — that would be the renderer inventing a state
 * the producer has not reported (honesty clause 1).
 */
export async function runActivityCancel(
  cancel: ActivityCancel,
  api?: ActivityCancelSources,
): Promise<ActivityCancelOutcome> {
  const src = bridge(api)

  if (cancel.kind === 'sd-generate') {
    // Latch first: the composer's own Stop button and this one read the same
    // `run.stopping` flag, so pressing either disables both instantly.
    useMediaStore.getState().markRunStopping()
    if (!src.sdCpp?.cancelGeneration) {
      return { ok: false, kind: cancel.kind, error: 'sdCpp.cancelGeneration unavailable' }
    }
    try {
      await src.sdCpp.cancelGeneration()
      return { ok: true, kind: cancel.kind }
    } catch (e) {
      return { ok: false, kind: cancel.kind, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (cancel.kind === 'rife') {
    // A frame-interpolation run holds the GPU for minutes on a long clip, and
    // the gallery card that started it scrolls away. The kill is keyed on the
    // SOURCE PATH — the same job identity the progress events carry.
    if (!src.rife?.cancel) {
      return { ok: false, kind: cancel.kind, error: 'rife.cancel unavailable' }
    }
    try {
      await src.rife.cancel(cancel.jobId)
      return { ok: true, kind: cancel.kind }
    } catch (e) {
      return { ok: false, kind: cancel.kind, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (cancel.kind === 'audio-overview') {
    // THE ONE CANCEL THAT NEEDS NO BRIDGE. The audio overview runs in this
    // renderer (quick-ask → TTS → WebAudio stitch), so there is no child to
    // kill and no IPC to reach — the stop is a latch the pipeline reads at its
    // next checkpoint. It still goes through this dispatcher rather than a
    // closure on the row, so the rail's Stop has exactly one implementation and
    // this arm is as assertable as the three that do call out.
    cancelAudioOverviewRun()
    return { ok: true, kind: cancel.kind }
  }

  // cancel.kind === 'migrate' — model-storage exposes abort(engine), and until
  // this rail existed the only button for it lived on a Settings section the
  // user had already navigated away from (audit finding #17).
  if (!src.modelStorage?.abort) {
    return { ok: false, kind: cancel.kind, error: 'modelStorage.abort unavailable' }
  }
  try {
    await src.modelStorage.abort(cancel.engine)
    return { ok: true, kind: cancel.kind }
  } catch (e) {
    return { ok: false, kind: cancel.kind, error: e instanceof Error ? e.message : String(e) }
  }
}
