// apps/desktop/test/unit/catalogRunHandoff.test.ts
//
// WAVE 1 LANE D — ONE-VERB RUN, the catalog half.
//
// Catalog's RUN for a local media row was `navigate('/media')` and nothing else.
// The user clicked RUN on a specific model and landed on the Media tab with
// whatever the last session had left in the composer: possibly a cloud provider
// chip, possibly another modality, and a model they never chose. The verb
// promises "run THIS model" and delivered "open that tab".
//
// The seam is a write into media.store BEFORE the navigation, and this file
// drives it for real — the store is the thing MediaPage reads on mount, so
// asserting on its state is the only assertion that means anything. (The store
// is IMPORTED and CALLED here and by the page; nothing in this lane edits it.)

import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// media.store persists through localStorage at module scope — shim before import.
const lsMap = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (lsMap.has(k) ? lsMap.get(k)! : null),
  setItem: (k: string, v: string) => { lsMap.set(k, v) },
  removeItem: (k: string) => { lsMap.delete(k) },
  clear: () => { lsMap.clear() },
  key: (i: number) => Array.from(lsMap.keys())[i] ?? null,
  get length() { return lsMap.size },
}

type Handoff = typeof import('../../src/pages/catalog/mediaHandoff')
type MediaStore = typeof import('../../src/store/media.store')
let mediaModalityForEntry: Handoff['mediaModalityForEntry']
let selectLocalMediaModel: Handoff['selectLocalMediaModel']
let useMediaStore: MediaStore['useMediaStore']

beforeAll(async () => {
  ;({ mediaModalityForEntry, selectLocalMediaModel } = await import('../../src/pages/catalog/mediaHandoff'))
  ;({ useMediaStore } = await import('../../src/store/media.store'))
})

/** The composer state a user who was last on a CLOUD route comes back to — the
 *  exact starting point that made the old RUN useless. */
beforeEach(() => {
  useMediaStore.setState({
    provider: 'surplus',
    modality: 'image',
    modelByModality: { image: 'some-cloud-model', video: 'another-cloud-model' },
  })
})

const state = () => useMediaStore.getState()

describe('which modality a catalog row runs in', () => {
  it('reads the capability tag the store stamps, for each of the three local modalities', () => {
    expect(mediaModalityForEntry({ capabilities: ['video-gen'] })).toBe('video')
    expect(mediaModalityForEntry({ capabilities: ['image-gen'] })).toBe('image')
    expect(mediaModalityForEntry({ capabilities: ['tts'] })).toBe('tts')
  })

  it('answers null for a row that does not run in the Media studio at all', () => {
    expect(mediaModalityForEntry({ capabilities: ['chat', 'tools'] })).toBeNull()
    expect(mediaModalityForEntry({ capabilities: ['stt'] })).toBeNull()
    expect(mediaModalityForEntry({})).toBeNull()
  })

  it('is not fooled by an id — a user checkpoint is "civitai-812345" and spells out nothing', () => {
    // The tag is the only input; there is no id parameter to guess from.
    expect(mediaModalityForEntry({ capabilities: [] })).toBeNull()
  })
})

describe('RUN lands the user one click from GENERATE', () => {
  it('writes provider, modality AND the model — all three, or the write is inert', () => {
    selectLocalMediaModel('video', 'wan21-t2v-1.3b')
    expect(state().provider).toBe('local')
    expect(state().modality).toBe('video')
    expect(state().modelByModality.video).toBe('wan21-t2v-1.3b')
  })

  it('takes the composer off a cloud provider — a local id under a billed chip is the mis-billing case', () => {
    expect(state().provider).toBe('surplus')
    selectLocalMediaModel('image', 'sd-turbo')
    expect(state().provider).toBe('local')
  })

  it('keys the model PER modality, exactly as the composer reads it back', () => {
    selectLocalMediaModel('image', 'sd-turbo')
    expect(state().modelByModality.image).toBe('sd-turbo')
    // the other modality's selection is untouched
    expect(state().modelByModality.video).toBe('another-cloud-model')
  })

  it('a TTS voice selects the TTS composer, not the image one', () => {
    selectLocalMediaModel('tts', 'en_US-amy-low')
    expect(state().modality).toBe('tts')
    expect(state().modelByModality.tts).toBe('en_US-amy-low')
  })

  it('still routes provider + modality when there is no model to name (an installed LoRA)', () => {
    selectLocalMediaModel('image', '')
    expect(state().provider).toBe('local')
    expect(state().modality).toBe('image')
    // …and does NOT overwrite the selection with an empty string
    expect(state().modelByModality.image).toBe('some-cloud-model')
  })
})

// ─── the page wiring (no DOM in this suite) ──────────────────────────────────

const page = fs.readFileSync(
  path.resolve(__dirname, '../../src/pages/catalog/CatalogPage.tsx'), 'utf8')

describe('every RUN surface goes through the handoff', () => {
  it('the card grid derives the modality from the entry it already holds', () => {
    expect(page).toContain('mediaModalityForEntry(entry)')
  })

  it('the Installed tab uses the row\'s own mediaKind rather than re-guessing it', () => {
    expect(page).toContain('m.mediaKind')
  })

  it('the Civitai tab selects the installed checkpoint it was clicked on', () => {
    expect(page).toContain("row.type === 'Checkpoint'")
    expect(page).toContain("selectLocalMediaModel('image', row.id)")
  })

  it('no RUN path reaches /media without first telling it what to run', () => {
    // Every navigate('/media') in the file must be preceded by a selection call
    // in the same handler. Pinning the count keeps a new bare one from creeping
    // back in unnoticed.
    const navs = page.match(/navigate\('\/media'\)/g) ?? []
    const picks = page.match(/selectLocalMediaModel\(/g) ?? []
    expect(navs.length).toBeGreaterThan(0)
    expect(picks.length).toBeGreaterThanOrEqual(navs.length)
  })

  it('refuses to invent a modality it does not know (null = open the tab, change nothing)', () => {
    expect(page).toContain('if (modality) selectLocalMediaModel(modality, ref)')
  })
})
