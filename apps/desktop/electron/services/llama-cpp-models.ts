// apps/desktop/electron/services/llama-cpp-models.ts
//
// llama.cpp sidecar — release binary catalog + curated GGUF model registry.
//
// SHA verification is the Vitalik-aligned guarantee: every download is
// pinned to a known-good hash so a poisoned mirror / MitM cannot swap in
// a different model or binary without us refusing to load it.
//
// Two registries live here:
//
//   LLAMA_CPP_RELEASES   — platform-specific artifacts from
//                          https://github.com/ggml-org/llama.cpp/releases.
//                          (Repo owner renamed ggerganov -> ggml-org; old
//                          URLs 301-redirect but we use the canonical host.)
//                          Pinned to ONE upstream version (LLAMA_CPP_VERSION
//                          below) so the SHAs are stable.
//
//   GGUF_MODELS          — curated GGUF model files from HuggingFace mirrors.
//                          Each entry includes URL + SHA256 + sizeMb so the
//                          renderer can render a download progress bar AND
//                          the installer can fail-closed on hash mismatch.
//
// IMPORTANT: SHA256 placeholders below are marked with the literal string
// `__SHA_PLACEHOLDER_<asset>__`. Real SHAs must be computed against the
// pinned upstream artifact and pasted in before the first user-facing
// release. The installer service ENFORCES SHA verification unless the SHA
// equals the placeholder marker — in which case it logs a warning and
// proceeds (so the v1 ship doesn't block on hash-collection chores). When
// you collect a real SHA, replace the placeholder string entirely; the
// presence/absence of the prefix is the only thing the installer checks.
//
// Pinning policy: bump LLAMA_CPP_VERSION and ALL RELEASE SHAs together in
// the same commit. Never bump one without the others — a half-bump leaves
// a verified binary running against a different model registry's URL set.

// Upstream llama.cpp release tag pinned for v1.
// NOTE: llama.cpp publishes ~daily `bNNNN` builds. Bump deliberately and
// re-collect SHAs. Asset NAMING has changed historically (the win avx/avx2/
// noavx split collapsed into a single `win-cpu`; macOS switched .zip ->
// .tar.gz; CUDA dropped the `cu` prefix: `cuda-cu12.4` -> `cuda-12.4`), so
// when bumping, re-verify exact asset filenames against the GitHub release.
export const LLAMA_CPP_VERSION = 'b10054'

/** Platform-specific release-asset catalog. */
export interface LlamaCppReleaseAsset {
  /** Stable id used by callers to select an asset. */
  id: 'win-cuda' | 'win-vulkan' | 'win-hip' | 'win-avx' | 'macos-arm64'
  /** Human label for the renderer to display. */
  label: string
  /** Asset filename on GitHub releases (relative to release URL). */
  filename: string
  /** Full download URL. */
  url: string
  /** SHA256 hash of the zip artifact, lowercase hex. */
  sha256: string
  /** Approximate uncompressed binary size (MB) — for progress UX. */
  sizeMb: number
  /** Which platform this asset targets (matches process.platform). */
  platform: NodeJS.Platform
  /** Whether this asset requires a CUDA-capable NVIDIA GPU. */
  needsCuda: boolean
  /** Archive container — drives the extraction strategy in the installer.
   *  Windows assets are .zip; macOS switched to .tar.gz. */
  archiveKind: 'zip' | 'tar.gz'
  /** CUDA runtime companion. The main `win-cuda` zip ships the llama
   *  binaries ONLY; the CUDA runtime DLLs (cudart64_12.dll, cublas*, etc.)
   *  live in a SEPARATE asset. Without them llama-server.exe fails to start
   *  with a missing-DLL error. The installer downloads + extracts these
   *  alongside the binary for CUDA builds. Undefined for non-CUDA assets. */
  cudartFilename?: string
  cudartUrl?: string
  cudartSha256?: string
}

