// apps/desktop/electron/services/hardware-info.ts
//
// One-shot hardware probe for the model catalog's fit badges. Wraps
// `systeminformation`. Returns a @tachi/core HardwareProfile. Best-effort:
// VRAM is null when the platform/driver doesn't report it.

// R8b: `systeminformation` is loaded ON FIRST PROBE, not at boot. Measured
// 41.5 ms of the 1317 ms pre-STARTUP_T0 prelude (main.ts → llama-cpp.ipc.ts /
// model-catalog.ipc.ts → here) for a module whose only two call sites are
// inside the already-async, already-memoized probeGpuCpu() below. `await
// import()` — not a require — because both uses are async anyway, and this
// keeps the deferral visible to the bundler.
import { freemem, totalmem } from 'os'
import type { HardwareProfile, HardwareGpu } from '@tachi/core'

/**
 * Rank a GPU controller so the real dedicated card wins over virtual/streaming
 * display adapters (e.g. "Meta Virtual Monitor", Parsec, Microsoft Basic) and
 * over integrated graphics. Higher = more likely the GPU you'd run models on.
 */
function gpuScore(g: HardwareGpu): number {
  const s = `${g.vendor} ${g.model}`.toLowerCase()
  let score = 0
  if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla/.test(s)) score += 1000
  else if (/radeon|\bamd\b|advanced micro/.test(s)) score += 900
  else if (/apple/.test(s)) score += 800
  else if (/intel.*arc|\barc\b/.test(s)) score += 400
  else if (/intel|uhd|iris/.test(s)) score += 200 // integrated — usable but weak
  // Push virtual / remote / mirror display adapters to the bottom.
  if (/virtual|\bbasic\b|meta |oculus|parsec|remote|mirror|\bidd\b|displaylink|microsoft basic|citrix|vmware|teamviewer/.test(s)) {
    score -= 5000
  }
  // Tie-break by reported VRAM (GB).
  score += (g.vramBytes ?? 0) / (1024 * 1024 * 1024)
  return score
}

// The GPU/CPU probe shells out to WMI/nvidia-smi and costs ~2s on Windows —
// but the installed silicon doesn't change mid-session. Cache the expensive
// part once; only the RAM snapshot (cheap, changes constantly) is re-read per
// call. Without this the Catalog grid sat blank ~2s on EVERY mount because
// its init gated on catalog:hardware.
let gpuCpuCache: Promise<{ gpus: HardwareGpu[]; cpuCores: number }> | null = null

async function probeGpuCpu(): Promise<{ gpus: HardwareGpu[]; cpuCores: number }> {
  const si = await import('systeminformation')
  let gpus: HardwareGpu[] = []
  try {
    const g = await si.graphics()
    gpus = g.controllers.map(c => ({
      model: c.model ?? 'Unknown GPU',
      vendor: c.vendor ?? '',
      // systeminformation reports vram in MB (may be null/0 on some drivers).
      vramBytes: c.vram && c.vram > 0 ? c.vram * 1024 * 1024 : null,
    }))
  } catch {
    gpus = []
  }
  // Order GPUs best-first so the banner shows the real card, not a virtual
  // monitor that happened to enumerate first.
  gpus.sort((a, b) => gpuScore(b) - gpuScore(a))
  let cpuCores = 0
  try { cpuCores = (await si.cpu()).cores ?? 0 } catch { cpuCores = 0 }
  return { gpus, cpuCores }
}

export async function detectHardware(): Promise<HardwareProfile> {
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  // Snapshot free RAM once so ramFreeBytes and the Apple-Silicon VRAM estimate
  // reflect the same moment.
  const ramFreeBytes = freemem()

  gpuCpuCache ??= probeGpuCpu().catch(err => { gpuCpuCache = null; throw err })
  const { gpus, cpuCores } = await gpuCpuCache
  const primary = gpus[0]

  // Apple Silicon shares system RAM with the GPU; treat ~70% of free RAM as
  // usable "VRAM" for offload heuristics. Otherwise prefer the primary card's
  // VRAM, falling back to the max reported (drivers sometimes 0-report the real
  // card while a virtual adapter reports a number).
  let vramFreeBytes: number | null = null
  if (isAppleSilicon) {
    vramFreeBytes = Math.floor(ramFreeBytes * 0.7)
  } else if (primary?.vramBytes && primary.vramBytes > 0) {
    vramFreeBytes = primary.vramBytes
  } else {
    const dedicated = gpus.map(g => g.vramBytes).filter((v): v is number => v != null)
    vramFreeBytes = dedicated.length ? Math.max(...dedicated) : null
  }

  return {
    platform: process.platform,
    arch: process.arch,
    ramTotalBytes: totalmem(),
    ramFreeBytes,
    cpuCores,
    gpus,
    vramFreeBytes,
    isAppleSilicon,
  }
}
