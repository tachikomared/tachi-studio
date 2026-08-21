// apps/desktop/electron/services/rife-paths.ts
//
// WHERE THE RIFE SIDECAR LIVES, and nothing else.
//
// This is a separate module from rife-installer for ONE structural reason: the
// installer downloads, so it imports installer-kit, which imports `https`. The
// RUNNER only needs to know where the binary and the model are — and the whole
// product claim for this vertical is that a run is a local computation that
// PRIVATE MODE must not block. A claim like that is worth making only if it is
// checkable, so the run path is kept free of any module that can open a socket,
// and rifeWiring asserts exactly that over the transitive import graph.
//
//   ${userData}/rife/
//     ├── bin/        rife-ncnn-vulkan[.exe] + the model directories
//     └── downloads/  transient archive + partial (installer-owned)

import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { resolveBinary } from './util/resolve-binary'
import { RIFE_MODEL_DIR, RIFE_MODEL_FILES, RIFE_VERSION, defaultRifeRelease } from './rife-plan'

export function rifeRoot(): string { return join(app.getPath('userData'), 'rife') }
export function rifeBinDir(): string { return join(rifeRoot(), 'bin') }
export function rifeDownloadsDir(): string { return join(rifeRoot(), 'downloads') }

/** Absolute path of the rife executable, or null. env → bundled → PATH. */
export function getRifeBinaryPath(): string | null {
  return resolveBinary('rife-ncnn-vulkan', {
    envVar: 'RIFE_NCNN_VULKAN_PATH',
    bundledCandidates: [join(rifeBinDir(), 'rife-ncnn-vulkan')],
  })
}

/** The model directory we pass to `-m`. */
export function rifeModelDir(): string { return join(rifeBinDir(), RIFE_MODEL_DIR) }

/**
 * Installed means BINARY **and** MODEL.
 *
 * The binary alone is useless: `-m <dir>` that does not contain flownet.param /
 * flownet.bin makes ncnn fail deep inside a run, minutes after the user clicked
 * — and the archive is the only source of those files, so a half-extracted
 * install must read as "not installed" and re-install, not as "ready".
 */
export function isRifeInstalled(): boolean {
  if (!getRifeBinaryPath()) return false
  const dir = rifeModelDir()
  return RIFE_MODEL_FILES.every(f => existsSync(join(dir, f)))
}

export interface RifeStatus {
  installed: boolean
  version: string
  model: string
  binPath: string | null
  modelDir: string | null
  /** Bytes the install will pull, so the UI can say so BEFORE the click. */
  downloadBytes: number
  /** false where upstream publishes nothing for this platform. */
  supported: boolean
}

export function rifeStatus(): RifeStatus {
  const asset = defaultRifeRelease(process.platform)
  const installed = isRifeInstalled()
  return {
    installed,
    version: RIFE_VERSION,
    model: RIFE_MODEL_DIR,
    binPath: installed ? getRifeBinaryPath() : null,
    modelDir: installed ? rifeModelDir() : null,
    downloadBytes: asset?.sizeBytes ?? 0,
    supported: asset !== null,
  }
}
