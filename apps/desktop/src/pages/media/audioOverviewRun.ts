// apps/desktop/src/pages/media/audioOverviewRun.ts
//
// THE PODCAST PIPELINE, TAKEN OFF THE COMPONENT'S LIFETIME.
//
// This is the runner half of the fix audioOverview.store's header describes: the
// ~96-second audio overview used to live inside AudioOverviewPanel, which killed
// it on unmount (`cancelledRef`, four checkpoints) and revoked its only artifact.
// The legs are unchanged — quick-ask drafts a strict-JSON script, the picked TTS
// engine voices each turn, the renderer stitches one PCM16 WAV — but they now run
// in a module that no React tree owns:
//
//   • the state goes to audioOverview.store (a remount re-attaches to it);
//   • the run is an ACTIVITY RAIL ROW, so it is visible and stoppable from any
//     tab, with the same descriptor-not-closure cancel contract every other row
//     uses (activity.store's `ActivityCancel`);
//   • the finished WAV is written to disk through the media:save-wav IPC that
//     already existed, so the result outlives the session instead of being a
//     blob URL;
//   • the settle goes through activityNotify, so a render that lands while the
//     user is in another app says so once.
//
// ── WHY EVERY EXTERNAL CALL IS A DEP ────────────────────────────────────────
// vitest runs `environment: 'node'`: there is no window.tachi, no OfflineAudio-
// Context and no URL.createObjectURL. Injecting them is what makes the whole
// state machine (stop, stale-write, save failure, settle) executable in a test
// instead of only clickable — the same reason activityCancel takes its sources.
//
// ── AND WHY THE COPY IS A REGISTRATION ──────────────────────────────────────
// The rail row prints the PRODUCER's own phrase, and this producer's phrases are
// UI copy in eight languages. A `t` captured here would freeze at the boot
// locale, so the panel hands the localized set over on every `t` change — the
// same setter contract mediaProgressBridge (setSdPhaseLabels) and activityNotify
// (setActivityNotifyCopy) already use.

import {
  buildScriptPrompt,
  parsePodcastScript,
  concatWithGaps,
  encodeWavPcm16,
  base64ToBytes,
  bytesToBase64,
  isTransientScriptError,
  isRawScriptFailurePayload,
  unpackVoice,
  TURN_GAP_MS,
  type PodcastScript,
  type TtsEngine,
} from './audioOverviewHelpers'
import {
  useAudioOverviewStore,
  isAudioOverviewBusy,
  type AudioOverviewInput,
} from '../../store/audioOverview.store'
import { useActivityStore } from '../../store/activity.store'
import { notifySettle, type SettleNotice, type NotifyOutcome } from '../../components/activity/activityNotify'

/** The rail row's identity. One overview at a time — the runner refuses a second. */
export const AUDIO_OVERVIEW_TASK_ID = 'audio:overview'

/** The stitch target rate; every turn is resampled to it while decoding. */
export const AUDIO_OVERVIEW_SAMPLE_RATE = 44_100

// ── copy ─────────────────────────────────────────────────────────────────────

/**
 * Every phrase this module can emit. Functions rather than a string table so the
 * interpolated ones go through i18next's own formatting.
 *
 * `stage*` lines land on the RAIL (common.json audioOverview.stage.*); the
 * `err*` lines are the panel's existing media.json copy, handed over so a
 * failure reads the same whether the panel is mounted or not.
 */
export interface AudioOverviewCopy {
  stageScript(): string
  stageVoices(n: number, m: number): string
  stageMix(): string
  stageSaving(): string
  errNoAudio(): string
  errLlmDown(): string
  errEmptyReply(): string
  errParseFailed(reason: string): string
  errScriptFailed(reason: string): string
  /** A script draft failed with a RAW wire payload (router JSON, a provider
   *  chain) rather than a sentence — see isRawScriptFailurePayload. Stands in
   *  for errScriptFailed(reason) so the screen never prints the payload. */
  errScriptUnreachable(): string
  errSynthFailed(n: number, m: number, reason: string): string
  errStitchFailed(reason: string): string
}

