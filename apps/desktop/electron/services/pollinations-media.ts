// apps/desktop/electron/services/pollinations-media.ts
//
// Pollinations KEYLESS image engine (image.pollinations.ai) — the IO half.
// Mirrors imgnai-media.ts in shape: a standalone service the Media tab (and
// the canvas media node, via graph-to-agentkit) calls through a typed IPC
// router (electron/ipc/pollinations-media.ipc.ts). The pure, unit-tested
// halves live in pollinations-media-core.ts.
//
// KEYLESS, BY DESIGN: this file reads NO keychain entry and sends NO
// credential of any kind. A fresh install with nothing pasted reaches
// generation — that is the provider's entire value. It is still a CLOUD call
// (the prompt travels to pollinations.ai), so:
//
//   • egress: 'pollinations' is in egress-policy's CLOUD_PROVIDER_IDS —
//     PRIVATE MODE blocks generation AND the catalog call here, same gate as
//     imgnai/venice/surplus. THE RULE: no cloud request may BEGIN without a
//     same-instant gate check. Concretely, four checks: before the queue (an
//     instant refusal, not one that surfaces after a 15 s wait), when the slot
//     starts, on EVERY iteration of the pacing wait, and at the last instant
//     before the fetch — the last one placed BEFORE lastRequestStartedAt is
//     stamped, so a refusal never eats the pacing slot.
//
//     This comment used to promise a re-check "inside" the queue that the code
//     did not perform: a request queued when the mode flipped still egressed
//     and wrote a JPEG ~14 s after PRIVATE MODE went on (driver-reproduced
//     2026-08-01, 19:18:16 flip → 19:18:30 file on disk). The comment was the
//     design; the code had drifted. Pinned now by pollinationsMedia.test.ts
//     ("a flip to private DURING the pacing wait").
//
//   • THE NEIGHBOURING CASE, deliberately NOT treated the same: a driver run
//     also found a fetch that was already IN FLIGHT when the mode flipped —
//     its JPEG landed ~8 s after the flip. Refusing there would refuse
//     nothing real: the GET is one round trip with the prompt in the URL, so
//     the prompt had already left this machine the instant the request was
//     sent, before the mode even changed. Discarding the finished file buys
//     back no privacy — the egress already happened — it only throws away a
//     render the user waited (and, for cloud providers generally, pays) for.
//     So the artifact is KEPT. What must not happen is the user mistaking a
//     legitimately-kept result for the bug above: the gate check right before
//     the fetch starts (`refuseIfBlocked`, just above `lastRequestStartedAt`)
//     is re-read one more time here, AFTER the fetch settles — not to decide
//     whether to write the file, only to tell the truth about it. If it now
//     reads private, the 'completed' tick and the returned artifact carry
//     `completedAfterPrivate: true`, and the gallery entry shows a small note
//     instead of appearing exactly like a queued request that should have
//     been blocked. The queued case still throws before writing anything;
//     this case writes, and says so.
//
//   • pacing: their documented anonymous limit is ONE request per 15 s. All
//     runs — composer clicks and canvas nodes alike — funnel through ONE
//     serialising promise queue (the same discipline sd-cpp-client uses for
//     the GPU) with a minimum-interval delay between request STARTS, so a
//     Run-all of N nodes queues honestly instead of racing their limiter.
//     The wait is SURFACED ('queued' ticks with elapsed seconds), never
//     animated as fake progress.
//
//   • honest progress: the GET has no step signal — a single request whose
//     latency is LOAD-DEPENDENT (2 s twice on 2026-08-01, 42 s in an earlier
//     probe). No single number is promised anywhere in the UI copy for exactly
//     that reason. Ticks on 'pollinations:gen-progress' carry state + elapsed
//     seconds only ('queued' while pacing, 'generating' while the request
//     runs), the three-phase rule from the night program.

import { BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { enforceProviderEgress, checkProviderEgress } from './egress-policy'
import { writeStorageFile } from './storage-root'
import {
  POLLINATIONS_BASE,
  POLLINATIONS_FETCH_TIMEOUT_MS,
  POLLINATIONS_STATIC_MODELS,
  POLLINATIONS_DEFAULT_MODEL,
  parsePollinationsModels,
  resolvePollinationsSize,
  rollPollinationsSeed,
  buildPollinationsImageUrl,
  pollinationsPacingDelay,
  isPollinationsImageResponse,
  type PollinationsModelInfo,
} from './pollinations-media-core'

const CATALOG_TTL_MS = 60_000

// Same Artifact shape as imgnai-media / venice-media-service so the renderer
// gallery + IPC schemas stay identical across providers.
export interface PollinationsArtifact {
  kind:     'image'
  mimeType: string
  path?:    string
  b64?:     string
}

export interface PollinationsGenerateImageInput {
  model:        string
  prompt:       string
  /** Composer "WxH" size string (e.g. '1024x1024'). Unparseable ⇒ 1024x1024. */
  size?:        string
  /** -1 / absent ⇒ rolled to a real random seed (their cache replays
   *  prompt+seed, so server-side "random" would replay the first render). */
  seed?:        number
  /** Copy finished artifacts here as well (Media tab auto-save folder). */
  autoSaveDir?: string
}

// ── Progress push (main → renderer, 'pollinations:gen-progress') ─────────────
// Same envelope as imgnai's ImgnaiGenProgress so the renderer bridge treats
// both identically: a status word + elapsed seconds, nothing bar-shaped.

export interface PollinationsGenProgress {
  requestId:  string
  kind:       'image'
  /** queued (pacing wait) | generating | completed | failed */
  status:     string
  elapsedSec: number
  /**
   * Set (true) only on a 'completed' tick whose fetch was already in flight
   * when PRIVATE MODE was engaged. The request itself is never blocked
   * retroactively — the prompt was already gone — this only tells the truth
   * about a file that is about to appear while the mode reads private, so it
   * is not mistaken for the queued-request bug fixed above (which refuses
   * and writes nothing). Absent/false on every ordinary run.
   */
  completedAfterPrivate?: boolean
}

function pushGenProgress(p: PollinationsGenProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    w.webContents.send('pollinations:gen-progress', p)
  }
}

// ── Models (live list first, static snapshot as offline fallback) ─────────────

let liveCatalog: { at: number; models: PollinationsModelInfo[] } | null = null

export async function listPollinationsModels(): Promise<{ ok: boolean; models: PollinationsModelInfo[]; error?: string }> {
  enforceProviderEgress('pollinations')
  if (liveCatalog && Date.now() - liveCatalog.at < CATALOG_TTL_MS) {
    return { ok: true, models: liveCatalog.models }
  }
  try {
    const res = await fetch(`${POLLINATIONS_BASE}/models`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(5_000) as AbortSignal,
    })
    if (res.ok) {
      const models = parsePollinationsModels(await res.json().catch(() => null))
      if (models.length > 0) {
        liveCatalog = { at: Date.now(), models }
        return { ok: true, models }
      }
    }
  } catch { /* fall through to the static snapshot — NEVER block the picker */ }
  return { ok: true, models: [...POLLINATIONS_STATIC_MODELS] }
}

// ── Pacing queue (ONE per process — composer + every canvas node share it) ───

let queue: Promise<unknown> = Promise.resolve()
/** When the last request STARTED (epoch ms). 0 = never. */
let lastRequestStartedAt = 0

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Tests only — the module-level pacing + catalog state is per-process. */
export function resetPollinationsMediaForTests(): void {
  queue = Promise.resolve()
  lastRequestStartedAt = 0
  liveCatalog = null
}

// ── Disk helpers (same layout + write path as the other media services) ──────

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

function extFor(mime: string): string {
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] ?? 'jpg'
}

