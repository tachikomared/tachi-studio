// apps/desktop/test/unit/sdGpuBuildInstalled.test.ts
//
// NIGHT-QUEUE 2026-07-31 lane 3C — behavioral coverage for
// `isSdGpuBuildInstalled` (sd-cpp-installer.ts), the sd.cpp twin of
// gpu-detect's `isGpuBuildInstalled` for llama.cpp. It reads the SAME marker
// convention (see gpu-detect.ts's GPU_BUILD_MARKERS / isGpuBuildMarker) off
// sd-cpp's own bin dir, so a Radeon/Arc owner who installs the new win-vulkan
// build stops reading as "no GPU build" in Doctor.
//
// Electron's `app.getPath('userData')` is mocked to a real temp dir (the
// established idiom in this suite — see sdCppAdapters.test.ts) so sdBinDir()
// resolves to a real, writable directory this test controls directly.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdgpubuild-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isSdGpuBuildInstalled, sdBinDir } from '../../electron/services/sd-cpp-installer'

beforeEach(() => {
  rmSync(sdBinDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(sdBinDir(), { recursive: true })
})

describe('isSdGpuBuildInstalled', () => {
  it('false when bin/ has no files at all', () => {
    expect(isSdGpuBuildInstalled()).toBe(false)
  })

  it('false for a CPU-only install (no marker files)', () => {
    writeFileSync(join(sdBinDir(), 'sd-cli.exe'), 'x')
    expect(isSdGpuBuildInstalled()).toBe(false)
  })

  it('true when the CUDA runtime companion is present (OBSERVED marker)', () => {
    writeFileSync(join(sdBinDir(), 'sd-cli.exe'), 'x')
    writeFileSync(join(sdBinDir(), 'cudart64_12.dll'), 'x')
    expect(isSdGpuBuildInstalled()).toBe(true)
  })

  it('true when a ggml-vulkan marker is present (INFERRED, reused from gpu-detect)', () => {
    writeFileSync(join(sdBinDir(), 'sd-cli.exe'), 'x')
    writeFileSync(join(sdBinDir(), 'ggml-vulkan.dll'), 'x')
    expect(isSdGpuBuildInstalled()).toBe(true)
  })

  it('true when a rocblas/hipblas marker is present (ROCm build)', () => {
    writeFileSync(join(sdBinDir(), 'sd-cli.exe'), 'x')
    writeFileSync(join(sdBinDir(), 'rocblas.dll'), 'x')
    expect(isSdGpuBuildInstalled()).toBe(true)
  })

  it('false when the bin dir does not exist at all (sd.cpp never installed)', () => {
    rmSync(sdBinDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(isSdGpuBuildInstalled()).toBe(false)
  })
})
