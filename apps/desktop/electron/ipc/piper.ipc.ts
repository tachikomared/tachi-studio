// apps/desktop/electron/ipc/piper.ipc.ts
//
// IPC surface for the piper LOCAL text-to-speech sidecar.
//   piper:catalog        — curated voices + release assets
//   piper:status         — { installed, voices: [{id}] }
//   piper:install        — download + extract the piper binary (progress events)
//   piper:download-voice — download a voice (.onnx + .onnx.json) (progress events)
//   piper:remove-voice   — delete a downloaded voice
//   piper:synthesize     — text → wav
// Push: piper:install-progress
//
// Also hosts the KOKORO surface (studio-quality local TTS, kokoro-js in-process
// — see electron/services/kokoro-tts.ts):
//   kokoro:status        — { installed, downloading, progress?, voices, modelDir }
//   kokoro:ensure        — one-time ~92MB model download (only ensure egresses)
//   kokoro:synthesize    — { text, voice } → { ok, b64? (WAV), error? }
//   media:save-wav       — { b64, name } → { ok, path? } into <userData>/media/kokoro
// Push: kokoro:progress { progress: 0-1, file? }

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { PIPER_VOICES, PIPER_RELEASES } from '../services/piper-models'
import { installPiper, downloadVoice, removeVoice, cancelVoiceDownload } from '../services/piper-installer'
import { piperStatus, synthesize, type PiperSynthInput } from '../services/piper-client'
import {
  kokoroStatus,
  ensureKokoro,
  kokoroSynthesize,
  saveWavToMediaLibrary,
  type KokoroSynthesizeInput,
  type SaveWavInput,
} from '../services/kokoro-tts'

export function registerPiperIpc(win: BrowserWindow): void {
  ipcMain.handle('piper:catalog', () => ({
    ok: true as const,
    voices: PIPER_VOICES.map(v => ({ id: v.id, name: v.name, lang: v.lang, quality: v.quality, sizeMb: v.sizeMb })),
    releases: PIPER_RELEASES,
  }))
  ipcMain.handle('piper:status', () => piperStatus())
  ipcMain.handle('piper:install', async () => {
    try { await installPiper(win); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })
  ipcMain.handle('piper:download-voice', async (_e, { id }: { id: string }) => {
    try { await downloadVoice(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })
  // piper:cancel-download — STOP an in-flight VOICE download. Maps to the
  // manager's PAUSE (same contract as llama-cpp/sd-cpp:cancel-download): the
  // `.onnx.part` is KEPT so the strip / a Catalog re-click resumes from the
  // offset already on disk. `cancelled:false` = nothing was pausable for that
  // id (no download in flight, or it is inside the tiny non-managed
  // `.onnx.json` sidecar step) — the UI must not claim a stop in that case.
  ipcMain.handle('piper:cancel-download', (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    return { ok: true as const, cancelled: cancelVoiceDownload(id) }
  })
  ipcMain.handle('piper:remove-voice', (_e, { id }: { id: string }) => removeVoice(id))
  ipcMain.handle('piper:synthesize', async (_e, input: PiperSynthInput) => {
    try { const r = await synthesize(input); return { ok: true as const, ...r } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // ── Kokoro — studio-quality local TTS (kokoro-js, in-process ONNX) ──────────
  // status/synthesize never download; only ensure() egresses (private-mode gated
  // inside the service). Synth calls are serialized in the service (one session).
  ipcMain.handle('kokoro:status', () => kokoroStatus())
  ipcMain.handle('kokoro:ensure', () => ensureKokoro(win))
  ipcMain.handle('kokoro:synthesize', (_e, input: KokoroSynthesizeInput) => kokoroSynthesize(input))
  // Save synthesized WAV bytes under <userData>/media/kokoro — the artifacts
  // root served by tachi-media:// — and return the absolute path; the renderer
  // registers that path in the Artifacts gallery (media.store).
  ipcMain.handle('media:save-wav', (_e, input: SaveWavInput) => saveWavToMediaLibrary(input))
}