function copyToDir(srcPath: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const base = srcPath.split(/[\\/]/).pop() || 'artifact'
  copyFileSync(srcPath, join(destDir, base))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate one image. Resolves with the downloaded-on-disk artifact and the
 * seed that ACTUALLY ran (rolled when the input was -1/absent) so the gallery
 * entry can record reproducible provenance. `completedAfterPrivate` is true
 * only when the fetch was already in flight when PRIVATE MODE was engaged —
 * see the header comment's "neighbouring case" for why this writes the file
 * rather than refusing it.
 */
export async function pollinationsGenerateImage(
  input: PollinationsGenerateImageInput,
): Promise<{ artifacts: PollinationsArtifact[]; seed: number; completedAfterPrivate: boolean }> {
  // Gate BEFORE the queue: a private-mode refusal must be instant, not appear
  // 15 s later behind another request's pacing slot.
  enforceProviderEgress('pollinations')

  const prompt = (input.prompt ?? '').trim()
  if (!prompt) throw new Error('Pollinations needs a prompt.')

  const requestId = `pollinations-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const { width, height } = resolvePollinationsSize(input.size)
  const seed = rollPollinationsSeed(input.seed)
  const url = buildPollinationsImageUrl({
    prompt,
    model: input.model || POLLINATIONS_DEFAULT_MODEL,
    width, height, seed,
  })

  const run = async (): Promise<{ artifacts: PollinationsArtifact[]; seed: number; completedAfterPrivate: boolean }> => {
    // THE RULE (driver-proven 2026-08-01): no cloud request may BEGIN without a
    // same-instant gate check. A refusal is announced as a 'failed' tick — a
    // silent throw here is what let a blocked request look like a live one —
    // and reuses enforceProviderEgress's own message, the same honest string
    // the pre-queue check produces.
    const refuseIfBlocked = (elapsedSec: number): void => {
      try {
        enforceProviderEgress('pollinations')
      } catch (err) {
        pushGenProgress({ requestId, kind: 'image', status: 'failed', elapsedSec })
        throw err
      }
    }

    // Re-check inside the slot — the mode can flip while this sat queued.
    refuseIfBlocked(0)

    // ── Pacing: hold this slot until 15 s have passed since the last START,
    // and SAY so — a queued state with elapsed seconds, never a fake bar.
    const queuedAt = Date.now()
    let wait = pollinationsPacingDelay(lastRequestStartedAt || null, queuedAt)
    if (wait > 0) pushGenProgress({ requestId, kind: 'image', status: 'queued', elapsedSec: 0 })
    while (wait > 0) {
      await delay(Math.min(wait, 2_000))
      const now = Date.now()
      // Re-check EVERY iteration: a flip lands mid-wait, and refusing at the
      // next 2 s tick beats holding the news until the full 15 s elapses.
      refuseIfBlocked(Math.round((now - queuedAt) / 1000))
      wait = pollinationsPacingDelay(lastRequestStartedAt || null, now)
      if (wait > 0) {
        pushGenProgress({ requestId, kind: 'image', status: 'queued', elapsedSec: Math.round((now - queuedAt) / 1000) })
      }
    }

    // Last instant before the fetch — and BEFORE lastRequestStartedAt is
    // stamped, so a refused request never consumes the pacing slot and delays
    // the next legitimate one.
    refuseIfBlocked(Math.round((Date.now() - queuedAt) / 1000))

    lastRequestStartedAt = Date.now()
    const startedAt = lastRequestStartedAt
    pushGenProgress({ requestId, kind: 'image', status: 'generating', elapsedSec: 0 })
    // Elapsed-time heartbeat while the single long GET runs (2–45 s measured):
    // the only real signal is that time is passing, so that is what is shown.
    const ticker = setInterval(() => {
      pushGenProgress({ requestId, kind: 'image', status: 'generating', elapsedSec: Math.round((Date.now() - startedAt) / 1000) })
    }, 2_000)

    try {
      const res = await fetch(url, {
        headers:  { Accept: 'image/*' },
        redirect: 'follow',
        signal:   AbortSignal.timeout(POLLINATIONS_FETCH_TIMEOUT_MS) as AbortSignal,
      })
      const contentType = res.headers.get('content-type')
      if (!isPollinationsImageResponse(res.status, contentType)) {
        const bodyText = (await res.text().catch(() => '')).slice(0, 300)
        if (res.status === 429) {
          throw new Error(`Pollinations rate limit hit (429) — the anonymous tier allows one image per 15 s. Wait a moment and generate again. ${bodyText}`.trim())
        }
        throw new Error(`Pollinations returned ${res.status} ${contentType ?? ''} instead of an image. ${bodyText}`.trim())
      }
      const mime  = (contentType ?? 'image/jpeg').split(';')[0].trim()
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0) throw new Error('Pollinations returned an empty image body.')
      const path = writeStorageFile('media', join(requestId, `0.${extFor(mime)}`), bytes)
      if (input.autoSaveDir) copyToDir(path, input.autoSaveDir)
      // NOT a gate: the fetch above already ran and its bytes are on disk — the
      // prompt left this machine before this line could ever run. This only
      // checks whether the mode now reads private, so a file that legitimately
      // finishes after the flip carries its own explanation instead of looking
      // like the queued-request bug the rest of this file refuses (see the
      // header comment's "neighbouring case").
      const completedAfterPrivate = !checkProviderEgress('pollinations').allowed
      pushGenProgress({
        requestId, kind: 'image', status: 'completed',
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        ...(completedAfterPrivate ? { completedAfterPrivate: true } : {}),
      })
      const small = bytes.byteLength <= 512 * 1024
      return {
        artifacts: [{
          kind: 'image',
          mimeType: mime,
          path,
          ...(small ? { b64: Buffer.from(bytes).toString('base64') } : {}),
        }],
        seed,
        completedAfterPrivate,
      }
    } catch (err) {
      pushGenProgress({ requestId, kind: 'image', status: 'failed', elapsedSec: Math.round((Date.now() - startedAt) / 1000) })
      throw err
    } finally {
      clearInterval(ticker)
    }
  }

  // ONE queue for every caller — the sd-cpp-client discipline: chain regardless
  // of the prior result, and keep the queue itself un-rejectable.
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}
