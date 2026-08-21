// apps/desktop/electron/services/gpu-detect.ts
//
// Best-effort local GPU detection (STEAL 2026-07-08, "GPU-truth"). Fixes a real
// perf bug: llama.cpp served CPU-only because nothing ever told it there was a
// GPU. This probes the machine (bounded, cached) so the app can (a) offload
// layers to the GPU, (b) recommend the CUDA build at install, and (c) show the
// truth in Doctor instead of silently running on CPU.
//
// Detection ladder (each best-effort; first hit with real VRAM wins):
//   NVIDIA : `nvidia-smi` — the gold standard (accurate VRAM + implies CUDA).
//   Windows: Win32_VideoController (lists all adapters; AdapterRAM is a uint32
//            capped ~4GB, so it's a FLOOR not the truth for big cards).
//   macOS  : system_profiler SPDisplaysDataType (Apple Silicon → Metal).
//   Linux  : nvidia-smi, else lspci VGA name (no reliable VRAM).
// All probes have a hard timeout; any failure degrades to the next rung, then
// to { vendor:'unknown', backend:'cpu' }.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { llamaCppBinDir } from './llama-cpp-installer'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'
export type GpuBackend = 'cuda' | 'metal' | 'vulkan' | 'cpu'

export interface GpuInfo {
  vendor: GpuVendor
  /** Adapter name, e.g. "NVIDIA GeForce RTX 3080 Ti". Empty when unknown. */
  name: string
  /** Usable VRAM in MB. 0 when undeterminable. */
  vramMB: number
  /** True when vramMB is a lower-bound (Win32 uint32 cap) rather than exact. */
  vramIsFloor: boolean
  /**
   * VRAM FREE at probe time, in MB — present only from nvidia-smi, which is the
   * only probe here that can see other processes' usage. Absent means unknown,
   * and unknown must never be read as "all of it".
   */
  vramFreeMB?: number
  /** The acceleration backend this GPU would use with a matching llama build. */
  backend: GpuBackend
  /** Which probe produced this (for Doctor / debugging). */
  source: string
}

const CPU_ONLY: GpuInfo = { vendor: 'unknown', name: '', vramMB: 0, vramIsFloor: false, backend: 'cpu', source: 'none' }

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : (stdout ?? '').toString())
      })
    } catch { resolve('') }
  })
}

// nvidia-smi CSV: "NVIDIA GeForce RTX 3080 Ti, 12288, 9871" (name, total, free MiB).
//
// FREE is asked for alongside TOTAL because capacity is not a budget: a browser
// holding 4 GB, or an image generation still resident on the same card, is
// invisible to `memory.total`, and an offload plan built from capacity alone
// walks straight into memory somebody else already owns. Only this probe can
// answer it — the Win32 video-controller fallback reports an adapter's
// installed RAM and nothing about who is using it — so `vramFreeMB` stays
// optional and every consumer must treat its absence as "unknown", never as
// "all of it".
async function probeNvidiaSmi(): Promise<GpuInfo | null> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])
  const line = out.split('\n').map(s => s.trim()).find(Boolean)
  if (!line) return null
  const [name, mib, freeMib] = line.split(',').map(s => s.trim())
  const vramMB = Number(mib)
  if (!name || !Number.isFinite(vramMB) || vramMB <= 0) return null
  const freeMB = Number(freeMib)
  const vramFreeMB = Number.isFinite(freeMB) && freeMB >= 0 && freeMB <= vramMB ? freeMB : undefined
  return {
    vendor: 'nvidia', name, vramMB, vramIsFloor: false, backend: 'cuda', source: 'nvidia-smi',
    ...(vramFreeMB !== undefined ? { vramFreeMB } : {}),
  }
}

// Windows: enumerate video controllers, pick the best DISCRETE adapter.
async function probeWindows(): Promise<GpuInfo | null> {
  const ps = 'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 6000)
  const rows = out.split('\n').map(s => s.trim()).filter(Boolean).map(r => {
    const [name, ram] = r.split('|')
    return { name: (name ?? '').trim(), ramBytes: Number(ram) || 0 }
  }).filter(r => r.name && !/virtual|basic|meta|remote|parsec|mirror/i.test(r.name))
  if (rows.length === 0) return null
  const vendorOf = (n: string): GpuVendor =>
    /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(n) ? 'nvidia'
    : /amd|radeon|rx |vega|instinct/i.test(n) ? 'amd'
    : /intel|arc|iris|uhd|hd graphics/i.test(n) ? 'intel' : 'unknown'
  // Prefer a discrete (nvidia/amd) adapter; among those the one with most RAM.
  const rank = (v: GpuVendor) => (v === 'nvidia' ? 3 : v === 'amd' ? 2 : v === 'intel' ? 1 : 0)
  rows.sort((a, b) => rank(vendorOf(b.name)) - rank(vendorOf(a.name)) || b.ramBytes - a.ramBytes)
  const best = rows[0]
  const vendor = vendorOf(best.name)
  const vramMB = best.ramBytes > 0 ? Math.round(best.ramBytes / (1024 * 1024)) : 0
  // AdapterRAM is a uint32 → capped near 4096MB for larger cards. Flag it.
  const vramIsFloor = vramMB >= 4000
  const backend: GpuBackend = vendor === 'nvidia' ? 'cuda' : (vendor === 'amd' || vendor === 'intel') ? 'vulkan' : 'cpu'
  return { vendor, name: best.name, vramMB, vramIsFloor, backend, source: 'win32-videocontroller' }
}