const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`

export const LLAMA_CPP_RELEASES: readonly LlamaCppReleaseAsset[] = [
  {
    id:           'win-cuda',
    label:        'Windows · CUDA 12.4 (NVIDIA GPU)',
    filename:     `llama-${LLAMA_CPP_VERSION}-bin-win-cuda-12.4-x64.zip`,
    url:          `${RELEASE_BASE}/llama-${LLAMA_CPP_VERSION}-bin-win-cuda-12.4-x64.zip`,
    sha256:       '803c826a00606742f35602cc98c38b4e3329924af6068ce04d81bc92dc54ce1d',
    sizeMb:       40,
    platform:     'win32',
    needsCuda:    true,
    archiveKind:  'zip',
    // CUDA runtime DLLs ship separately — required or llama-server won't start.
    cudartFilename: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
    cudartUrl:      `${RELEASE_BASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
    cudartSha256:   '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
  },
  // ── Alternate GPU backends (BATCH D / R12) ──────────────────────────────────
  // Every Radeon / Arc / iGPU owner was silently CPU-only: gpu-detect.ts has
  // computed `backend: 'vulkan'` for AMD + Intel since it was written, and
  // NOTHING in the registry could serve that verdict — the only GPU row was
  // CUDA. doctor-service even told those users to install "the VULKAN build".
  //
  // Both rows below were verified LIVE against the GitHub release API for the
  // pinned tag (2026-07-27): the asset exists, `size` is quoted verbatim, and
  // `sha256` is the release's own published `digest` — not a hash we computed
  // from a download and asked you to trust. Re-verify with:
  //   GET https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<tag>
  {
    id:          'win-vulkan',
    label:       'Windows · Vulkan (AMD / Intel / any GPU)',
    filename:    `llama-${LLAMA_CPP_VERSION}-bin-win-vulkan-x64.zip`,
    url:         `${RELEASE_BASE}/llama-${LLAMA_CPP_VERSION}-bin-win-vulkan-x64.zip`,
    // Upstream digest, asset size 32 788 387 B.
    sha256:      '994e46d71dfc089c069f6b7b3c4d22c1b102a0defb2ce661ad163721eca43282',
    sizeMb:      31,
    platform:    'win32',
    needsCuda:   false,
    archiveKind: 'zip',
    // No runtime companion: the Vulkan build links against the ICD loader that
    // ships with the GPU driver, so there is no cudart-style second download.
  },
  {
    id:          'win-hip',
    label:       'Windows · ROCm/HIP (Radeon, expert)',
    filename:    `llama-${LLAMA_CPP_VERSION}-bin-win-hip-radeon-x64.zip`,
    url:         `${RELEASE_BASE}/llama-${LLAMA_CPP_VERSION}-bin-win-hip-radeon-x64.zip`,
    // Upstream digest, asset size 319 846 770 B — ~10x the Vulkan build, which
    // is why Vulkan (and not this) is what an AMD GPU auto-resolves to. Kept as
    // an explicit expert choice only.
    sha256:      '0b164fad6f95d97082497e7f5657c0b56af5816cba808d45857d1e84c874f65e',
    sizeMb:      305,
    platform:    'win32',
    needsCuda:   false,
    archiveKind: 'zip',
  },
  {
    id:          'win-avx',
    label:       'Windows · CPU (x64)',
    // Upstream collapsed the avx/avx2/avx512/noavx split into a single
    // `win-cpu` build. Id kept as 'win-avx' for backward-compat with callers.
    filename:    `llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
    url:         `${RELEASE_BASE}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
    sha256:      '5801980ae267310e2f2cb4bd4d1795718ee7b600a2a17d0a9320a601c8979bde',
    sizeMb:      20,
    platform:    'win32',
    needsCuda:   false,
    archiveKind: 'zip',
  },
  {
    id:          'macos-arm64',
    label:       'macOS · Apple Silicon (arm64)',
    filename:    `llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
    url:         `${RELEASE_BASE}/llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
    sha256:      'e146b62222c6702fb588aec209542e66d7d6eb11160ef8240345e71877df6393',
    sizeMb:      25,
    platform:    'darwin',
    needsCuda:   false,
    archiveKind: 'tar.gz',
  },
] as const

