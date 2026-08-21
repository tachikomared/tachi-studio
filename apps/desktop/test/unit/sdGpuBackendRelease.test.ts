// apps/desktop/test/unit/sdGpuBackendRelease.test.ts
//
// NIGHT-QUEUE 2026-07-31 lane 3C — the sd.cpp twin of BATCH35/R12's llama.cpp
// alternate-backend work (see llamaCppBackendRelease.test.ts).
//
// Before this, gpu-detect.ts computed `backend: 'vulkan'` for every AMD /
// Intel / iGPU and NOTHING in the sd.cpp installer could serve that verdict:
// SD_CPP_RELEASES had only win-cuda / win-cpu / mac-arm64, and
// `defaultReleaseAsset(platform, arch, cuda: boolean)` collapsed every
// non-nvidia GPU straight to the CPU build. llama.cpp (a SEPARATE sidecar)
// already had a Vulkan row from an earlier batch; sd.cpp — local IMAGE/VIDEO
// gen — did not.
//
// ARTIFACT HONESTY. The `sha256` values are the release's OWN published
// `digest` field from the GitHub API — upstream's hash, not one computed from a
// download and asked to be trusted — and the byte sizes are that response's
// `size`. This test pins the exact bytes so a silent edit fails here rather
// than at a user's SHA-mismatch abort.
//
// -- WHY THE PINS NOW LIVE IN ONE DATED BLOCK, 2026-08-03 -------------------
//
// The first version of this file hardcoded `master-782-b290693` in four
// separate assertions. Bumping the engine therefore failed in four places that
// each looked like a regression ("leaves the CUDA row byte-identical") when the
// truth was that the pin had moved on purpose. A test that cannot tell an
// intended bump from an accidental edit teaches you to edit tests.
//
// So: ONE `VERIFIED` record, keyed by the tag it was checked against. Bumping
// SD_CPP_VERSION means re-running the API call above and replacing that block —
// one edit, and the mismatch message says so.
//
// The structural check below is the one that earns its keep. Both the rocm and
// the macOS asset names moved between 782 and 810 (7.1.1 -> 7.14.0, macOS-26.4
// -> 26.5.2); a bump that only swapped the tag string would have shipped two
// URLs that 404 at install time, on the two platforms this machine cannot test.
//
// Pure node-env: sd-cpp-models has no electron import (user-sd-models.ts, its
// one runtime dependency, only `require('electron')` lazily inside a function
// this test never calls).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SD_CPP_RELEASES, SD_CPP_VERSION, sdReleaseForBackend,
} from '../../electron/services/sd-cpp-models'

/**
 * What the GitHub API returned for the pinned tag, verbatim. Re-verify on every
 * SD_CPP_VERSION bump:
 *   GET https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/<tag>
 *
 * `win-cpu` additionally carries a hash COMPUTED from a real download
 * (2026-08-03) that equalled the published digest — which is what makes quoting
 * the API for the rest an inference from a checked sample rather than a hope.
 */
