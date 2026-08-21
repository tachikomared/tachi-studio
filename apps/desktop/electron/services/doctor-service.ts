// apps/desktop/electron/services/doctor-service.ts
//
// App-wide sidecar health check (STEAL 2026-07-07, Agent-Reach doctor.py):
// one pass that EXECUTES every external binary the app depends on and
// classifies the result. "Installed" flags only prove a file exists — the
// 2026-07-06 resolveBinary bug silently disabled 4 sidecars while every
// existence check stayed green; this probe catches that whole class.
//
// Each target is probed with a cheap read-only arg (--version/--help) under a
// hard timeout. Per-target exception isolation: one probe blowing up never
// hides the others' results.

import { execFile } from 'child_process'
import { getPiperBinaryPath } from './piper-installer'
import { getSdCliPath, isSdCppInstalled, isSdGpuBuildInstalled } from './sd-cpp-installer'
import { getYtDlpBinaryPath } from './yt-dlp-installer'
import { getWhisperCliPath } from './whisper-installer'
import { llamaServerBinaryPath, isLlamaCppInstalled } from './llama-cpp-installer'
import { getChromiumPath } from './chromium-installer'
import { getFreellmapiPort, getFreellmapiApiKey } from './sidecar-manager'
import { staleCuratedModelIds, CURATION_MAX_AGE_DAYS, expiredFreeModelIds } from '@tachi/core'
import {
  classifyExit, classifySpawnError, pickDetailLine,
  type DoctorEntry, type DoctorStatus,
} from './util/doctor-classify'

export type { DoctorEntry, DoctorStatus }

const PROBE_TIMEOUT_MS = 10_000
const HTTP_TIMEOUT_MS  = 5_000

interface BinaryTarget {
  id:          string
  label:       string
  resolve:     () => string | null
  probeArgs:   string[]
  /** Exit codes that still count as healthy (help text on some tools exits 1). */
  okExitCodes?: number[]
}

const BINARY_TARGETS: BinaryTarget[] = [
  { id: 'piper',    label: 'Piper TTS',           resolve: getPiperBinaryPath,  probeArgs: ['--help'],    okExitCodes: [0, 1] },
  { id: 'sd-cpp',   label: 'Stable Diffusion',    resolve: getSdCliPath,        probeArgs: ['--help'],    okExitCodes: [0, 1] },
  { id: 'yt-dlp',   label: 'yt-dlp',              resolve: getYtDlpBinaryPath,  probeArgs: ['--version'] },
  { id: 'whisper',  label: 'Whisper STT',         resolve: getWhisperCliPath,   probeArgs: ['--help'],    okExitCodes: [0, 1] },
  { id: 'llama',    label: 'llama.cpp server',    resolve: () => (isLlamaCppInstalled() ? llamaServerBinaryPath() : null), probeArgs: ['--version'] },
  { id: 'chromium', label: 'Managed Chromium',    resolve: getChromiumPath,     probeArgs: ['--version'] },
]

