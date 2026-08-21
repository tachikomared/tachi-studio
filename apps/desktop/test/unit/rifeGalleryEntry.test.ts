// apps/desktop/test/unit/rifeGalleryEntry.test.ts
//
// AN INTERPOLATED CLIP THAT IS NOT IN THE GALLERY DOES NOT EXIST.
//
// Driver finding (owner, live): two RIFE runs finished successfully — the rail
// showed real frame counts, the toast said "Saved wan-…-rife2x.mp4" — and the
// gallery stayed at 22 entries. Dismiss the toast and the file has NO route
// back: it is not in the gallery, not in the Artifacts library, and its path is
// nowhere on screen. The only way to reach it was the OS file manager, if you
// had memorised the name.
//
// The wire was already there and simply never connected: RifeAction DECLARES
// `onSaved?: (outputPath: string) => void` and fires it on success, and
// MediaPage rendered `<RifeAction path={…} style={…} />` — no `onSaved`. A grep
// found zero usages of the prop in the whole app.
//
// WHAT LANDS, AND WHY IT IS ITS OWN ENTRY:
//
//  • A NEW ENTRY, not an extra artifact bolted onto the source card. The source
//    entry's `model` and `params` describe the run that produced the SOURCE
//    frames; the interpolated file was produced by rife-ncnn-vulkan from those
//    frames, and hanging it under Wan's params would attribute frames Wan never
//    generated. So it lands as what it is, with its own honest attribution.
//  • NO `params` ⇒ NO REMIX BUTTON. Remix restores the composer from the
//    entry's params; restoring the SOURCE's params under a derived clip would
//    offer to "remix" a file whose pixels no generator ever made.
//  • NO `provider`. Nothing was billed and there is no route to restore — the
//    work happened on this machine.
//  • `source: 'derived'`, so the Artifacts library can tell a produced file from
//    a generated one without parsing prose.
//
// Tested at the STORE/HELPER SEAM (the runner and the IPC already have their own
// suites): the entry builder is pure, and the gallery it lands in is the real
// zustand store.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// --- in-memory localStorage shim, installed BEFORE the store is imported -----
// (the idiom mediaRunState.test.ts / mediaProviderPersistence.test.ts use)
const ls = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}
;(globalThis as unknown as { localStorage: typeof localStorageShim }).localStorage = localStorageShim

vi.mock('electron', () => ({}))

type Helpers = typeof import('../../src/pages/media/mediaHelpers')
type Store   = typeof import('../../src/store/media.store')

let H: Helpers
let S: Store

beforeAll(async () => {
  H = await import('../../src/pages/media/mediaHelpers')
  S = await import('../../src/store/media.store')
})

/** A finished local video gen, exactly as pushEntry writes one. */
function sourceEntry(over: Partial<import('../../src/store/media.store').MediaGalleryEntry> = {}) {
  return {
    id: 'gen-1',
    model: 'wan21-t2v-1.3b',
    modality: 'video' as const,
    prompt: 'a paper boat in a gutter, rain',
    artifacts: [{ kind: 'video' as const, mimeType: 'video/webm', path: 'C:\\out\\wan-1.mp4' }],
    createdAt: 1_000,
    params: { prompt: 'a paper boat in a gutter, rain', steps: 20 },
    provider: 'local',
    ...over,
  } as import('../../src/store/media.store').MediaGalleryEntry
}

/** The i18n formatter, stubbed the way `t('rife.derived', { source })` behaves. */
const label = (s: string) => `RIFE 2x · from: ${s}`

// ── 1. the entry a finished run becomes ──────────────────────────────────────

