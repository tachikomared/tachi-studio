// apps/desktop/test/unit/mediaLocalDownloadKindFilter.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 1C, bug 3 — THE DOWNLOAD PANEL MIXES IMAGE AND
// VIDEO ROWS.
//
// `sd-cpp:catalog` tags every row `kind: 'image' | 'video'`; the renderer's
// setSdModels dropped it on the floor, so the DOWNLOAD MODEL panel rendered
// every curated row under every modality — a Wan checkpoint's button sat
// under IMAGE, an SDXL row sat under VIDEO, regardless of which tab was
// active.
//
// isSdDownloadRowVisible is the filter predicate: a row of the ACTIVE
// modality's kind always shows; a row of the OTHER kind shows ONLY while its
// own download is genuinely in flight or interrupted (never merely
// installed-and-idle) — hiding an in-progress row would orphan a transfer the
// user is mid-way through paying for.
//
// shouldFlipModalityOnDownloadDone answers the follow-up: once that
// other-kind download finishes, the user asked for e.g. a video model while
// looking at IMAGE — they should be shown VIDEO, not left staring at the tab
// they happened to be on.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isSdDownloadRowVisible, shouldFlipModalityOnDownloadDone } from '../../src/pages/media/MediaPage'

describe('isSdDownloadRowVisible', () => {
  it('always shows a row whose kind matches the active modality', () => {
    expect(isSdDownloadRowVisible('image', 'image', 'download', false)).toBe(true)
    expect(isSdDownloadRowVisible('video', 'video', 'installed', false)).toBe(true)
    expect(isSdDownloadRowVisible('image', 'image', 'resume', false)).toBe(true)
  })

  it('hides an other-kind row that is merely installed and idle — the bug', () => {
    expect(isSdDownloadRowVisible('video', 'image', 'installed', false)).toBe(false)
  })

  it('hides an other-kind row with a virgin download state — no reason to show it', () => {
    expect(isSdDownloadRowVisible('video', 'image', 'download', false)).toBe(false)
  })

  it('keeps an other-kind row that is INTERRUPTED (resume) — do not orphan the partial', () => {
    expect(isSdDownloadRowVisible('video', 'image', 'resume', false)).toBe(true)
  })

  it('keeps an other-kind row that is ACTIVELY downloading right now', () => {
    expect(isSdDownloadRowVisible('video', 'image', 'download', true)).toBe(true)
    expect(isSdDownloadRowVisible('video', 'image', 'installed', true)).toBe(true)
  })

  it('never hides a same-kind row regardless of activity flags', () => {
    for (const state of ['installed', 'resume', 'download'] as const) {
      for (const active of [true, false]) {
        expect(isSdDownloadRowVisible('image', 'image', state, active)).toBe(true)
      }
    }
  })
})

describe('shouldFlipModalityOnDownloadDone', () => {
  it('is null when nothing was tracked as downloading', () => {
    expect(shouldFlipModalityOnDownloadDone(null, 'image')).toBeNull()
  })

  it('is null when the finished download matches the active modality already', () => {
    expect(shouldFlipModalityOnDownloadDone({ id: 'sd-turbo', kind: 'image' }, 'image')).toBeNull()
  })

  it('flips to the finished row\'s kind when it differs from the active modality', () => {
    expect(shouldFlipModalityOnDownloadDone({ id: 'wan21-t2v-1.3b', kind: 'video' }, 'image'))
      .toEqual({ modality: 'video' })
    expect(shouldFlipModalityOnDownloadDone({ id: 'sd-turbo', kind: 'image' }, 'video'))
      .toEqual({ modality: 'image' })
  })

  it('is indifferent to non-image/video active modalities other than a real match (tts/stt/music all count as "different")', () => {
    expect(shouldFlipModalityOnDownloadDone({ id: 'sd-turbo', kind: 'image' }, 'tts'))
      .toEqual({ modality: 'image' })
  })
})

// ── Source-assertion: kind survives the wire and reaches the filter + flip ──

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

describe('MediaPage.tsx source — kind is kept, not dropped, and actually used', () => {
  const src = read('src/pages/media/MediaPage.tsx')

  it('setSdModels keeps kind from the catalog payload', () => {
    expect(src).toMatch(/setSdModels\(c\.models\.map\(mm => \(\{[^}]*kind: mm\.kind/)
  })

  it('the sdModels state type declares a kind field', () => {
    expect(src).toMatch(/kind: 'image' \| 'video'/)
  })

  it('the download panel filters sdModels through isSdDownloadRowVisible before rendering', () => {
    expect(src).toMatch(/\{sdModels[\s\S]{0,400}?\.filter\(m => isSdDownloadRowVisible\(/)
  })

  it('downloadSdRow records which row (and kind) is downloading, for the flip check', () => {
    expect(src).toContain("downloadingSdRowRef.current = { id, kind }")
  })

  it('the done handler computes the flip via shouldFlipModalityOnDownloadDone and calls setModality', () => {
    expect(src).toMatch(/shouldFlipModalityOnDownloadDone\(finished, modality\)/)
    expect(src).toMatch(/if \(flip\) \{\s*setModality\(flip\.modality\)/)
  })
})