/**
 * Resolve the preferred release asset for the current process.
 *
 * Windows: prefers CUDA if the user has it, otherwise falls back to AVX
 * (the renderer can override this by passing an explicit assetId to the
 * installer if it has more info — defaultReleaseAsset() just picks a
 * sensible default per platform with NO GPU probing).
 *
 * Linux is intentionally not in the registry — we surface a clear "manual
 * install" message via getUnsupportedPlatformMessage() instead.
 */
export function defaultReleaseAsset(): LlamaCppReleaseAsset | null {
  if (process.platform === 'win32') {
    // Default to CPU/AVX so we don't surprise users without CUDA. The
    // renderer should explicitly select 'win-cuda' when the user opts in.
    return LLAMA_CPP_RELEASES.find(a => a.id === 'win-avx') ?? null
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return LLAMA_CPP_RELEASES.find(a => a.id === 'macos-arm64') ?? null
  }
  return null
}

/** Lookup by id with a typed return. Returns null on unknown id. */
export function getReleaseAsset(id: string): LlamaCppReleaseAsset | null {
  return LLAMA_CPP_RELEASES.find(a => a.id === id) ?? null
}

/**
 * Map a DETECTED GPU backend (gpu-detect.ts `GpuBackend`) to the release we
 * should recommend for this platform. Pure — no probing, no I/O — so the whole
 * 3-way selection is assertable in a unit test instead of only on hardware.
 *
 * Contract:
 *   cuda   → win-cuda    (NVIDIA; cudart companion handled by the installer)
 *   vulkan → win-vulkan  (AMD + Intel + iGPU — one 31 MB asset covers all)
 *   metal  → macos-arm64 (Apple Silicon; Metal is built into that binary)
 *   cpu    → the platform default
 *
 * `win-hip` is deliberately NOT reachable from a detected backend: at ~305 MB
 * against Vulkan's 31 MB, it is an explicit expert choice, never an automatic
 * one. It stays selectable by passing its id to the installer directly.
 *
 * Returns null when the platform has no matching asset at all (Linux), so the
 * caller keeps its existing "unsupported platform" message instead of pointing
 * at a Windows zip.
 */
export function releaseIdForBackend(
  backend: 'cuda' | 'metal' | 'vulkan' | 'cpu',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LlamaCppReleaseAsset['id'] | null {
  const has = (id: LlamaCppReleaseAsset['id']): LlamaCppReleaseAsset['id'] | null =>
    LLAMA_CPP_RELEASES.some(a => a.id === id && a.platform === platform) ? id : null

  if (platform === 'win32') {
    if (backend === 'cuda')   return has('win-cuda') ?? has('win-avx')
    if (backend === 'vulkan') return has('win-vulkan') ?? has('win-avx')
    return has('win-avx')
  }
  if (platform === 'darwin' && arch === 'arm64') return has('macos-arm64')
  return null
}

/** Human-readable hint for platforms we don't ship binaries for in v1. */
export function getUnsupportedPlatformMessage(): string {
  if (process.platform === 'linux') {
    return [
      'llama.cpp prebuilt binaries are not shipped for Linux in v1.',
      'Install manually: clone https://github.com/ggml-org/llama.cpp,',
      '`cmake -B build && cmake --build build --target llama-server`,',
      'then point Tachi at the resulting binary in Settings → llama.cpp.',
    ].join(' ')
  }
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    return [
      'llama.cpp prebuilt binaries for Intel Mac are not shipped in v1.',
      'Use the Apple Silicon build manually or install via Homebrew',
      '(`brew install llama.cpp`).',
    ].join(' ')
  }
  return `llama.cpp is not supported on ${process.platform}/${process.arch} in v1.`
}