describe('interpolatedGalleryEntry', () => {
  it('carries the interpolated FILE, as a playable video artifact', () => {
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    expect(e).not.toBeNull()
    expect(e.artifacts).toHaveLength(1)
    expect(e.artifacts[0]!.kind).toBe('video')
    expect(e.artifacts[0]!.path).toBe('C:\\out\\wan-1-rife2x.mp4')
    expect(e.modality).toBe('video')
    expect(e.createdAt).toBe(5_000)
  })

  it('declares mp4 — the container the encoder actually writes', async () => {
    // Pinned against rife-plan's own naming rule rather than assumed: it forces
    // `.mp4` regardless of the source container (H.264 in mp4).
    const { rifeOutputPath } = await import('../../electron/services/rife-plan')
    expect(rifeOutputPath('/v/clip.webm', 2, () => false)).toMatch(/\.mp4$/)
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: '/v/clip.webm',
      outputPath: rifeOutputPath('/v/clip.webm', 2, () => false), now: 5_000, label,
    })!
    expect(e.artifacts[0]!.mimeType).toBe('video/mp4')
  })

  it('is attributed to the ENGINE that made these frames, not to the source model', async () => {
    const { RIFE_MODEL_DIR } = await import('../../electron/services/rife-plan')
    // The model id IS the model directory we run — one fact, not two.
    expect(H.RIFE_DERIVED_MODEL_ID).toBe(RIFE_MODEL_DIR)
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    expect(e.model).toBe(H.RIFE_DERIVED_MODEL_ID)
    expect(e.model).not.toBe('wan21-t2v-1.3b')
  })

  it('says out loud what it was derived FROM', () => {
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    expect(e.prompt).toBe('RIFE 2x · from: a paper boat in a gutter, rain')
    expect(e.source).toBe('derived')
  })

  it('offers NO Remix: the source params did not produce this file', () => {
    // MediaPage draws the Remix button on `entry.params &&` — the absence IS
    // the control's absence.
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    expect(e.params).toBeUndefined()
    // …and claims no billing route either.
    expect(e.provider).toBeUndefined()
  })

  it('falls back to the FILE NAME when the source clip has no prompt (an import)', () => {
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry({ prompt: '   ' }), sourcePath: 'C:\\videos\\holiday.mov',
      outputPath: 'C:\\videos\\holiday-rife2x.mp4', now: 5_000, label,
    })!
    expect(e.prompt).toBe('RIFE 2x · from: holiday.mov')
  })

  it('falls back to the model id when there is neither prompt nor path', () => {
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry({ prompt: '' }), sourcePath: undefined,
      outputPath: '/v/a-rife2x.mp4', now: 5_000, label,
    })!
    expect(e.prompt).toBe('RIFE 2x · from: wan21-t2v-1.3b')
  })

  it('truncates a novel-length prompt instead of persisting it twice', () => {
    const long = 'x'.repeat(400)
    const e = H.interpolatedGalleryEntry({
      source: sourceEntry({ prompt: long }), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    const named = e.prompt.slice('RIFE 2x · from: '.length)
    expect(named.length).toBeLessThanOrEqual(H.DERIVED_SOURCE_NAME_MAX + 1) // + the ellipsis
    expect(named.endsWith('…')).toBe(true)
  })

  it('gives every derived file its own id (two runs = two rows, not one React key)', () => {
    const a = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    const b = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x-2.mp4', now: 5_000, label,
    })!
    expect(a.id).not.toBe(b.id)
  })

  it('refuses a run that reported no file at all', () => {
    expect(H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: '  ', now: 5_000, label,
    })).toBeNull()
  })

  it('never captures the SAME file twice', () => {
    // The idiom addNodeRunArtifacts already uses: the on-disk path is the
    // identity, so a second landing of one file is a no-op rather than a
    // duplicate row claiming two files exist.
    const first = H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    expect(H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 6_000, label,
      existing: [first],
    })).toBeNull()
    // …a DIFFERENT output still lands.
    expect(H.interpolatedGalleryEntry({
      source: sourceEntry(), sourcePath: 'C:\\out\\wan-1.mp4',
      outputPath: 'C:\\out\\wan-1-rife2x-2.mp4', now: 6_000, label,
      existing: [first],
    })).not.toBeNull()
  })
})

