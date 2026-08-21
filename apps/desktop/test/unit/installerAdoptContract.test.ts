// apps/desktop/test/unit/installerAdoptContract.test.ts
//
// THE ADOPT CONTRACT REACHES EVERY LEGACY FALLBACK.
//
// sd-cpp got the adopt/settle wire-up in the media-fix lane; piper and whisper
// carried the IDENTICAL un-adopted fallback (dismissManagedDownload after the
// fact — the queue row sat frozen at 'error' during the live legacy transfer,
// which is exactly the stale-IO-lamp defect the driver caught). Pin that all
// three installers hand the row over, and that the after-the-fact dismiss
// idiom cannot come back.
//
// Source assertions live in their own file: downloadManagerState.test.ts mocks
// 'fs' wholesale, so reading real sources there hits the fake.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

describe('every legacy fallback adopts its managed row', () => {
  const installers = [
    ['electron/services/sd-cpp-installer.ts', 'legacyDownloadComponent'],
    ['electron/services/piper-installer.ts', 'legacyDownloadVoiceFile'],
    ['electron/services/whisper-installer.ts', 'legacyDownloadWhisperModel'],
  ] as const

  for (const [rel, legacyFn] of installers) {
    it(`${rel} adopts on chunks and settles exactly once per outcome`, () => {
      const src = read(rel)
      expect(src).toContain('adoptExternalProgress(')
      expect(src).toContain(legacyFn)
      // Both outcomes settled: failure (with the error) and success.
      expect(src).toMatch(/settleExternalDownload\([A-Za-z]+, legacyErr\)/)
      expect(src).toMatch(/settleExternalDownload\([A-Za-z]+\) \/\/ legacy landed the file/)
      // The stale-row idiom this bug lived in must not return.
      expect(src).not.toContain('dismissManagedDownload')
    })
  }

  it('whisper keeps the partial on network failure (no rmSync before the throw)', () => {
    const src = read('electron/services/whisper-installer.ts')
    const legacy = src.slice(
      src.indexOf('async function legacyDownloadWhisperModel'),
      src.indexOf('export async function downloadWhisperModel'),
    )
    // SHA-mismatch cleanup keeps its rmSync; the network-failure catch must not.
    const networkCatch = legacy.slice(
      legacy.indexOf('catch (err) { throw new Error(`Model download failed'),
      legacy.indexOf('const actual'),
    )
    expect(networkCatch.length).toBeGreaterThan(0)
    expect(networkCatch).not.toContain('rmSync')
    expect(legacy).toContain('partial kept')
  })
})
