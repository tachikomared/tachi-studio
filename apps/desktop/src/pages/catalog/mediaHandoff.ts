// apps/desktop/src/pages/catalog/mediaHandoff.ts
//
// ONE-VERB RUN, the local-media half.
//
// Catalog's RUN button for a local media row used to be one statement:
// `navigate('/media')`. It moved the user to the Media tab and told it NOTHING
// — no provider, no modality, no model. The composer then restored whatever the
// last session had left behind: a cloud provider chip, some other modality, and
// a model the user never picked. Clicking RUN on Wan 2.1 landed you on a
// SURPLUS image prompt. The one thing the button promises — "run THIS model" —
// was the one thing it did not do.
//
// The fix is three writes into media.store before the navigation, and it lives
// here rather than inline in CatalogPage because it is the seam worth pinning
// with a test: a component in a node-env test suite is not, and asserting on
// `navigate` mocks would prove nothing about what the composer actually reads.
//
// media.store is IMPORTED and CALLED here, never edited — these are its own
// shipped setters (setProvider landed with the provider-persistence work,
// setModel/setModality have always been per-modality).

import type { CatalogEntry } from '@tachi/core'
import { useMediaStore } from '../../store/media.store'

/** The Media-studio modalities a LOCAL model can be run in (sd.cpp image/video,
 *  piper/kokoro tts) — the three `PROVIDER_MODALITIES.local` serves. */
export type MediaRunModality = 'image' | 'video' | 'tts'

/**
 * The modality a catalog entry runs in, or null when it is not a local media
 * row at all.
 *
 * Read off the CAPABILITY TAG, which is where the catalog store stamps the
 * modality (`sdCatalogEntry` maps kind→image-gen/video-gen, `piperCatalogEntry`
 * tags tts). Deliberately NOT guessed from the id: a user-installed checkpoint
 * is `civitai-812345`, a string that spells out nothing, and id-substring
 * guessing is the exact bug the Media composer deleted its `modelFamily` memo
 * over.
 *
 * null is a real answer and the caller must respect it: writing a modality we
 * are not sure of would point the composer at a list the model is not in, and
 * the studio would silently re-default the selection to something else — a
 * worse outcome than landing with nothing selected, because it looks decided.
 */
export function mediaModalityForEntry(
  entry: Pick<CatalogEntry, 'capabilities'>,
): MediaRunModality | null {
  const caps = entry.capabilities ?? []
  if (caps.includes('video-gen')) return 'video'
  if (caps.includes('image-gen')) return 'image'
  if (caps.includes('tts')) return 'tts'
  return null
}

/**
 * Point the Media studio at one local model, so the tab opens ONE click from
 * GENERATE.
 *
 * All three writes matter and none is redundant:
 *   • provider 'local' — every row that reaches here is an on-disk weight run
 *     by a sidecar on this machine. Landing on a cloud chip with a local model
 *     id under it is the mis-billing case media.store's provider field was
 *     added for.
 *   • modality — the composer's model list is FILTERED by it (image rows are
 *     not in the video list), so the model write below is inert without it.
 *   • setModel(modality, ref) — keyed per modality, exactly as the composer
 *     reads it back. The studio keeps a persisted selection when it is still in
 *     the freshly-loaded list and re-defaults otherwise, so this write survives
 *     the load it races with.
 *
 * `ref` is the sd.cpp / piper id the engine itself takes — the same string the
 * status IPC lists — never a display name.
 */
export function selectLocalMediaModel(modality: MediaRunModality, ref: string): void {
  const media = useMediaStore.getState()
  media.setProvider('local')
  media.setModality(modality)
  if (ref) media.setModel(modality, ref)
}