// ── 2. it really reaches the gallery ─────────────────────────────────────────

describe('the gallery the entry lands in is the real one', () => {
  beforeEach(() => {
    ls.clear()
    S.useMediaStore.setState({ gallery: [] })
  })

  it('addEntry — the SAME mechanism a finished generation uses — accepts it', () => {
    const src = sourceEntry()
    S.useMediaStore.getState().addEntry(src)
    expect(S.useMediaStore.getState().gallery).toHaveLength(1)

    const derived = H.interpolatedGalleryEntry({
      source: src, sourcePath: src.artifacts[0]!.path,
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
      existing: S.useMediaStore.getState().gallery,
    })!
    S.useMediaStore.getState().addEntry(derived)

    const gallery = S.useMediaStore.getState().gallery
    expect(gallery).toHaveLength(2)
    // Newest first — the file the user just made is at the top, where they look.
    expect(gallery[0]!.id).toBe(derived.id)
    expect(gallery[0]!.artifacts[0]!.path).toBe('C:\\out\\wan-1-rife2x.mp4')
  })

  it('survives a reload: the path persists (b64 is what gets stripped, and it has none)', () => {
    const src = sourceEntry()
    const derived = H.interpolatedGalleryEntry({
      source: src, sourcePath: src.artifacts[0]!.path,
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
    })!
    S.useMediaStore.getState().addEntry(derived)
    const persisted = JSON.parse(ls.get('tachi-media-v1')!) as {
      state: { gallery: Array<{ source?: string; artifacts: Array<{ path?: string }> }> }
    }
    expect(persisted.state.gallery[0]!.artifacts[0]!.path).toBe('C:\\out\\wan-1-rife2x.mp4')
    expect(persisted.state.gallery[0]!.source).toBe('derived')
  })

  it('the dedup check reads the LIVE gallery, so a second success is a no-op', () => {
    const src = sourceEntry()
    const one = H.interpolatedGalleryEntry({
      source: src, sourcePath: src.artifacts[0]!.path,
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 5_000, label,
      existing: S.useMediaStore.getState().gallery,
    })!
    S.useMediaStore.getState().addEntry(one)
    const again = H.interpolatedGalleryEntry({
      source: src, sourcePath: src.artifacts[0]!.path,
      outputPath: 'C:\\out\\wan-1-rife2x.mp4', now: 7_000, label,
      existing: S.useMediaStore.getState().gallery,
    })
    expect(again).toBeNull()
    expect(S.useMediaStore.getState().gallery).toHaveLength(1)
  })
})

// ── 3. the wire itself ───────────────────────────────────────────────────────

describe('MediaPage actually passes onSaved (the whole bug)', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('hands RifeAction an onSaved handler', () => {
    expect(page).toMatch(/<RifeAction[\s\S]{0,400}?onSaved=/)
  })

  it('that handler builds the entry with the pure helper and appends it', () => {
    const at = page.indexOf('<RifeAction')
    expect(at).toBeGreaterThan(-1)
    const jsx = page.slice(at, at + 1400)
    expect(jsx).toContain('interpolatedGalleryEntry')
    expect(jsx).toContain('addEntry')
    expect(page).toMatch(/import \{[\s\S]*?interpolatedGalleryEntry[\s\S]*?\} from '\.\/mediaHelpers'/)
  })

  it('RifeAction still fires it on success only', () => {
    const src = read('src/pages/media/RifeAction.tsx')
    const ok = src.indexOf('if (res?.ok && res.outputPath)')
    const call = src.indexOf('onSaved?.(')
    const fail = src.indexOf('} else if (!res?.cancelled)')
    expect(ok).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(ok)
    expect(call).toBeLessThan(fail)
  })
})

