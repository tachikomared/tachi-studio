// apps/desktop/src/store/audioOverview.store.ts
//
// THE AUDIO OVERVIEW RUN, LIFTED OUT OF THE COMPONENT THAT KEPT KILLING IT.
//
// media.store's `run` slice was written after a Wan render LOST its progress on
// a tab switch. The ~96-second podcast render was the worse case in the same
// family and the only one in the app that was actively MURDERED by navigation:
// AudioOverviewPanel's unmount effect set `cancelledRef.current = true`, four
// checkpoints in the pipeline read that ref, and the result — a blob URL — was
// revoked by the same effect. Switching sub-tabs threw away a minute of local
// LLM + TTS work and left nothing on disk.
//
// So the run lives here instead, module-scoped, exactly as the media run does:
// the pipeline (pages/media/audioOverviewRun.ts) writes into this slice and the
// panel is a VIEW over it. A remount reads the live stage, the live count, the
// Stop latch and the finished result straight out of the store.
//
// NOT PERSISTED, for the same reason media.store's `run` is not: a render dies
// with the app, so a restored "synthesizing 4/9" would offer to watch a pipeline
// that no longer exists — and a restored blob URL would point at nothing at all.
//
// ── THE runId IS THE WHOLE CONCURRENCY STORY ─────────────────────────────────
// Every write carries the id of the run it belongs to, and a write for anything
// other than the CURRENT run is dropped. A stopped run's in-flight TTS promise
// can still resolve a second later; without this it would happily paint its
// result over the run that replaced it.

import { create } from 'zustand'
import type { OverviewLength, PodcastScript } from '../pages/media/audioOverviewHelpers'

/** Where the pipeline is. 'saving' is the auto-save leg (media:save-wav). */
export type AudioOverviewStage =
  | 'idle' | 'scripting' | 'synthesizing' | 'stitching' | 'saving' | 'ready' | 'error'

/** Which leg failed. The panel reuses a parsed script when it is not 'script'. */
export type AudioOverviewErrorStage = 'script' | 'synth' | 'stitch'

/** Everything the pipeline needs — kept so Retry works from a REMOUNTED panel,
 *  whose textarea no longer holds the notes the run was started from. */
export interface AudioOverviewInput {
  source: string
  title: string
  length: OverviewLength
  /** Engine-packed voice ids ("kokoro:af_heart" / "piper:<id>"). */
  voiceA: string
  voiceB: string
}

export interface AudioOverviewResult {
  /**
   * The WAV on disk (media:save-wav). Null when the save could not run or
   * failed — never a guessed path, so the panel can only offer a file that is
   * really there.
   */
  path: string | null
  /** Session blob URL for instant playback. Revoked only when REPLACED. */
  url: string | null
  durationSec: number
  turns: number
  title: string
  /** The save's own failure, when the audio exists but the file does not. */
  saveError: string | null
}

export interface AudioOverviewRunState {
  /** Bumped by every start; every write is checked against it. */
  runId: number
  stage: AudioOverviewStage
  /** Turn n of m, as the panel's status line reads it. */
  progress: { n: number; m: number }
  script: PodcastScript | null
  error: { stage: AudioOverviewErrorStage; message: string } | null
  result: AudioOverviewResult | null
  input: AudioOverviewInput | null
  /** Stop was pressed; the pipeline aborts at its next checkpoint. */
  stopping: boolean
  startedAt: number | null
}

const IDLE: Omit<AudioOverviewRunState, 'runId'> = {
  stage: 'idle',
  progress: { n: 0, m: 0 },
  script: null,
  error: null,
  result: null,
  input: null,
  stopping: false,
  startedAt: null,
}

/** The one "is work happening" predicate — pure, so both the panel and the
 *  media tab shell can ask without subscribing to the whole slice. */
export function isAudioOverviewBusy(s: Pick<AudioOverviewRunState, 'stage'> | null | undefined): boolean {
  const stage = s?.stage
  return stage === 'scripting' || stage === 'synthesizing' || stage === 'stitching' || stage === 'saving'
}

interface AudioOverviewStore extends AudioOverviewRunState {
  /** Start a run. Returns the new runId — every later write must carry it. */
  beginRun(input: AudioOverviewInput, opts?: { script?: PodcastScript | null; now?: number }): number
  setStage(runId: number, stage: AudioOverviewStage): void
  setProgress(runId: number, n: number, m: number): void
  setScript(runId: number, script: PodcastScript): void
  /** Stop was pressed. Latches so the button cannot be pressed twice. */
  requestStop(): void
  /** The run ended because the user stopped it: back to idle, no result. */
  abortRun(runId: number): void
  failRun(runId: number, stage: AudioOverviewErrorStage, message: string): void
  finishRun(runId: number, result: AudioOverviewResult): void
  /** A later save attempt landed (the panel's manual retry after a failed
   *  auto-save). Only the file half of the result may change this way. */
  patchResultSave(runId: number, patch: { path?: string | null; saveError?: string | null }): void
  /** Dismiss the inline failure row (the panel's ✕). */
  clearError(): void
  /** Tests only. */
  resetRun(): void
}

export const useAudioOverviewStore = create<AudioOverviewStore>((set, get) => ({
  runId: 0,
  ...IDLE,

  beginRun(input, opts) {
    const runId = get().runId + 1
    set({
      runId,
      ...IDLE,
      // A retry from the synth stage keeps the script that already parsed —
      // re-drafting it would spend the LLM leg again for nothing — and it must
      // not claim to be drafting one either, however briefly.
      stage: opts?.script ? 'synthesizing' : 'scripting',
      script: opts?.script ?? null,
      input,
      startedAt: opts?.now ?? Date.now(),
    })
    return runId
  },

  setStage(runId, stage) {
    set(s => (s.runId === runId ? { stage } : s))
  },

  setProgress(runId, n, m) {
    set(s => (s.runId === runId ? { progress: { n, m } } : s))
  },

  setScript(runId, script) {
    set(s => (s.runId === runId ? { script } : s))
  },

  requestStop() {
    set(s => (isAudioOverviewBusy(s) ? { stopping: true } : s))
  },

  abortRun(runId) {
    // No error and no result: a stop is not a failure, and the panel must not
    // paint the user's own decision in danger red (media.store learned this the
    // hard way — see MediaRunState.stoppedByUser).
    set(s => (s.runId === runId ? { stage: 'idle', stopping: false, progress: { n: 0, m: 0 } } : s))
  },

  failRun(runId, stage, message) {
    set(s => (s.runId === runId ? { stage: 'error', stopping: false, error: { stage, message } } : s))
  },

  finishRun(runId, result) {
    set(s => (s.runId === runId ? { stage: 'ready', stopping: false, error: null, result } : s))
  },

  patchResultSave(runId, patch) {
    set(s => (s.runId === runId && s.result
      ? {
        result: {
          ...s.result,
          path: patch.path === undefined ? s.result.path : patch.path,
          saveError: patch.saveError === undefined ? s.result.saveError : patch.saveError,
        },
      }
      : s))
  },

  clearError() {
    set(s => (s.stage === 'error' ? { stage: 'idle', error: null } : { error: null }))
  },

  resetRun() {
    set({ runId: 0, ...IDLE })
  },
}))
