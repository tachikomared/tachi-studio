// apps/desktop/electron/ipc/whisper.ipc.ts
//
// IPC handlers for local speech-to-text (whisper.cpp via nodejs-whisper).
//
// Channels:
//   whisper:check-installed   → { built: boolean; modelsReady: boolean; models: WhisperModelInfo[] }
//   whisper:list-models       → WhisperModelInfo[]
//   whisper:download-model    → starts ensureModel(); progress via 'whisper:progress' push channel
//   whisper:transcribe        → { audioBase64: string; modelName?: string } → { text; duration_ms }

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  listModels,
  ensureModel,
  transcribe,
  whisperStatus,
  whisperEvents,
} from '../services/whisper-service'
import type { WhisperModelName } from '../services/whisper-service'
import {
  installWhisperCli, isWhisperCliInstalled, cancelWhisperModelDownload, removeWhisperModel,
} from '../services/whisper-installer'
import { defaultWhisperRelease } from '../services/whisper-models'

const MODEL_NAMES = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3-turbo-q5_0'] as const
const ModelNameSchema = z.enum(MODEL_NAMES)
// R10 — optional transcription language hint; the renderer sends the active UI
// locale (`en`, `ru`, `zh-Hans`, …). Bounded here, then whitelisted by
// resolveWhisperLanguage() in the service (unknown tags degrade to `auto`), so
// nothing unvetted ever reaches the whisper-cli arg vector.
const LangSchema = z.string().max(16)

export function registerWhisperIpc(win: BrowserWindow): void {
  // ── whisper:check-installed ───────────────────────────────────────────────
  ipcMain.handle('whisper:check-installed', () => {
    const status = whisperStatus()
    return {
      built:       status !== 'not-built',
      modelsReady: status === 'ready',
      models:      listModels(),
      // A prebuilt whisper-cli is available to install for this platform (audit
      // H3 — Windows x64). When true the UI can offer an explicit install.
      canInstall:  defaultWhisperRelease(process.platform, process.arch) !== null,
      cliInstalled: isWhisperCliInstalled(),
    }
  })

  // ── whisper:install ───────────────────────────────────────────────────────
  // Install the prebuilt whisper-cli engine (audit H3). Progress is pushed on
  // 'whisper:install-progress' by the installer. No-op if already installed.
  ipcMain.handle('whisper:install', async () => {
    try { await installWhisperCli(win); return { ok: true as const } }
    catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) } }
  })

  // ── whisper:list-models ───────────────────────────────────────────────────
  ipcMain.handle('whisper:list-models', () => {
    return listModels()
  })

  // ── whisper:download-model ────────────────────────────────────────────────
  // Kicks off ensureModel() and relays progress to the renderer via push channel.
  // The IPC call itself resolves when download+build completes (or rejects on error).
  ipcMain.handle('whisper:download-model', async (_event, payload: unknown) => {
    const { modelName } = z.object({
      modelName: ModelNameSchema.optional().default('base.en'),
    }).parse(payload ?? {})

    // Forward progress events to renderer while download is in progress
    const onProgress = (evt: unknown) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('whisper:progress', evt)
      }
    }
    whisperEvents.on('progress', onProgress)

    try {
      await ensureModel(modelName as WhisperModelName)
      return { ok: true, models: listModels() }
    } catch (err) {
      throw err
    } finally {
      whisperEvents.off('progress', onProgress)
    }
  })

  // ── whisper:cancel-download ───────────────────────────────────────────────
  // STOP an in-flight model download. PAUSE semantics (llama-cpp/sd-cpp
  // contract): the `.part` bytes are KEPT so the DOWNLOADS strip or a Catalog
  // re-click resumes from that offset. This matters most for `medium.en`
  // (~1.5 GB) — the reason the model rows are no longer Stop-ungated.
  // `cancelled:false` = nothing was pausable (not downloading, or already
  // verifying) and MUST NOT be reported as a successful stop.
  ipcMain.handle('whisper:cancel-download', (_event, payload: unknown) => {
    const parsed = z.object({ modelName: ModelNameSchema }).safeParse(payload ?? {})
    if (!parsed.success) return { ok: false as const, error: 'modelName is required' }
    return { ok: true as const, cancelled: cancelWhisperModelDownload(parsed.data.modelName as WhisperModelName) }
  })

  // ── whisper:remove-model ──────────────────────────────────────────────────
  // Delete one downloaded ggml weight (Catalog → Installed → REMOVE). The
  // whisper-cli binary is NOT touched — only the weight the row advertises.
  ipcMain.handle('whisper:remove-model', (_event, payload: unknown) => {
    const parsed = z.object({ modelName: ModelNameSchema }).safeParse(payload ?? {})
    if (!parsed.success) return { ok: false as const, error: 'modelName is required' }
    return removeWhisperModel(parsed.data.modelName)
  })

  // ── whisper:transcribe ────────────────────────────────────────────────────
  // Body: { audioBase64: string (WAV or WebM as base64); modelName?: string; lang?: string }
  // Returns: { text: string; duration_ms: number }
  ipcMain.handle('whisper:transcribe', async (_event, payload: unknown) => {
    const { audioBase64, modelName, lang } = z.object({
      audioBase64: z.string().min(1),
      modelName:   ModelNameSchema.optional().default('base.en'),
      lang:        LangSchema.optional(),
    }).parse(payload)

    const audio = Buffer.from(audioBase64, 'base64')
    return transcribe(audio, modelName as WhisperModelName, lang)
  })
}