// ── 3b. THE CANVAS PATH, which had the same hole ─────────────────────────────
//
// Driver finding (owner, live, rows5): the fix above closed the Media-tab card
// only. Run the SAME interpolation from a rife NODE and `-rife2x.mp4` reached
// the canvas Output card and the disk — and the gallery still held no rife
// entry. Canvas artifacts DO have a door to the gallery (useNodeRun calls
// media.store's addNodeRunArtifacts, proven by the FLF driver), but that call
// sits behind `node.type === 'media'`, and a rife node's type is 'rife'.
//
// It cannot simply be let through that door: addNodeRunArtifacts files an entry
// under the NODE's model/prompt/params, and a rife node has none of the three —
// it would land a row claiming a checkpoint generated frames it interpolated.
// So the canvas takes the SAME builder the gallery card takes, and the only new
// thing is finding what the clip was derived FROM: the wired source path, looked
// up in the gallery when the source was generated here, and the file name when
// it was not (an imported clip, or one whose entry has aged out of the cap).

describe('canvasInterpolatedGalleryEntry', () => {
  it('picks the video artifact the run produced', () => {
    const e = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1.mp4',
      artifacts: [{ kind: 'video', mimeType: 'video/mp4', path: 'C:\\out\\wan-1-rife2x.mp4' }],
      gallery: [], now: 5_000, label,
    })!
    expect(e.artifacts[0]!.path).toBe('C:\\out\\wan-1-rife2x.mp4')
    expect(e.model).toBe(H.RIFE_DERIVED_MODEL_ID)
    expect(e.source).toBe('derived')
    // The same two refusals the gallery card's entry makes.
    expect(e.params).toBeUndefined()
    expect((e as { provider?: string }).provider).toBeUndefined()
  })

  it('names the SOURCE ENTRY when the clip was generated in this app', () => {
    const src = sourceEntry()
    const e = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\out\\wan-1-rife2x.mp4' }],
      gallery: [src], now: 5_000, label,
    })!
    // Its prompt, exactly as the Media-tab card's entry reads.
    expect(e.prompt).toBe(label('a paper boat in a gutter, rain'))
  })

  it('falls back to the FILE NAME when nothing in the gallery owns that path', () => {
    const e = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\imported\\holiday-clip.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\imported\\holiday-clip-rife2x.mp4' }],
      gallery: [sourceEntry()], now: 5_000, label,
    })!
    expect(e.prompt).toBe(label('holiday-clip.mp4'))
  })

  it('still lands when the source path is unknown entirely', () => {
    const e = H.canvasInterpolatedGalleryEntry({
      artifacts: [{ kind: 'video', path: 'C:\\out\\x-rife2x.mp4' }],
      gallery: [], now: 5_000, label,
    })
    expect(e).not.toBeNull()
    expect(e!.artifacts[0]!.path).toBe('C:\\out\\x-rife2x.mp4')
  })

  it('ignores an image artifact and a b64-only clip — the gallery needs a file', () => {
    expect(H.canvasInterpolatedGalleryEntry({
      artifacts: [{ kind: 'image', path: 'C:\\out\\thumb.png' }],
      gallery: [], now: 5_000, label,
    })).toBeNull()
    expect(H.canvasInterpolatedGalleryEntry({
      artifacts: [{ kind: 'video', b64: 'AAAA' } as never],
      gallery: [], now: 5_000, label,
    })).toBeNull()
    expect(H.canvasInterpolatedGalleryEntry({
      artifacts: [], gallery: [], now: 5_000, label,
    })).toBeNull()
  })

  it('is DEDUP-AWARE against the gallery it is handed', () => {
    // A re-run of the same rife node writes the same file. One file on disk is
    // one row — the same rule addNodeRunArtifacts enforces for media nodes.
    const first = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\out\\wan-1-rife2x.mp4' }],
      gallery: [], now: 5_000, label,
    })!
    expect(H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\out\\wan-1-rife2x.mp4' }],
      gallery: [first], now: 6_000, label,
    })).toBeNull()
  })

  it('a x4 pass over an ALREADY interpolated clip chains honestly', () => {
    // rife → rife is a legal canvas chain (VIDEO_CARRIERS includes 'rife'), so
    // the second pass finds a derived entry as its source and names it.
    const first = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\out\\wan-1-rife2x.mp4' }],
      gallery: [sourceEntry()], now: 5_000, label,
    })!
    const second = H.canvasInterpolatedGalleryEntry({
      sourcePath: 'C:\\out\\wan-1-rife2x.mp4',
      artifacts: [{ kind: 'video', path: 'C:\\out\\wan-1-rife2x-rife2x.mp4' }],
      gallery: [first, sourceEntry()], now: 6_000, label,
    })!
    expect(second.prompt).toBe(label(first.prompt))
  })
})