const VERIFIED: Record<string, { filename: string; size: number; sha256: string }> & { tag: string } = {
  tag: 'master-810-db99efd',
  'win-vulkan': { filename: 'sd-master-db99efd-bin-win-vulkan-x64.zip',      size:  37_829_640, sha256: 'df95f86081ef7ed8978a36ce87fade6bb8537a6f4a3c3487727a025e5607e0a4' },
  'win-rocm':   { filename: 'sd-master-db99efd-bin-win-rocm-7.14.0-x64.zip', size: 200_234_508, sha256: 'd2f88891b01222c99f8e59d97b5eb88693798eaf1f575a6ccdc53777462f6f59' },
  'win-cuda':   { filename: 'sd-master-db99efd-bin-win-cuda12-x64.zip',      size: 362_013_051, sha256: '5a71f975e82cfb809884910bdd7b39095525d4525cd1519994106c8c236d9062' },
  'win-cpu':    { filename: 'sd-master-db99efd-bin-win-cpu-x64.zip',         size:  23_834_751, sha256: '4a8cf09b71ec7f51c2c813316eb312d9058134ea08e73063edc02a2b709bc232' },
  'mac-arm64':  { filename: 'sd-master-db99efd-bin-Darwin-macOS-26.5.2-arm64.zip', size: 49_595_370, sha256: 'd3ae42317c723b9e381d91bfe36edd14b5712737776f404d216eb326d750b5e8' },
  /** Byte-identical to master-782 — an existing CUDA install re-downloads the
   *  engine and not this 563 MB runtime. */
  cudart: { filename: 'cudart-sd-bin-win-cu12-x64.zip', size: 563_452_046, sha256: 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d' },
} as unknown as Record<string, { filename: string; size: number; sha256: string }> & { tag: string }

const VULKAN_SHA = VERIFIED['win-vulkan'].sha256
const ROCM_SHA   = VERIFIED['win-rocm'].sha256
const CUDA_SHA   = VERIFIED['win-cuda'].sha256

describe('SD_CPP_RELEASES — the verified alternate-backend rows', () => {
  const vulkan = SD_CPP_RELEASES.find(r => r.platform === 'win-vulkan')
  const rocm   = SD_CPP_RELEASES.find(r => r.platform === 'win-rocm')
  const cuda   = SD_CPP_RELEASES.find(r => r.platform === 'win-cuda')

  it('ships a Vulkan row', () => {
    expect(vulkan).toBeDefined()
  })

  it('pins the Vulkan asset name to the tag the registry pins', () => {
    expect(vulkan!.filename).toBe(VERIFIED['win-vulkan'].filename)
    expect(vulkan!.url).toContain(SD_CPP_VERSION)
    expect(vulkan!.url.startsWith('https://github.com/leejet/stable-diffusion.cpp/releases/download/')).toBe(true)
  })

  it('pins the Vulkan sha256 to the upstream-published digest — no placeholder', () => {
    expect(vulkan!.sha256).toBe(VULKAN_SHA)
    expect(vulkan!.sha256).not.toMatch(/__SHA_PLACEHOLDER/)
    expect(vulkan!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('needs no cudart-style companion — the Vulkan ICD ships with the driver', () => {
    expect(vulkan!.cudartUrl).toBeUndefined()
    expect(vulkan!.cudartFilename).toBeUndefined()
    expect(vulkan!.cudartSha256).toBeUndefined()
  })

  it('ships a win-rocm row pinned to an upstream digest', () => {
    expect(rocm).toBeDefined()
    expect(rocm!.filename).toBe(VERIFIED['win-rocm'].filename)
    expect(rocm!.sha256).toBe(ROCM_SHA)
    expect(rocm!.sha256).not.toMatch(/__SHA_PLACEHOLDER/)
    expect(rocm!.cudartUrl).toBeUndefined()
  })

  it('records the size gap that makes Vulkan the automatic AMD choice', () => {
    // 37 829 640 B ~ 36 MiB vs 200 234 508 B ~ 191 MiB. The gap NARROWED at
    // master-810 (rocm was 313 MiB at 782, and shipped as two builds), but
    // Vulkan is still ~5x smaller and still covers every AMD card, so the
    // auto-selection rule below is unchanged.
    expect(rocm!.filename).toContain('rocm')
    const vulkanMiB = VERIFIED['win-vulkan'].size / (1024 * 1024)
    const rocmMiB   = VERIFIED['win-rocm'].size / (1024 * 1024)
    expect(rocmMiB).toBeGreaterThan(vulkanMiB * 5)
  })

  it('does not disturb the pre-existing CUDA / CPU / macOS rows', () => {
    for (const p of ['win-cuda', 'win-cpu', 'mac-arm64'] as const) {
      expect(SD_CPP_RELEASES.some(r => r.platform === p)).toBe(true)
    }
  })

  it('pins the CUDA row and its cudart companion to the verified digests', () => {
    expect(cuda!.filename).toBe(VERIFIED['win-cuda'].filename)
    expect(cuda!.sha256).toBe(CUDA_SHA)
    expect(cuda!.cudartFilename).toBe(VERIFIED.cudart.filename)
    expect(cuda!.cudartUrl).toContain(VERIFIED.cudart.filename)
    expect(cuda!.cudartSha256).toBe(VERIFIED.cudart.sha256)
  })

  // -- THE CHECK THAT CATCHES A HALF-DONE BUMP -------------------------------
  // Asset names embed the tag's SHORT hash, and upstream renames the rocm and
  // macOS assets freely (7.1.1 -> 7.14.0, macOS-26.4 -> 26.5.2 between the last
  // two pins). Swapping only SD_CPP_VERSION leaves those rows pointing at URLs
  // that 404 — on the two platforms nobody here can install to.
  it('EVERY row names the pinned tag, so no asset can be left behind', () => {
    const shortHash = SD_CPP_VERSION.split('-').pop()!
    expect(shortHash, 'tag shape is master-<n>-<shorthash>').toMatch(/^[0-9a-f]{7,}$/)
    for (const r of SD_CPP_RELEASES) {
      expect(r.filename, `${r.platform} filename does not carry ${shortHash}`).toContain(shortHash)
      expect(r.url, `${r.platform} url`).toContain(SD_CPP_VERSION)
      expect(r.url.endsWith(r.filename), `${r.platform} url must end in its filename`).toBe(true)
    }
    // The cudart companion is versioned by CUDA, not by the sd.cpp tag — it is
    // the one asset whose name must NOT carry the hash.
    expect(cuda!.cudartFilename).not.toContain(shortHash)
  })

  it('the VERIFIED block is about the tag actually shipped', () => {
    // If this fails, SD_CPP_VERSION moved and the digests above were not
    // re-checked against the API. Re-run the GET in the file header.
    expect(VERIFIED.tag).toBe(SD_CPP_VERSION)
  })

  it('every shipped row matches its verified filename and digest', () => {
    for (const r of SD_CPP_RELEASES) {
      const v = VERIFIED[r.platform]
      expect(v, `no VERIFIED entry for ${r.platform}`).toBeDefined()
      expect(r.filename, r.platform).toBe(v.filename)
      expect(r.sha256, r.platform).toBe(v.sha256)
    }
  })

  it('leaves every shipped row with a real (non-placeholder) sha256', () => {
    for (const r of SD_CPP_RELEASES) {
      expect(r.sha256, r.platform).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('registers no Linux row', () => {
    expect(SD_CPP_RELEASES.some(r => (r.platform as string).includes('linux'))).toBe(false)
  })
})

describe('sdReleaseForBackend — the 3-way selection matrix', () => {
  it('nvidia (cuda backend) → win-cuda — the byte-identical flow for nvidia users', () => {
    expect(sdReleaseForBackend('cuda', 'win32', 'x64')).toBe('win-cuda')
  })

  it('amd (vulkan backend) → win-vulkan — the verdict that used to fall through to CPU', () => {
    expect(sdReleaseForBackend('vulkan', 'win32', 'x64')).toBe('win-vulkan')
  })

  it('intel (also a vulkan backend) → win-vulkan too — gpu-detect maps both amd+intel to vulkan', () => {
    // gpu-detect.ts:83 computes the SAME 'vulkan' backend string for amd and
    // intel — there is no separate intel branch to select differently here.
    expect(sdReleaseForBackend('vulkan', 'win32', 'x64')).toBe('win-vulkan')
  })

  it('none/unknown (cpu backend) → win-cpu', () => {
    expect(sdReleaseForBackend('cpu', 'win32', 'x64')).toBe('win-cpu')
  })

  it('never auto-selects win-rocm — it is an explicit expert choice only, like llama.cpp win-hip', () => {
    const auto = (['cuda', 'vulkan', 'metal', 'cpu'] as const)
      .map(b => sdReleaseForBackend(b, 'win32', 'x64'))
    expect(auto).not.toContain('win-rocm')
    // …but it stays reachable by platform id for a user who asks for it.
    expect(SD_CPP_RELEASES.some(r => r.platform === 'win-rocm')).toBe(true)
  })

  it('maps Apple Silicon (metal backend) to the arm64 build', () => {
    expect(sdReleaseForBackend('metal', 'darwin', 'arm64')).toBe('mac-arm64')
    // AMD/Intel eGPU on a Mac still resolves to the one mac build sd.cpp ships.
    expect(sdReleaseForBackend('vulkan', 'darwin', 'arm64')).toBe('mac-arm64')
  })

  it('returns null for Intel Mac and Linux — caller keeps its unsupported-platform message', () => {
    expect(sdReleaseForBackend('metal', 'darwin', 'x64')).toBeNull()
    expect(sdReleaseForBackend('vulkan', 'linux', 'x64')).toBeNull()
    expect(sdReleaseForBackend('cuda', 'linux', 'x64')).toBeNull()
  })

  it('only ever returns a platform id that actually exists in the registry', () => {
    for (const backend of ['cuda', 'vulkan', 'metal', 'cpu'] as const) {
      for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']] as const) {
        const id = sdReleaseForBackend(backend, platform, arch)
        if (id === null) continue
        expect(SD_CPP_RELEASES.some(r => r.platform === id), `${backend}/${platform}`).toBe(true)
      }
    }
  })
})

describe('sd-cpp-installer wiring (source) — reads gpu-detect instead of the boolean nvidia-smi probe', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/services/sd-cpp-installer.ts'), 'utf8')

  it('drops the old boolean-only nvidia-smi probe function', () => {
    expect(src).not.toMatch(/function hasNvidiaGpu/)
  })

  it('imports detectGpu from gpu-detect (the shared probe every consumer now reads)', () => {
    expect(src).toContain("from './gpu-detect'")
    expect(src).toContain('detectGpu()')
  })

  it('resolves the release through sdReleaseForBackend, not a raw cuda boolean', () => {
    expect(src).toContain('sdReleaseForBackend(backend')
  })

  it('exports isSdGpuBuildInstalled, reusing the shared marker matcher', () => {
    expect(src).toContain('export function isSdGpuBuildInstalled')
    expect(src).toContain('isGpuBuildMarker')
  })

  it('accepts an explicit platformId override for an expert install (e.g. win-rocm)', () => {
    expect(src).toMatch(/installSdCppBinary\([^)]*platformId\??:\s*SdPlatform/)
  })
})

describe('doctor-service wiring (source) — the GPU banner now checks sd.cpp too', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../electron/services/doctor-service.ts'), 'utf8')

  it('imports the sd.cpp GPU-build check alongside the llama.cpp one', () => {
    expect(src).toContain('isSdGpuBuildInstalled')
    expect(src).toContain('isSdCppInstalled')
  })

  it('names both engines in the actionable "stale build" message', () => {
    expect(src).toContain('Stable Diffusion')
    expect(src).toContain('llama.cpp')
  })

  it('does not flag an engine that was never installed as "the CPU build is installed"', () => {
    expect(src).toContain('llamaInstalled && !isGpuBuildInstalled()')
    expect(src).toContain('sdInstalled')
  })
})