// ─── Curated GGUF model registry ─────────────────────────────────────────────
//
// Each entry is verified-and-pinned. The user picks one from the renderer,
// the installer downloads it, hash-verifies, and parks it under
// userData/llama-cpp/models/<id>.gguf.
//
// Selection criteria:
//   - covers normies (small/fast Phi/Qwen 3B-Q4) → power users (Llama 8B Q4)
//   - all available on HuggingFace under TheBloke / lmstudio-community /
//     bartowski / unsloth (long-lived community uploaders)
//   - quantization defaults to Q4_K_M (best size/quality tradeoff for chat
//     on consumer hardware; Q6_K offered for users with more RAM)
//   - recommendedRamGb is conservative (model size × 1.3 to leave context
//     headroom)
//
// SHA placeholders use the same `__SHA_PLACEHOLDER_<id>__` convention as
// releases. Real SHAs to be collected before user-facing v1 release.

export type GgufFamily = 'qwen' | 'llama' | 'mistral' | 'deepseek' | 'phi' | 'gemma'

export interface GgufModel {
  /** Stable id (kebab-case). */
  id: string
  /** Human label. */
  label: string
  family: GgufFamily
  /** Parameter count in billions (display only). */
  paramsB: number
  /** Quantization label (Q4_K_M, Q5_K_S, etc). */
  quant: string
  /** Direct download URL (HuggingFace resolve URL). */
  url: string
  /** SHA256 hash of the .gguf file, lowercase hex. */
  sha256: string
  /** File size in MB — for progress UX and disk-space check. */
  sizeMb: number
  /** Context window in K tokens. */
  contextK: number
  /** Conservative RAM recommendation (GB). */
  recommendedRamGb: number
}