describe('useNodeRun actually walks the rife artifact through that door', () => {
  const hook = () => read('src/pages/nodes/canvas/useNodeRun.ts')

  it('no longer drops every non-media node on the floor', () => {
    const src = hook()
    // The media branch survives untouched…
    expect(src).toMatch(/node\?\.type === 'media'/)
    // …and 'rife' now has one of its own.
    expect(src).toMatch(/node\?\.type === 'rife'/)
  })

  it('builds the entry with the shared helper, not a hand-rolled one', () => {
    const src = hook()
    expect(src).toContain('canvasInterpolatedGalleryEntry')
    expect(src).toMatch(/from '\.\.\/\.\.\/media\/mediaHelpers'/)
  })

  it('resolves the source clip with the SAME function the card and main use', () => {
    expect(hook()).toContain('rifeSourcePath')
  })

  it('lands it through addEntry against the LIVE gallery', () => {
    const src = hook()
    // The whole rife branch, from its guard to the end of the capture block —
    // the gallery is read a line ABOVE the builder call, so anchoring on the
    // call alone would miss it.
    const at = src.indexOf("node?.type === 'rife'")
    expect(at).toBeGreaterThan(-1)
    const branch = src.slice(at, at + 2000)
    // The gallery it dedups against must be the store's, read at capture time —
    // not a stale copy closed over by this render.
    expect(branch).toMatch(/useMediaStore\.getState\(\)\.gallery/)
    // …and it lands through addEntry (a derived clip is not a node generation,
    // so NOT addNodeRunArtifacts — that would file it under a model + params
    // this node does not have).
    expect(branch).toMatch(/addEntry\(derived\)/)
    expect(branch).not.toMatch(/addNodeRunArtifacts/)
  })

  it('uses the media namespace key, so both surfaces say one sentence', () => {
    expect(hook()).toMatch(/t\('media:rife\.derived'/)
    // …which means the hook has to actually load that namespace.
    expect(hook()).toMatch(/useTranslation\(\[\s*'nodes',\s*'media'\s*\]\)/)
  })
})

// ── 4. the sentence, in every language ───────────────────────────────────────

describe('the provenance line ships translated', () => {
  const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
  const media = (l: string) => JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as {
    rife: Record<string, string>
  }

  it('exists in all eight locales, with the interpolation intact', () => {
    const en = media('en').rife.derived
    expect(en).toBeTruthy()
    expect(en).toContain('{{source}}')
    for (const l of LOCALES) {
      const v = media(l).rife.derived
      expect(v, `${l}/media.json rife.derived`).toBeTruthy()
      // A placeholder that was translated away renders literal braces.
      expect(v, `${l} lost {{source}}`).toContain('{{source}}')
      if (l !== 'en') expect(v, `${l} is still the English string`).not.toBe(en)
    }
  })

  it('MediaPage resolves exactly that key', () => {
    expect(page()).toMatch(/t\('rife\.derived',\s*\{\s*source/)
  })

  function page(): string { return read('src/pages/media/MediaPage.tsx') }
})
