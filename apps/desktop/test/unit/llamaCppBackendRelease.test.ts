// apps/desktop/test/unit/llamaCppBackendRelease.test.ts
//
// BATCH35 LANE A / plan BATCH D (R12) — the alternate-backend llama.cpp builds.
//
// Before this, gpu-detect.ts had computed `backend: 'vulkan'` for every AMD /
// Intel / iGPU since it was written and NOTHING could serve that verdict: the
// registry's only GPU row was CUDA, so those users silently installed the CPU
// build while doctor-service told them to install "the VULKAN build" that did
// not exist.
//
// ARTIFACT HONESTY. Both new rows were verified LIVE (2026-07-27) against
//   GET https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10054
// The `sha256` values below are the release's OWN published `digest` field —
// upstream's hash, not one we computed from a download — and the byte sizes are
// that response's `size`. This test pins the exact bytes so a silent edit to
// either value fails here rather than at a user's SHA-mismatch abort.
//
//   llama-b10054-bin-win-vulkan-x64.zip      32 788 387 B
//     994e46d71dfc089c069f6b7b3c4d22c1b102a0defb2ce661ad163721eca43282
//   llama-b10054-bin-win-hip-radeon-x64.zip 319 846 770 B
//     0b164fad6f95d97082497e7f5657c0b56af5816cba808d45857d1e84c874f65e
//
// Pure node-env: llama-cpp-models has no electron import.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  LLAMA_CPP_RELEASES, LLAMA_CPP_VERSION, releaseIdForBackend, getReleaseAsset,
} from '../../electron/services/llama-cpp-models'

const VULKAN_SHA = '994e46d71dfc089c069f6b7b3c4d22c1b102a0defb2ce661ad163721eca43282'
const HIP_SHA    = '0b164fad6f95d97082497e7f5657c0b56af5816cba808d45857d1e84c874f65e'

