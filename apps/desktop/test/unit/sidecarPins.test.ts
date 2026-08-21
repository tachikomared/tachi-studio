// apps/desktop/test/unit/sidecarPins.test.ts
//
// Sidecar binary pin invariants — llama.cpp + sd.cpp release registries.
// These guard the "bump version + SHAs TOGETHER" pinning policy:
//   - version constants keep their upstream tag shape
//   - every release asset filename embeds the pinned version / short-hash
//     (so a half-bump that changes the constant but not a hard-coded
//     filename fails here instead of 404ing at install time)
//   - every SHA is a real lowercase-hex sha256 (placeholders fail closed
//     in packaged builds — none may ship)
//   - all SHAs are pairwise distinct (catches the copy-paste bug where the
//     win-cuda zip and its cudart companion shared one hash)
// Whisper's registry has its own coverage in whisper.test.ts.

import { describe, it, expect } from 'vitest'

import { LLAMA_CPP_RELEASES, LLAMA_CPP_VERSION, isShaPlaceholder } from '../../electron/services/llama-cpp-models'
import { SD_CPP_RELEASES, SD_CPP_VERSION, isShaPlaceholder as isSdShaPlaceholder } from '../../electron/services/sd-cpp-models'

const SHA256_RE = /^[0-9a-f]{64}$/

describe('llama.cpp release pins', () => {
  it('version constant is an upstream bNNNN build tag', () => {
    expect(LLAMA_CPP_VERSION).toMatch(/^b\d{4,}$/)
  })

  it('every asset filename + url embeds the pinned version', () => {
    for (const a of LLAMA_CPP_RELEASES) {
      expect(a.filename).toContain(LLAMA_CPP_VERSION)
      expect(a.url).toContain(`/releases/download/${LLAMA_CPP_VERSION}/`)
      expect(a.url.endsWith(a.filename)).toBe(true)
    }
  })

  it('every SHA (incl. cudart) is real hex — no placeholders ship', () => {
    for (const a of LLAMA_CPP_RELEASES) {
      expect(isShaPlaceholder(a.sha256)).toBe(false)
      expect(a.sha256).toMatch(SHA256_RE)
      if (a.cudartUrl) {
        expect(a.cudartSha256).toMatch(SHA256_RE)
        expect(a.cudartFilename).toBeTruthy()
      }
    }
  })

  it('all SHAs are pairwise distinct (zip vs cudart copy-paste guard)', () => {
    const shas = LLAMA_CPP_RELEASES.flatMap(a => [a.sha256, ...(a.cudartSha256 ? [a.cudartSha256] : [])])
    expect(new Set(shas).size).toBe(shas.length)
  })
})

describe('sd.cpp release pins', () => {
  it('version constant is an upstream master-NNN-<shorthash> tag', () => {
    expect(SD_CPP_VERSION).toMatch(/^master-\d+-[0-9a-f]{7}$/)
  })

  it('every asset filename + url embeds the pinned short hash', () => {
    const shortHash = SD_CPP_VERSION.split('-')[2]
    for (const r of SD_CPP_RELEASES) {
      // sd-cli archives embed the short hash; the cudart companion does not.
      expect(r.filename).toContain(shortHash)
      expect(r.url).toContain(`/releases/download/${SD_CPP_VERSION}/`)
      expect(r.url.endsWith(r.filename)).toBe(true)
      if (r.cudartUrl) expect(r.cudartUrl.endsWith(r.cudartFilename!)).toBe(true)
    }
  })

  it('every SHA (incl. cudart) is real hex — no placeholders ship', () => {
    for (const r of SD_CPP_RELEASES) {
      expect(isSdShaPlaceholder(r.sha256)).toBe(false)
      expect(r.sha256).toMatch(SHA256_RE)
      if (r.cudartSha256) expect(r.cudartSha256).toMatch(SHA256_RE)
    }
  })

  it('all SHAs are pairwise distinct (zip vs cudart copy-paste guard)', () => {
    const shas = SD_CPP_RELEASES.flatMap(r => [r.sha256, ...(r.cudartSha256 ? [r.cudartSha256] : [])])
    expect(new Set(shas).size).toBe(shas.length)
  })
})