// macOS: chipset model + VRAM (Apple Silicon reports unified memory differently).
async function probeMac(): Promise<GpuInfo | null> {
  const out = await run('system_profiler', ['SPDisplaysDataType'], 6000)
  if (!out) return null
  const name = (/Chipset Model:\s*(.+)/.exec(out)?.[1] ?? '').trim()
  const vramMatch = /VRAM \(.*\):\s*(\d+)\s*(MB|GB)/i.exec(out)
  let vramMB = 0
  if (vramMatch) vramMB = Number(vramMatch[1]) * (/gb/i.test(vramMatch[2]) ? 1024 : 1)
  const apple = /apple/i.test(name) || process.arch === 'arm64'
  return {
    vendor: apple ? 'apple' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'unknown',
    name: name || (apple ? 'Apple GPU' : ''),
    vramMB,
    vramIsFloor: apple && vramMB === 0,     // Apple unified memory not reported here
    backend: apple ? 'metal' : 'vulkan',
    source: 'system_profiler',
  }
}

// Linux: nvidia-smi handled by the shared probe; else lspci name (no VRAM).
async function probeLinux(): Promise<GpuInfo | null> {
  const out = await run('sh', ['-c', 'lspci | grep -i vga'], 4000)
  const line = out.split('\n').map(s => s.trim()).find(Boolean)
  if (!line) return null
  const name = line.replace(/^.*VGA compatible controller:\s*/i, '').trim()
  const vendor: GpuVendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'unknown'
  return { vendor, name, vramMB: 0, vramIsFloor: false, backend: vendor === 'nvidia' ? 'cuda' : 'vulkan', source: 'lspci' }
}

let cached: GpuInfo | null = null

/** Detect the machine's primary GPU (cached for the process lifetime). */
export async function detectGpu(force = false): Promise<GpuInfo> {
  if (cached && !force) return cached
  let info: GpuInfo | null = null
  // nvidia-smi is cross-platform and authoritative when present.
  info = await probeNvidiaSmi()
  if (!info) {
    if (process.platform === 'win32') info = await probeWindows()
    else if (process.platform === 'darwin') info = await probeMac()
    else info = await probeLinux()
  }
  cached = info ?? CPU_ONLY
  return cached
}

/**
 * File-name markers that identify a GPU-capable llama.cpp Windows build by the
 * backend library shipped next to llama-server.exe.
 *
 * CONFIDENCE, per marker:
 *   cudart64_*.dll / ggml-cuda.* — OBSERVED. This is the pair the installed
 *     CUDA build has always been recognised by, and the cudart companion
 *     download in llama-cpp-installer exists precisely because of it.
 *   ggml-vulkan.* / ggml-hip.* / rocblas / hipblas — INFERRED from upstream's
 *     `ggml-<backend>` naming convention (the same convention that produced
 *     ggml-cuda), NOT verified against an extracted archive here. Nobody
 *     downloaded the 31 MB / 305 MB zips to look inside.
 *
 * The inferred half can only turn a FALSE NEGATIVE into a true positive: before
 * this, an installed Vulkan build reported "no GPU build" and Doctor told a
 * Radeon owner to install the very build they were already running. If a marker
 * is wrong we are back to that same false negative, never to a false claim of
 * GPU acceleration.
 */
const GPU_BUILD_MARKERS: readonly RegExp[] = [
  /cudart64_\d+\.dll/i,
  /ggml-cuda/i,
  /ggml-vulkan/i,
  /ggml-hip/i,
  /^(rocblas|hipblas)/i,
]

/** True when a filename in the llama.cpp bin dir marks a GPU-capable build. */
export function isGpuBuildMarker(filename: string): boolean {
  return GPU_BUILD_MARKERS.some(re => re.test(filename))
}

/**
 * Whether a GPU-capable llama.cpp build is installed (vs the CPU build). On
 * Windows this is decided by the backend library sitting next to
 * llama-server.exe (see GPU_BUILD_MARKERS); on macOS the arm64 build is
 * Metal-capable by definition.
 */
export function isGpuBuildInstalled(): boolean {
  const bin = llamaCppBinDir()
  if (!existsSync(bin)) return false
  if (process.platform === 'darwin') return process.arch === 'arm64'   // our mac build = Metal
  try {
    return readdirSync(bin).some(isGpuBuildMarker)
  } catch { return false }
}
