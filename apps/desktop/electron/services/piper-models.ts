// apps/desktop/electron/services/piper-models.ts
//
// Pinned registries for the piper LOCAL text-to-speech sidecar.
//   - PIPER_RELEASES: prebuilt piper binary per platform (self-contained — the
//     archive bundles espeak-ng-data + libs next to the executable).
//   - PIPER_VOICES: curated ONNX voices (rhasspy/piper-voices). Each voice is a
//     `.onnx` + `.onnx.json` pair — tiny (~20-65 MB), CPU-fast. This is the
//     "light install, works right away" engine.
//
// SHA policy mirrors the other sidecars: ship `__SHA_PLACEHOLDER_<id>__`; the
// installer SKIPS verification on a placeholder (logs the observed SHA). Pinning
// real SHAs is optional release hardening, NOT required to use it.

export const PIPER_VERSION = '2023.11.14-2'
const REL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`

export type PiperPlatform = 'win' | 'mac-arm64' | 'mac-x64'
export interface PiperRelease { platform: PiperPlatform; filename: string; url: string; sha256: string }

export const PIPER_RELEASES: PiperRelease[] = [
  { platform: 'win',       filename: 'piper_windows_amd64.zip',   url: `${REL}/piper_windows_amd64.zip`,   sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea' },
  { platform: 'mac-arm64', filename: 'piper_macos_aarch64.tar.gz', url: `${REL}/piper_macos_aarch64.tar.gz`, sha256: '6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc' },
  { platform: 'mac-x64',   filename: 'piper_macos_x64.tar.gz',     url: `${REL}/piper_macos_x64.tar.gz`,     sha256: 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b' },
]

export interface PiperVoice {
  id:        string   // piper voice id, e.g. 'en_US-amy-medium'
  name:      string
  lang:      string
  quality:   'low' | 'medium' | 'high'
  /**
   * WHOLE-VOICE download size in MEBIbytes (MiB), i.e. `ceil((onnx + onnx.json)
   * / 1_048_576)` — the `.onnx` weight plus its few-KB config sidecar.
   *
   * This is NOT a cosmetic number: piper-installer feeds
   * `Math.round(sizeMb * 1_048_576)` to the download manager as
   * `approxTotalBytes`, which is what the DISK PREFLIGHT reserves against, and
   * catalog-service/catalog.store turn the same field into the row's size chip.
   * Under-declaring starts a download onto a volume that may not hold it —
   * the exact failure the preflight exists to prevent.
   *
   * Pinned by test/unit/speechModelSizes.test.ts against the measurement table
   * below. Re-measure whenever a URL is repointed.
   */
  sizeMb:    number
  onnxUrl:   string
  onnxSha:   string
  configUrl: string   // the .onnx.json sidecar (must sit next to the .onnx)
  configSha: string
}

// Curated starter voices (US English). HF URL layout:
//   <base>/<lang>/<lang_REGION>/<name>/<quality>/<lang_REGION>-<name>-<quality>.onnx[.json]
//
// MEASURED 2026-07-27 by HEAD + redirect on every URL below (Content-Length of
// the 200 response; the 302's `X-Linked-Size` agreed on all three `.onnx` files
// and every `X-Linked-ETag` equalled the sha256 pinned here — so these URLs
// still serve the pinned bytes, only the DECLARED SIZE was wrong):
//
//   voice                 .onnx bytes   .onnx.json   total      MiB      sizeMb
//   en_US-amy-medium       63_201_294        4_882  63_206_176  60.278      61
//   en_US-lessac-medium    63_201_294        4_885  63_206_179  60.278      61
//   en_US-amy-low          63_104_526        4_164  63_108_690  60.185      61
//
// `en_US-amy-low` declared 28 MB for a 60.2 MiB file — a 2.15x under-declaration
// of the same class as the sd-turbo one (see sdModelSizes.test.ts). The "low"
// quality tier is a SYNTHESIS-quality tier, not a smaller file: all three of
// these voices are within 100 KB of each other, so the old name's "smallest"
// claim went with it.
const V = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
export const PIPER_VOICES: PiperVoice[] = [
  {
    id: 'en_US-amy-medium', name: 'Amy — US English (medium)', lang: 'en_US', quality: 'medium', sizeMb: 61,
    onnxUrl:   `${V}/en/en_US/amy/medium/en_US-amy-medium.onnx`,        onnxSha:   'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18',
    configUrl: `${V}/en/en_US/amy/medium/en_US-amy-medium.onnx.json`,   configSha: '95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77',
  },
  {
    id: 'en_US-lessac-medium', name: 'Lessac — US English (medium)', lang: 'en_US', quality: 'medium', sizeMb: 61,
    onnxUrl:   `${V}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`,      onnxSha:   '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    configUrl: `${V}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`, configSha: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
  },
  {
    id: 'en_US-amy-low', name: 'Amy — US English (low quality)', lang: 'en_US', quality: 'low', sizeMb: 61,
    onnxUrl:   `${V}/en/en_US/amy/low/en_US-amy-low.onnx`,        onnxSha:   'a5a91abb7de0f104358a25aded480ddacf1ff0762886325886ec406a2e86aab3',
    configUrl: `${V}/en/en_US/amy/low/en_US-amy-low.onnx.json`,   configSha: '2250a9a605b8dc35a116717fadc5056695dd809e34a15d02f72a0f52d53d3ebb',
  },
]

export function isPiperShaPlaceholder(sha: string): boolean {
  return /^__SHA_PLACEHOLDER_.*__$/.test(sha)
}

export function findPiperVoice(id: string): PiperVoice | undefined {
  return PIPER_VOICES.find(v => v.id === id)
}

/** Pick the piper release for this platform. Windows + macOS only (mirror the
 *  other sidecars); Linux not shipped in P3. */
export function defaultPiperRelease(platform: NodeJS.Platform, arch: string): PiperRelease | null {
  if (platform === 'win32') return PIPER_RELEASES.find(r => r.platform === 'win') ?? null
  if (platform === 'darwin') return PIPER_RELEASES.find(r => r.platform === (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')) ?? null
  return null
}