/** English, and the shipped default until the panel registers the localized set. */
export const FALLBACK_AUDIO_OVERVIEW_COPY: AudioOverviewCopy = {
  stageScript:    () => 'drafting script…',
  stageVoices:    (n, m) => `voices ${n}/${m}`,
  stageMix:       () => 'mixing…',
  stageSaving:    () => 'saving…',
  errNoAudio:     () => 'The voice engine returned no audio.',
  errLlmDown:     () => 'The local model router is not running.',
  errEmptyReply:  () => 'Empty reply.',
  errParseFailed: (reason) => `Could not read the script: ${reason}`,
  errScriptFailed: (reason) => `Script failed: ${reason}`,
  errScriptUnreachable: () => 'The local script model is not reachable right now — check Settings → Providers.',
  errSynthFailed: (n, m, reason) => `Voice ${n}/${m} failed: ${reason}`,
  errStitchFailed: (reason) => `Stitching failed: ${reason}`,
}

let copy: AudioOverviewCopy = FALLBACK_AUDIO_OVERVIEW_COPY

/**
 * The stitched WAV of the CURRENT run, kept so a save that failed (a full disk,
 * a folder the app lost write access to) can be retried without spending the
 * LLM and TTS legs again. Dropped the moment a new run begins — this is a retry
 * buffer, not a history.
 */
let lastWav: { runId: number; bytes: Uint8Array } | null = null

/** Hand over the localized phrases (the panel, on every `t` change). */
export function setAudioOverviewCopy(next: AudioOverviewCopy): void {
  copy = next
}

// ── deps ─────────────────────────────────────────────────────────────────────

export interface AudioOverviewRunDeps {
  /** One-shot local completion (window.tachi.quickask.ask). */
  ask(prompt: string): Promise<{ ok: boolean; text?: string; error?: string }>
  /** One turn through the engine the picked voice belongs to. */
  synthesize(engine: TtsEngine, voiceId: string, text: string): Promise<{ ok: boolean; b64?: string; error?: string }>
  /** Decode every turn's WAV to mono Float32 at `sampleRate` (WebAudio). */
  decode(b64s: readonly string[], sampleRate: number): Promise<Float32Array[]>
  /** media:save-wav. Null when the preload predates the surface. */
  saveWav: ((input: { b64: string; name: string }) => Promise<{ ok: boolean; path?: string; error?: string }>) | null
  makeUrl(bytes: Uint8Array): string | null
  revokeUrl(url: string): void
  now(): number
  notify(n: SettleNotice): NotifyOutcome
}

/** Why a start did nothing. The panel owns the copy for each — it has the
 *  toaster and the media.json strings; this module only names the cause. */
export type AudioOverviewStartRefusal = 'busy' | 'empty-source' | 'no-voices'

export interface AudioOverviewStartOutcome {
  started: boolean
  reason?: AudioOverviewStartRefusal
}