export const GGUF_MODELS: readonly GgufModel[] = [
  // ── Phi-3 Mini (3.8B) — smallest practical chat model ──────────────────────
  {
    id:               'phi-3-mini-4k-instruct-q4',
    label:            'Phi-3 Mini 3.8B Instruct (Q4_K_M)',
    family:           'phi',
    paramsB:          3.8,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Phi-3.1-mini-4k-instruct-GGUF/resolve/main/Phi-3.1-mini-4k-instruct-Q4_K_M.gguf',
    sha256:           'd6d25bf078321bea4a079c727b273cb0b5a2e0b4cf3add0f7a2c8e43075c414f',
    sizeMb:           2400,
    contextK:         4,
    recommendedRamGb: 6,
  },
  // ── Qwen2.5 3B — multilingual, strong for size ─────────────────────────────
  {
    id:               'qwen2.5-3b-instruct-q4',
    label:            'Qwen2.5 3B Instruct (Q4_K_M)',
    family:           'qwen',
    paramsB:          3,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    sha256:           '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
    sizeMb:           2000,
    contextK:         32,
    recommendedRamGb: 6,
  },
  // ── Qwen2.5 7B — flagship 7B class, very strong for general chat ──────────
  {
    id:               'qwen2.5-7b-instruct-q4',
    label:            'Qwen2.5 7B Instruct (Q4_K_M)',
    family:           'qwen',
    paramsB:          7,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    sha256:           '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    sizeMb:           4700,
    contextK:         32,
    recommendedRamGb: 8,
  },
  // ── Qwen2.5 Coder 7B — best small code model ──────────────────────────────
  {
    id:               'qwen2.5-coder-7b-instruct-q4',
    label:            'Qwen2.5 Coder 7B Instruct (Q4_K_M)',
    family:           'qwen',
    paramsB:          7,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    sha256:           '1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6',
    sizeMb:           4700,
    contextK:         32,
    recommendedRamGb: 8,
  },
  // ── Llama 3.1 8B Instruct — Meta's most popular open chat model ───────────
  {
    id:               'llama-3.1-8b-instruct-q4',
    label:            'Llama 3.1 8B Instruct (Q4_K_M)',
    family:           'llama',
    paramsB:          8,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sha256:           '7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c',
    sizeMb:           4900,
    contextK:         128,
    recommendedRamGb: 10,
  },
  // ── Llama 3.2 3B Instruct — small, fast, multi-lingual ────────────────────
  {
    id:               'llama-3.2-3b-instruct-q4',
    label:            'Llama 3.2 3B Instruct (Q4_K_M)',
    family:           'llama',
    paramsB:          3.2,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sha256:           '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    sizeMb:           2000,
    contextK:         128,
    recommendedRamGb: 5,
  },
  // ── Llama 3.2 1B Instruct — extremely small, runs anywhere ────────────────
  {
    id:               'llama-3.2-1b-instruct-q4',
    label:            'Llama 3.2 1B Instruct (Q4_K_M)',
    family:           'llama',
    paramsB:          1,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sha256:           '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    sizeMb:           770,
    contextK:         128,
    recommendedRamGb: 3,
  },
  // ── Mistral 7B Instruct v0.3 — battle-tested 7B chat baseline ─────────────
  {
    id:               'mistral-7b-instruct-v0.3-q4',
    label:            'Mistral 7B Instruct v0.3 (Q4_K_M)',
    family:           'mistral',
    paramsB:          7,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sha256:           '1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6',
    sizeMb:           4400,
    contextK:         32,
    recommendedRamGb: 8,
  },
  // ── Mistral Nemo 12B — strong larger Mistral, more headroom for reasoning ─
  {
    id:               'mistral-nemo-12b-instruct-q4',
    label:            'Mistral Nemo 12B Instruct (Q4_K_M)',
    family:           'mistral',
    paramsB:          12,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf',
    sha256:           '7c1a10d202d8788dbe5628dc962254d10654c853cae6aaeca0618f05490d4a46',
    sizeMb:           7400,
    contextK:         128,
    recommendedRamGb: 12,
  },
  // ── DeepSeek-Coder-V2-Lite 16B Instruct — MoE; very strong coding model ───
  {
    id:               'deepseek-coder-v2-lite-instruct-q4',
    label:            'DeepSeek-Coder-V2-Lite 16B Instruct (Q4_K_M)',
    family:           'deepseek',
    paramsB:          16,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/resolve/main/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    sha256:           '603bd3f8a0281d16571da7c08bd661ee17ff0d1be6fcbd1b42242da257ef0bb8',
    sizeMb:           10400,
    contextK:         128,
    recommendedRamGb: 16,
  },
  // ── Gemma 2 9B Instruct — Google's competitive 9B baseline ────────────────
  {
    id:               'gemma-2-9b-instruct-q4',
    label:            'Gemma 2 9B Instruct (Q4_K_M)',
    family:           'gemma',
    paramsB:          9,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
    sha256:           '13b2a7b4115bbd0900162edcebe476da1ba1fc24e718e8b40d32f6e300f56dfe',
    sizeMb:           5800,
    contextK:         8,
    recommendedRamGb: 10,
  },
  // ── Gemma 2 2B Instruct — smallest Gemma; very fast ──────────────────────
  {
    id:               'gemma-2-2b-instruct-q4',
    label:            'Gemma 2 2B Instruct (Q4_K_M)',
    family:           'gemma',
    paramsB:          2,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
    sha256:           'e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787',
    sizeMb:           1700,
    contextK:         8,
    recommendedRamGb: 4,
  },
  // ── Phi-3 Medium 14B 4k Instruct ──────────────────────────────────────────
  {
    id:               'phi-3-medium-14b-4k-instruct-q4',
    label:            'Phi-3 Medium 14B Instruct (Q4_K_M)',
    family:           'phi',
    paramsB:          14,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Phi-3-medium-4k-instruct-GGUF/resolve/main/Phi-3-medium-4k-instruct-Q4_K_M.gguf',
    sha256:           '6f05c97bc676dd1ec8d58e9a8795b4f5c809db771f6fc7bf48634c805face82c',
    sizeMb:           8400,
    contextK:         4,
    recommendedRamGb: 14,
  },
  // ── Qwen2.5 14B Instruct — power-user general-purpose ────────────────────
  {
    id:               'qwen2.5-14b-instruct-q4',
    label:            'Qwen2.5 14B Instruct (Q4_K_M)',
    family:           'qwen',
    paramsB:          14,
    quant:            'Q4_K_M',
    url:              'https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    sha256:           'e47ad95dad6ff848b431053b375adb5d39321290ea2c638682577dafca87c008',
    sizeMb:           8900,
    contextK:         32,
    recommendedRamGb: 14,
  },
] as const