describe('LLAMA_CPP_RELEASES — the verified alternate-backend rows', () => {
  const vulkan = LLAMA_CPP_RELEASES.find(r => r.id === 'win-vulkan')
  const hip    = LLAMA_CPP_RELEASES.find(r => r.id === 'win-hip')

  it('ships a Vulkan row', () => {
    expect(vulkan).toBeDefined()
  })

  it('pins the Vulkan asset name to the tag the registry pins', () => {
    expect(vulkan!.filename).toBe(`llama-${LLAMA_CPP_VERSION}-bin-win-vulkan-x64.zip`)
    expect(vulkan!.url).toContain(LLAMA_CPP_VERSION)
    expect(vulkan!.url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/')).toBe(true)
  })

  it('pins the Vulkan sha256 to the upstream-published digest — no placeholder', () => {
    expect(vulkan!.sha256).toBe(VULKAN_SHA)
    expect(vulkan!.sha256).not.toMatch(/__SHA_PLACEHOLDER/)
    expect(vulkan!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('needs no CUDA and declares no cudart companion (the ICD loader ships with the driver)', () => {
    expect(vulkan!.needsCuda).toBe(false)
    expect(vulkan!.cudartUrl).toBeUndefined()
    expect(vulkan!.cudartFilename).toBeUndefined()
    expect(vulkan!.cudartSha256).toBeUndefined()
  })

  it('ships a ROCm/HIP row pinned to the upstream digest', () => {
    expect(hip).toBeDefined()
    expect(hip!.filename).toBe(`llama-${LLAMA_CPP_VERSION}-bin-win-hip-radeon-x64.zip`)
    expect(hip!.sha256).toBe(HIP_SHA)
    expect(hip!.sha256).not.toMatch(/__SHA_PLACEHOLDER/)
    expect(hip!.needsCuda).toBe(false)
  })

  it('records the ~10x size gap that makes Vulkan the automatic AMD choice', () => {
    // 32 788 387 B ≈ 31 MiB · 319 846 770 B ≈ 305 MiB.
    expect(vulkan!.sizeMb).toBe(31)
    expect(hip!.sizeMb).toBe(305)
    expect(hip!.sizeMb).toBeGreaterThan(vulkan!.sizeMb * 5)
  })

  it('does not disturb the pre-existing CUDA / CPU / macOS rows', () => {
    for (const id of ['win-cuda', 'win-avx', 'macos-arm64'] as const) {
      expect(getReleaseAsset(id)).not.toBeNull()
    }
    expect(getReleaseAsset('win-cuda')!.needsCuda).toBe(true)
    expect(getReleaseAsset('win-cuda')!.cudartUrl).toBeTruthy()
  })

  it('leaves every shipped row with a real sha and a zip/tar.gz kind', () => {
    for (const r of LLAMA_CPP_RELEASES) {
      expect(r.sha256, r.id).toMatch(/^[0-9a-f]{64}$/)
      expect(['zip', 'tar.gz']).toContain(r.archiveKind)
    }
  })

  it('registers no Linux row — that platform still routes to the manual-install message', () => {
    expect(LLAMA_CPP_RELEASES.some(r => r.platform === 'linux')).toBe(false)
  })
})

describe('releaseIdForBackend — the 3-way selection', () => {
  it('serves the vulkan verdict that used to fall through to CPU', () => {
    expect(releaseIdForBackend('vulkan', 'win32', 'x64')).toBe('win-vulkan')
  })

  it('keeps CUDA for nvidia', () => {
    expect(releaseIdForBackend('cuda', 'win32', 'x64')).toBe('win-cuda')
  })

  it('falls back to the CPU build for a cpu/unknown backend', () => {
    expect(releaseIdForBackend('cpu', 'win32', 'x64')).toBe('win-avx')
  })

  it('never auto-selects the 305 MB HIP build — it is an explicit expert choice only', () => {
    const auto = (['cuda', 'vulkan', 'metal', 'cpu'] as const)
      .map(b => releaseIdForBackend(b, 'win32', 'x64'))
    expect(auto).not.toContain('win-hip')
    // …but it stays reachable by id for a user who asks for it.
    expect(getReleaseAsset('win-hip')).not.toBeNull()
  })

  it('maps Apple Silicon to the Metal-capable arm64 build', () => {
    expect(releaseIdForBackend('metal', 'darwin', 'arm64')).toBe('macos-arm64')
    expect(releaseIdForBackend('vulkan', 'darwin', 'arm64')).toBe('macos-arm64')
  })

  it('returns null for Intel Mac and Linux so the caller keeps its unsupported-platform message', () => {
    expect(releaseIdForBackend('metal', 'darwin', 'x64')).toBeNull()
    expect(releaseIdForBackend('vulkan', 'linux', 'x64')).toBeNull()
    expect(releaseIdForBackend('cuda', 'linux', 'x64')).toBeNull()
  })

  it('only ever returns an id that exists for the requested platform', () => {
    for (const backend of ['cuda', 'vulkan', 'metal', 'cpu'] as const) {
      for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']] as const) {
        const id = releaseIdForBackend(backend, platform, arch)
        if (id === null) continue
        const asset = LLAMA_CPP_RELEASES.find(r => r.id === id)
        expect(asset, `${backend}/${platform}`).toBeDefined()
        expect(asset!.platform).toBe(platform)
      }
    }
  })
})

describe('llama-cpp.ipc uses the map instead of the CUDA special case (source)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/ipc/llama-cpp.ipc.ts'), 'utf8')

  it('drops the `gpu.backend === \'cuda\'` branch', () => {
    expect(src).not.toContain("gpu.backend === 'cuda'")
  })

  it('resolves the recommendation through releaseIdForBackend', () => {
    expect(src).toContain('releaseIdForBackend(gpu.backend)')
  })

  it('names the build it recommends rather than saying "CUDA" for every GPU', () => {
    expect(src).toContain('gpuBuildName(asset.id)')
    expect(src).toMatch(/case 'win-vulkan':\s*return 'Vulkan'/)
  })

  it('still leaves a cpu backend on the platform default', () => {
    expect(src).toContain("gpu.backend !== 'cpu'")
  })
})

describe('gpu-detect recognises a non-CUDA GPU build (source + pure matcher)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/services/gpu-detect.ts'), 'utf8')

  it('exports a pure filename matcher rather than an inline regex in the fs walk', () => {
    expect(src).toContain('export function isGpuBuildMarker')
    expect(src).toContain('readdirSync(bin).some(isGpuBuildMarker)')
  })

  it('keeps the observed CUDA markers', () => {
    expect(src).toMatch(/cudart64_\\d\+\\\.dll/)
    expect(src).toContain('/ggml-cuda/i')
  })

  it('adds vulkan + hip markers so an installed Vulkan build stops reading as "no GPU build"', () => {
    expect(src).toContain('/ggml-vulkan/i')
    expect(src).toContain('/ggml-hip/i')
  })

  it('documents the vulkan/hip markers as INFERRED, not observed in an extracted archive', () => {
    expect(src).toContain('INFERRED')
    expect(src).toContain('FALSE NEGATIVE')
  })
})
