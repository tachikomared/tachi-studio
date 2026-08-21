// apps/desktop/test/unit/mediaLocalDownloadFailures.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 1C, bug 2 — SWALLOWED DOWNLOAD FAILURES.
//
// `sd-cpp:download-speed-adapter` and `piper:download-voice` RESOLVE with
// `{ ok:false, error }` on failure — like `sd-cpp:download-model` — they
// never reject. The speed-pack and voice buttons still fired them with a bare
// `.catch(() => {})`, which only ever catches a REJECTION: a bad id, a 404 on
// the asset, a full disk all landed exactly like success, and the progress
// line stayed parked on "downloading…" forever with nothing on screen.
//
// downloadSdRow already had this right (rows5 driver finding, upstream of
// this lane). downloadRowFailureText is the shared check it and the two new
// handlers (downloadVoiceRow / downloadSpeedPackRow) now all read the same
// way: inspect the RESOLUTION, not just catch what it never throws.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { downloadRowFailureText } from '../../src/pages/media/MediaPage'

describe('downloadRowFailureText — a resolved {ok:false} is a failure too', () => {
  it('is null on a successful resolution', () => {
    expect(downloadRowFailureText({ ok: true }, 'fallback')).toBeNull()
  })

  it('is null when the IPC sent nothing at all (undefined/null)', () => {
    expect(downloadRowFailureText(undefined, 'fallback')).toBeNull()
    expect(downloadRowFailureText(null, 'fallback')).toBeNull()
  })

  it('is null when ok is simply absent (not explicitly false)', () => {
    expect(downloadRowFailureText({}, 'fallback')).toBeNull()
  })

  it('returns the trimmed error text on ok:false', () => {
    expect(downloadRowFailureText({ ok: false, error: '  disk full  ' }, 'fallback')).toBe('disk full')
  })

  it('falls back when ok:false carries no usable error string', () => {
    expect(downloadRowFailureText({ ok: false }, 'fallback')).toBe('fallback')
    expect(downloadRowFailureText({ ok: false, error: '' }, 'fallback')).toBe('fallback')
    expect(downloadRowFailureText({ ok: false, error: '   ' }, 'fallback')).toBe('fallback')
  })
})

// ── Source-assertion: the dead fire-and-forget pattern must be GONE ─────────
//
// Pinned the way mediaLocalModelTruth.test.ts pins its wiring facts: the two
// button sites named in the audit (piper voice download, sd speed-adapter
// download) must route through a handler that calls downloadRowFailureText
// (or an equivalent ok-check) rather than the bare `.catch(() => {})` that
// discarded a resolved failure.

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

describe('MediaPage.tsx source — the swallowed .catch(() => {}) is gone from both buttons', () => {
  const src = read('src/pages/media/MediaPage.tsx')

  it('no longer fires piper.downloadVoice with a bare swallowed catch', () => {
    expect(src).not.toMatch(/window\.tachi\.piper\.downloadVoice\([^)]*\)\.catch\(\(\)\s*=>\s*\{\}\)/)
  })

  it('no longer fires sdCpp.downloadSpeedAdapter with a bare swallowed catch', () => {
    expect(src).not.toMatch(/window\.tachi\.sdCpp\.downloadSpeedAdapter\([^)]*\)\.catch\(\(\)\s*=>\s*\{\}\)/)
  })

  it('the voice button now calls downloadVoiceRow, which inspects the resolution', () => {
    expect(src).toContain('void downloadVoiceRow(v.id, v.name)')
    expect(src).toMatch(/downloadVoiceRow = useCallback\(async \(id: string, name: string\) => \{[\s\S]{0,400}downloadRowFailureText/)
  })

  it('the speed-pack button now calls downloadSpeedPackRow, which inspects the resolution', () => {
    expect(src).toContain('void downloadSpeedPackRow(pack.id, pack.name)')
    expect(src).toMatch(/downloadSpeedPackRow = useCallback\(async \(id: string, name: string\) => \{[\s\S]{0,400}downloadRowFailureText/)
  })

  it('every failure path clears the progress line and toasts — never a silent stall', () => {
    for (const fn of ['downloadVoiceRow', 'downloadSpeedPackRow']) {
      const re = new RegExp(`const ${fn} = useCallback\\(async[\\s\\S]{0,700}?\\}, \\[t\\]\\)`)
      const body = src.match(re)?.[0] ?? ''
      expect(body, `${fn} body not found`).not.toBe('')
      expect(body).toContain('setSdProgress(null)')
      expect(body).toContain("showToast({ kind: 'error'")
      expect(body).toContain('refreshSdPanel.current()')
    }
  })
})