function probeBinary(target: BinaryTarget): Promise<DoctorEntry> {
  const started = Date.now()
  const base = { id: target.id, label: target.label }

  let path: string | null = null
  try { path = target.resolve() } catch (err) {
    return Promise.resolve({ ...base, status: 'error', detail: `resolver failed: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started })
  }
  if (!path) return Promise.resolve({ ...base, status: 'missing', detail: 'not installed', ms: Date.now() - started })

  return new Promise<DoctorEntry>((resolve) => {
    execFile(path, target.probeArgs, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const ms = Date.now() - started
      const detailLine = pickDetailLine(String(stdout ?? ''), String(stderr ?? ''))
      if (!err) {
        resolve({ ...base, status: 'ok', path: path!, detail: detailLine || 'exit 0', ms })
        return
      }
      const spawnStatus = classifySpawnError(err as { code?: string | number | null; killed?: boolean; signal?: string | null })
      if (spawnStatus === null && typeof (err as { code?: unknown }).code === 'number') {
        const code = (err as { code: number }).code
        const status = classifyExit(code, target.okExitCodes)
        resolve({ ...base, status, path: path!, detail: status === 'ok' ? (detailLine || `exit ${code}`) : `exit ${code}${detailLine ? ` — ${detailLine}` : ''}`, ms })
        return
      }
      const status = spawnStatus ?? 'error'
      resolve({
        ...base,
        status,
        path: path!,
        detail: status === 'timeout' ? `no exit within ${PROBE_TIMEOUT_MS / 1000}s` : ((err as Error).message ?? String(err)).slice(0, 120),
        ms,
      })
    })
  })
}

async function probeFreellm(): Promise<DoctorEntry> {
  const started = Date.now()
  const base = { id: 'freellmapi', label: 'FreeLLM router' }
  const port = getFreellmapiPort()
  if (!port) return { ...base, status: 'missing', detail: 'sidecar not running', ms: Date.now() - started }
  const url = `http://127.0.0.1:${port}/v1/models`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getFreellmapiApiKey()}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (res.ok) {
      let count = 0
      try { const j = await res.json() as { data?: unknown[] }; count = j.data?.length ?? 0 } catch { /* body shape best-effort */ }
      return { ...base, status: 'ok', path: url, detail: count ? `${count} models` : `HTTP ${res.status}`, ms: Date.now() - started }
    }
    return { ...base, status: 'error', path: url, detail: `HTTP ${res.status}`, ms: Date.now() - started }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    return { ...base, status: timedOut ? 'timeout' : 'broken', path: url, detail: timedOut ? `no response within ${HTTP_TIMEOUT_MS / 1000}s` : (err instanceof Error ? err.message : String(err)).slice(0, 120), ms: Date.now() - started }
  }
}

// GPU-truth (STEAL 2026-07-08): show what the machine actually offers and
// whether local models will USE it. "ok" = GPU active OR genuinely CPU-only;
// "missing" is the actionable case — a GPU exists but the CPU build is
// installed, so it sits idle (install the GPU build to fix).
//
// NIGHT-QUEUE 2026-07-31 lane 3C: this used to check ONLY llama.cpp, so an
// AMD/Intel owner who only ever touches local IMAGE gen (sd.cpp, a separate
// sidecar) got no signal at all about their own idle GPU. Both local engines
// are checked now; an engine the user has never installed is not "idle GPU",
// it just isn't a problem yet, so it is excluded from the actionable list
// rather than misreported as "the CPU build is installed".
async function probeGpu(): Promise<DoctorEntry> {
  const started = Date.now()
  const base = { id: 'gpu', label: 'GPU acceleration' }
  try {
    const { detectGpu, isGpuBuildInstalled } = await import('./gpu-detect')
    const gpu = await detectGpu()
    const vram = gpu.vramMB > 0 ? ` · ${Math.round(gpu.vramMB / 1024)}GB${gpu.vramIsFloor ? '+' : ''} VRAM` : ''
    if (gpu.vendor === 'unknown' || gpu.backend === 'cpu') {
      return { ...base, status: 'ok', detail: 'no discrete GPU detected — local models run on CPU', ms: Date.now() - started }
    }

    const llamaInstalled = isLlamaCppInstalled()
    const sdInstalled     = isSdCppInstalled()
    if (!llamaInstalled && !sdInstalled) {
      return {
        ...base, status: 'ok',
        detail: `${gpu.name}${vram} detected — install a local engine (llama.cpp or Stable Diffusion) to use it`,
        ms: Date.now() - started,
      }
    }

    const stale: string[] = []
    if (llamaInstalled && !isGpuBuildInstalled())   stale.push('llama.cpp (Settings → llama.cpp)')
    if (sdInstalled    && !isSdGpuBuildInstalled()) stale.push('Stable Diffusion (Settings → Stable Diffusion)')
    if (stale.length > 0) {
      return {
        ...base, status: 'missing',
        detail: `${gpu.name}${vram} detected, but the CPU build is installed for: ${stale.join(', ')} — install the ${gpu.backend.toUpperCase()} build to use it`,
        ms: Date.now() - started,
      }
    }
    return { ...base, status: 'ok', detail: `${gpu.name}${vram} · ${gpu.backend.toUpperCase()} — GPU offload active`, ms: Date.now() - started }
  } catch (err) {
    return { ...base, status: 'error', detail: `GPU probe failed: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started }
  }
}

// Curated model facts (task-tags.ts CURATED_MODEL_NOTES) each carry a `readOn`
// date and stop counting after CURATION_MAX_AGE_DAYS; the resolver then drops
// that model's tags. Dating a claim only buys something if somebody is TOLD
// when it rots — until this row, `staleCuratedModelIds()` had no runtime caller
// and the expiry was silent, which is the failure mode the dates exist to stop.
//
// Not an executed probe, but neither is the GPU row: both check that something
// the app relies on being true still is. Sync and instant, so no timeout.
// 'missing' matches the GPU row's use of it for "actionable, not broken".
const STALE_IDS_SHOWN = 6

function probeCuratedModelFacts(): DoctorEntry {
  const started = Date.now()
  const base = { id: 'model-facts', label: 'Curated model facts' }
  try {
    const stale = staleCuratedModelIds()
    if (stale.length === 0) {
      return { ...base, status: 'ok', detail: `all curated claims re-read within ${CURATION_MAX_AGE_DAYS}d`, ms: Date.now() - started }
    }
    const shown = stale.slice(0, STALE_IDS_SHOWN).join(', ')
    const rest  = stale.length > STALE_IDS_SHOWN ? `, +${stale.length - STALE_IDS_SHOWN} more` : ''
    return {
      ...base, status: 'missing',
      detail: `${stale.length} curated claim${stale.length === 1 ? '' : 's'} older than ${CURATION_MAX_AGE_DAYS}d — tags dropped for ${shown}${rest}. Re-read the source and bump readOn in packages/core/src/models/task-tags.ts`,
      ms: Date.now() - started,
    }
  } catch (err) {
    return { ...base, status: 'error', detail: `taxonomy check failed: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started }
  }
}

// The same argument as the row above, applied to the OTHER dated table. A
// verified-free row carries the expiry its gateway published, and expiry
// already WORKS — `isVerifiedFreeModel` stops saying yes on the dot and the
// model falls through to UNKNOWN rather than staying free forever. What it does
// not do is tell anybody: the row keeps sitting there looking authoritative
// while a model quietly starts costing money, and the first sign is a changed
// number on a dashboard days later.
//
// `ling-3.0-flash:free` closes 2026-08-03T10:00Z, `macaron-v1-tall` on 08-10.
function probeFreePromoWindows(): DoctorEntry {
  const started = Date.now()
  const base = { id: 'free-promos', label: 'Free-model promo windows' }
  try {
    const expired = expiredFreeModelIds()
    if (expired.length === 0) {
      return { ...base, status: 'ok', detail: 'every published free window is still open', ms: Date.now() - started }
    }
    const shown = expired.slice(0, STALE_IDS_SHOWN).map(e => `${e.id} (${e.freeUntil.slice(0, 10)})`).join(', ')
    const rest  = expired.length > STALE_IDS_SHOWN ? `, +${expired.length - STALE_IDS_SHOWN} more` : ''
    return {
      ...base, status: 'missing',
      detail: `${expired.length} free window${expired.length === 1 ? ' has' : 's have'} closed — ${shown}${rest}. These now price as UNKNOWN; re-read the gateway catalog and either add a dated rate row or retire the id (packages/core/src/pricing.ts)`,
      ms: Date.now() - started,
    }
  } catch (err) {
    return { ...base, status: 'error', detail: `promo check failed: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started }
  }
}

/** Run every probe concurrently; a target's failure never hides the rest. */
export async function runDoctor(): Promise<DoctorEntry[]> {
  const probes: Array<Promise<DoctorEntry>> = [
    probeFreellm(),
    probeGpu(),
    Promise.resolve().then(probeFreePromoWindows).catch((err): DoctorEntry => ({
      id: 'free-promos', label: 'Free-model promo windows', status: 'error',
      detail: `probe crashed: ${err instanceof Error ? err.message : String(err)}`, ms: 0,
    })),
    Promise.resolve().then(probeCuratedModelFacts).catch((err): DoctorEntry => ({
      id: 'model-facts', label: 'Curated model facts', status: 'error',
      detail: `probe crashed: ${err instanceof Error ? err.message : String(err)}`, ms: 0,
    })),
    ...BINARY_TARGETS.map(t =>
      probeBinary(t).catch((err): DoctorEntry => ({
        id: t.id, label: t.label, status: 'error',
        detail: `probe crashed: ${err instanceof Error ? err.message : String(err)}`, ms: 0,
      }))
    ),
  ]
  return Promise.all(probes)
}