function tachi(): Record<string, unknown> {
  try {
    // `globalThis.tachi` in the renderer, `window.tachi` under a test host that
    // stubs one — and `{}` when neither is there, so every leg below degrades
    // to an honest "surface absent" instead of a TypeError.
    const g = globalThis as unknown as { tachi?: unknown; window?: { tachi?: unknown } }
    return ((g.tachi ?? g.window?.tachi) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The real wires. Read lazily (per run) rather than at module load: the preload
 * is not guaranteed to be there when this module is first imported, and the
 * kokoro surface may be absent entirely on an older build.
 */
function defaultDeps(): AudioOverviewRunDeps {
  const api = tachi() as {
    quickask?: { ask(p: string): Promise<{ ok: boolean; text?: string; error?: string }> }
    kokoro?: { synthesize(i: { text: string; voice: string }): Promise<{ ok: boolean; b64?: string; error?: string }> }
    piper?: { synthesize(i: { voiceId: string; text: string }): Promise<{ ok: boolean; b64?: string; error?: string }> }
    media?: { saveWav?(i: { b64: string; name: string }): Promise<{ ok: boolean; path?: string; error?: string }> }
  }
  return {
    ask: (prompt) => api.quickask!.ask(prompt),
    synthesize: async (engine, voiceId, text) => {
      if (engine === 'kokoro') {
        const r = await api.kokoro?.synthesize({ text, voice: voiceId })
        return r ?? { ok: false, error: copy.errNoAudio() }
      }
      return api.piper!.synthesize({ voiceId, text })
    },
    decode: async (b64s, sampleRate) => {
      // OfflineAudioContext as a pure decode host — decodeAudioData resamples
      // every turn to the context rate, so the concat is rate-uniform.
      const ctx = new OfflineAudioContext(1, 1, sampleRate)
      const out: Float32Array[] = []
      for (const b64 of b64s) {
        const bytes = base64ToBytes(b64)
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer)
        // Copy channel 0 out — the AudioBuffer's storage may be reused.
        out.push(new Float32Array(buf.getChannelData(0)))
      }
      return out
    },
    saveWav: typeof api.media?.saveWav === 'function' ? (i) => api.media!.saveWav!(i) : null,
    makeUrl: (bytes) => {
      try {
        return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
      } catch {
        return null
      }
    },
    revokeUrl: (url) => { try { URL.revokeObjectURL(url) } catch { /* already gone */ } },
    now: () => Date.now(),
    notify: (n) => notifySettle(n),
  }
}

// ── the rail row ─────────────────────────────────────────────────────────────

function openRow(stage: string, percent: number, counts?: { done: number; total: number }): void {
  useActivityStore.getState().progressTask(AUDIO_OVERVIEW_TASK_ID, {
    kind: 'generate',
    label: '',
    labelKey: 'activity.label.audioOverview',
    surface: '/media',
    stage,
    percent,
    counts,
    // A REAL cancel: the pipeline is renderer-local, so the descriptor reaches
    // this module rather than an IPC (see activityCancel's audio-overview arm).
    cancel: { kind: 'audio-overview' },
  })
}

function settleRow(status: 'completed' | 'failed' | 'cancelled', stage: string, error?: string): void {
  useActivityStore.getState().settleTask(AUDIO_OVERVIEW_TASK_ID, { status, stage, error })
}

// ── the run ──────────────────────────────────────────────────────────────────

/** The filename the auto-save (and the manual Download) uses for a title. */
export function audioOverviewFileName(title: string): string {
  const safe = (title ?? '').replace(/[^\p{L}\p{N}\- _]/gu, '').trim().replace(/\s+/g, '-')
  return `${safe || 'audio-overview'}.wav`
}

/**
 * Has this run been overtaken or stopped? The two are one question: either way
 * every further write belongs to nobody.
 */
function stale(runId: number): boolean {
  const s = useAudioOverviewStore.getState()
  return s.runId !== runId || s.stopping
}

/**
 * The final line the panel and the rail print for a failed script draft.
 *
 * A producer's own words are trusted verbatim when they ARE words — 'piper
 * exited 3', an empty-reply notice, the router-not-running line. But
 * quick-ask's only way back from a router that is UP and failing is its raw
 * HTTP error text ("router 502: {...}") — the whole provider chain in one
 * line, on a build that just promised "drafted by the local keyless model".
 * That is a wire payload, not a sentence: it goes to the console instead,
 * which is where a raw payload belongs, and the screen gets an honest line.
 */
function scriptFailureMessage(reason: string): string {
  if (isRawScriptFailurePayload(reason)) {
    console.error('[audio-overview] script draft failed:', reason)
    return copy.errScriptUnreachable()
  }
  return copy.errScriptFailed(reason)
}

export interface AudioOverviewStartInput extends AudioOverviewInput {
  /** A script that already parsed — a retry from the synth/stitch stage. */
  script?: PodcastScript | null
}

/**
 * Start the pipeline. Resolves when the run has settled (or was refused), but
 * NOTHING has to await it: the store and the rail carry the whole state, which
 * is the point — the caller may be unmounted a second later.
 */
export async function startAudioOverviewRun(
  input: AudioOverviewStartInput,
  deps?: Partial<AudioOverviewRunDeps>,
): Promise<AudioOverviewStartOutcome> {
  const store = useAudioOverviewStore.getState()
  if (isAudioOverviewBusy(store)) return { started: false, reason: 'busy' }
  if (!input.script && input.source.trim().length === 0) return { started: false, reason: 'empty-source' }
  if (!input.voiceA || !input.voiceB) return { started: false, reason: 'no-voices' }

  const d: AudioOverviewRunDeps = { ...defaultDeps(), ...deps }

  // The ONE place a blob URL is revoked: it is being replaced. (The panel used
  // to revoke it on unmount, which is what made the result die with the page.)
  const previous = store.result?.url
  if (previous) d.revokeUrl(previous)

  lastWav = null
  const startedAt = d.now()
  const runId = useAudioOverviewStore.getState().beginRun(
    { source: input.source, title: input.title, length: input.length, voiceA: input.voiceA, voiceB: input.voiceB },
    { script: input.script ?? null, now: startedAt },
  )
  openRow(input.script ? copy.stageVoices(1, input.script.turns.length) : copy.stageScript(), -1)

  // THE ROW AND THE TOAST ARE SHARED; THE RUN IS NOT.
  //
  // The store's writes are all runId-guarded, but the rail row and the OS toast
  // are keyed on the OPERATION, not on the run — so a run that has been replaced
  // must not settle (or announce) a row that now belongs to its successor. The
  // busy guard above makes that ordering unreachable today; this keeps it
  // unreachable if it ever stops being.
  const owns = (): boolean => useAudioOverviewStore.getState().runId === runId

  const abort = (): AudioOverviewStartOutcome => {
    const mine = owns()
    useAudioOverviewStore.getState().abortRun(runId)
    if (!mine) return { started: true }
    // '' rather than the last phrase: the row now reads CANCELLED, and keeping
    // "voices 4/9" beside it would be a claim about work that is not happening.
    settleRow('cancelled', '')
    d.notify({ kind: 'audio-overview', status: 'cancelled', elapsedMs: Math.max(0, d.now() - startedAt) })
    return { started: true }
  }

  const fail = (
    stage: 'script' | 'synth' | 'stitch',
    message: string,
  ): AudioOverviewStartOutcome => {
    const mine = owns()
    useAudioOverviewStore.getState().failRun(runId, stage, message)
    if (!mine) return { started: true }
    settleRow('failed', message, message)
    d.notify({ kind: 'audio-overview', status: 'failed', detail: message, elapsedMs: Math.max(0, d.now() - startedAt) })
    return { started: true }
  }

  // ── stage 1: the script ────────────────────────────────────────────────────
  let script = input.script ?? null
  if (!script) {
    try {
      script = await draftScript(input, d)
    } catch (err) {
      if (stale(runId)) return abort()
      const reason = err instanceof Error ? err.message : String(err)
      // Self-heal the first hiccup: a 5xx / fetch-failed transport error gets
      // ONE silent retry before the error row (which already offers Retry).
      if (isTransientScriptError(reason)) {
        try {
          script = await draftScript(input, d)
        } catch (err2) {
          if (stale(runId)) return abort()
          return fail('script', scriptFailureMessage(err2 instanceof Error ? err2.message : String(err2)))
        }
      } else {
        return fail('script', scriptFailureMessage(reason))
      }
    }
    if (stale(runId)) return abort()
    useAudioOverviewStore.getState().setScript(runId, script)
  }

  // ── stage 2: voices ────────────────────────────────────────────────────────
  const m = script.turns.length
  const wavs: string[] = []
  useAudioOverviewStore.getState().setStage(runId, 'synthesizing')
  for (let i = 0; i < m; i++) {
    if (stale(runId)) return abort()
    useAudioOverviewStore.getState().setProgress(runId, i + 1, m)
    // The bar counts FINISHED turns: `i` are done, the (i+1)-th is being spoken.
    openRow(copy.stageVoices(i + 1, m), Math.round((i / m) * 100), { done: i, total: m })
    const turn = script.turns[i]
    const { engine, id } = unpackVoice(turn.host === 'A' ? input.voiceA : input.voiceB)
    let r: { ok: boolean; b64?: string; error?: string }
    try {
      r = await d.synthesize(engine, id, turn.text)
    } catch (err) {
      if (stale(runId)) return abort()
      return fail('synth', copy.errSynthFailed(i + 1, m, err instanceof Error ? err.message : String(err)))
    }
    if (stale(runId)) return abort()
    if (!r?.ok || !r.b64) return fail('synth', copy.errSynthFailed(i + 1, m, r?.error || copy.errNoAudio()))
    wavs.push(r.b64)
  }

  // ── stage 3: stitch ────────────────────────────────────────────────────────
  if (stale(runId)) return abort()
  useAudioOverviewStore.getState().setStage(runId, 'stitching')
  openRow(copy.stageMix(), -1, { done: m, total: m })
  let wavBytes: Uint8Array
  let durationSec: number
  try {
    const decoded = await d.decode(wavs, AUDIO_OVERVIEW_SAMPLE_RATE)
    const merged = concatWithGaps(decoded, AUDIO_OVERVIEW_SAMPLE_RATE, TURN_GAP_MS)
    wavBytes = encodeWavPcm16(merged, AUDIO_OVERVIEW_SAMPLE_RATE)
    durationSec = Math.round(merged.length / AUDIO_OVERVIEW_SAMPLE_RATE)
  } catch (err) {
    if (stale(runId)) return abort()
    return fail('stitch', copy.errStitchFailed(err instanceof Error ? err.message : String(err)))
  }
  if (stale(runId)) return abort()
  lastWav = { runId, bytes: wavBytes }

  // ── stage 4: the file ──────────────────────────────────────────────────────
  //
  // A SAVE FAILURE IS NOT A RUN FAILURE. The podcast exists — it is decoded,
  // stitched and playable — so throwing it away because the disk said no would
  // be the same data loss this whole lane exists to end. The run lands `ready`
  // with the reason named; the panel offers Download and the manual Save.
  useAudioOverviewStore.getState().setStage(runId, 'saving')
  openRow(copy.stageSaving(), -1, { done: m, total: m })
  let path: string | null = null
  let saveError: string | null = null
  if (d.saveWav) {
    try {
      const saved = await d.saveWav({ b64: bytesToBase64(wavBytes), name: audioOverviewFileName(script.title) })
      if (saved?.ok && saved.path) path = saved.path
      else saveError = saved?.error || copy.errNoAudio()
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    }
  }
  // NO CANCEL CHECK HERE, deliberately. The last checkpoint was before the
  // write; by now the podcast is stitched and the file may already exist, so
  // aborting would hide a finished result (and an existing file) to honour a
  // Stop that arrived milliseconds too late. The run reports what happened.

  const url = d.makeUrl(wavBytes)
  useAudioOverviewStore.getState().finishRun(runId, {
    path, url, durationSec, turns: m, title: script.title, saveError,
  })
  // '' for the same reason the cancel does: the row reads DONE at a real 100%,
  // and "saving…" beside it would be a stage that is over.
  settleRow('completed', '')
  d.notify({ kind: 'audio-overview', status: 'completed', elapsedMs: Math.max(0, d.now() - startedAt) })
  return { started: true }
}

/** Stage 1, verbatim from the panel: one draft, one corrective JSON-only retry. */
async function draftScript(input: AudioOverviewStartInput, d: AudioOverviewRunDeps): Promise<PodcastScript> {
  const ask = async (strict: boolean): Promise<string> => {
    const res = await d.ask(buildScriptPrompt(input.source, input.title, input.length, strict))
    if (!res.ok || !res.text) {
      throw new Error(res.error === 'freellm-not-running'
        ? copy.errLlmDown()
        : (res.error ?? copy.errEmptyReply()))
    }
    return res.text
  }
  const first = await ask(false)
  try {
    return parsePodcastScript(first, input.title)
  } catch (parseErr) {
    const second = await ask(true)
    try {
      return parsePodcastScript(second, input.title)
    } catch {
      throw new Error(copy.errParseFailed(parseErr instanceof Error ? parseErr.message : String(parseErr)))
    }
  }
}

/**
 * Save (or re-save) the finished overview through media:save-wav.
 *
 * The auto-save at the end of a run is the normal path; this is the retry the
 * panel offers when that one failed, and it costs nothing but the write — the
 * stitched bytes are still in `lastWav`, so a full disk does not mean re-drafting
 * a script and re-voicing nine turns.
 */
export async function saveAudioOverviewFile(
  deps?: Partial<AudioOverviewRunDeps>,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const s = useAudioOverviewStore.getState()
  const held = lastWav
  if (!s.result || !held || held.runId !== s.runId) return { ok: false }
  const d: AudioOverviewRunDeps = { ...defaultDeps(), ...deps }
  if (!d.saveWav) return { ok: false }
  try {
    const saved = await d.saveWav({
      b64: bytesToBase64(held.bytes),
      name: audioOverviewFileName(s.result.title),
    })
    if (saved?.ok && saved.path) {
      useAudioOverviewStore.getState().patchResultSave(held.runId, { path: saved.path, saveError: null })
      return { ok: true, path: saved.path }
    }
    const error = saved?.error
    useAudioOverviewStore.getState().patchResultSave(held.runId, { saveError: error ?? null })
    return { ok: false, error }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    useAudioOverviewStore.getState().patchResultSave(held.runId, { saveError: error })
    return { ok: false, error }
  }
}

/**
 * Stop the run in flight. Latches immediately (so neither the panel's button nor
 * the rail's can be pressed twice) and the pipeline unwinds at its next
 * checkpoint — nothing here claims the work has already stopped.
 */
export function cancelAudioOverviewRun(): void {
  useAudioOverviewStore.getState().requestStop()
}

/** Tests only — the copy registration and the retry buffer are module-scoped. */
export function resetAudioOverviewRunner(): void {
  copy = FALLBACK_AUDIO_OVERVIEW_COPY
  lastWav = null
}