/** Lookup helper. Returns null when id is unknown. */
export function getGgufModel(id: string): GgufModel | null {
  return GGUF_MODELS.find(m => m.id === id) ?? null
}

/** True when the SHA still holds the literal placeholder (skip enforcement). */
export function isShaPlaceholder(sha256: string): boolean {
  return sha256.startsWith('__SHA_PLACEHOLDER_')
}

// ─── VRAM-aware fit annotation ───────────────────────────────────────────────
//
// Annotate the curated GGUF registry against detected hardware so the renderer
// can show a "will it fit" badge per model. The math lives in the pure util
// module (services/util/model-fit) — this layer only turns a HardwareProfile
// into a {vramGb, ramGb} budget and maps each entry's params/quant/context onto
// it. Best-effort: when the snapshot is absent the annotation is omitted and
// the renderer degrades to its size-bytes heuristic.

import type { HardwareProfile } from '@tachi/core'
import {
  estimateModelVramGb,
  fitVerdict,
  type ModelFitVerdict,
} from './util/model-fit'

const BYTES_PER_GB = 1024 * 1024 * 1024

/** A GGUF registry entry with its computed fit verdict against the hardware. */
export interface AnnotatedGgufModel extends GgufModel {
  fitVerdict: ModelFitVerdict
  fitReason: string
  /** Estimated memory required to serve this model (GB). */
  estVramGb: number
}

/** Convert a HardwareProfile into a GB budget for the fit estimator. */
function budgetFromHardware(hw: HardwareProfile): { vramGb: number; ramGb: number } {
  const vramGb = hw.vramFreeBytes && hw.vramFreeBytes > 0 ? hw.vramFreeBytes / BYTES_PER_GB : 0
  // Free RAM is the honest serving budget (the model competes with everything
  // else already resident); fall back to total if the probe couldn't read free.
  const ramBytes = hw.ramFreeBytes > 0 ? hw.ramFreeBytes : hw.ramTotalBytes
  const ramGb = ramBytes > 0 ? ramBytes / BYTES_PER_GB : 0
  return { vramGb, ramGb }
}

/**
 * Annotate the curated GGUF models with a fit verdict for the given hardware.
 * Pass a subset (defaults to the full GGUF_MODELS registry) to annotate just
 * those. The context estimate uses each model's own contextK (capped at 8K so
 * a 128K-context model isn't penalized for headroom it won't use by default).
 */
export function annotateGgufFit(
  hw: HardwareProfile,
  models: readonly GgufModel[] = GGUF_MODELS,
): AnnotatedGgufModel[] {
  const budget = budgetFromHardware(hw)
  return models.map(m => {
    const contextLen = Math.min(m.contextK, 8) * 1024
    const estVramGb = estimateModelVramGb({ paramsB: m.paramsB, quant: m.quant, contextLen })
    const { verdict, reason } = fitVerdict(estVramGb, budget)
    return { ...m, fitVerdict: verdict, fitReason: reason, estVramGb: Math.round(estVramGb * 10) / 10 }
  })
}
