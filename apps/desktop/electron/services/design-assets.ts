// apps/desktop/electron/services/design-assets.ts
//
// Media assets for the Design tab. A video/audio/gif the user attaches to the
// composer is COPIED into <storage root>/DesignAssets and the generated page
// references it as `assets/<name>`:
//   - live preview: the relative URL resolves doc-relative, so the request
//     lands on tachi-preview:// as /assets/<name> and preview-protocol serves
//     it from this dir (Range-capable, fail-closed name gate);
//   - auto-save: design:save-file copies every referenced asset next to the
//     saved HTML (<project>/assets/), so the on-disk artifact is standalone.
// One relative-path contract — the same generated markup works in the preview
// AND as a saved file.

import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { storageDir, ensureStorageDir, writeStorageFile, copyStorageFile } from './storage-root'
import { isDesignAssetName, toDesignAssetName } from './util/design-assets'

/** Where attached assets live: the user-visible storage root's Design Assets. */
export function designAssetsDir(): string {
  return storageDir('assets')
}

// Caps: a path-copy is cheap (250MB); a bytes transfer rides the IPC structured
// clone, keep it far smaller (64MB).
const MAX_COPY_BYTES = 250 * 1024 * 1024
const MAX_IPC_BYTES = 64 * 1024 * 1024

export type AddAssetResult =
  | { ok: true; name: string; relPath: string; bytes: number }
  | { ok: false; error: string }

/** Pick a collision-free name in the assets dir: an existing SAME-SIZE file is
 *  reused (same content, same source re-attached), otherwise suffix -2, -3, … */
function uniqueAssetName(dir: string, wanted: string, size: number): string {
  const dot = wanted.lastIndexOf('.')
  const base = wanted.slice(0, dot)
  const ext = wanted.slice(dot)
  let name = wanted
  for (let i = 2; i < 100; i++) {
    const abs = join(dir, name)
    if (!existsSync(abs)) return name
    try { if (statSync(abs).size === size) return name } catch { /* stat race — try next */ }
    name = `${base}-${i}${ext}`
  }
  return name
}

/**
 * Add one media asset from an absolute file path (preferred — zero-copy over
 * IPC) or raw bytes (fallback when the renderer can't resolve a real path).
 */
export function addDesignAsset(input: { path?: string; name?: string; bytes?: ArrayBuffer | Uint8Array }): AddAssetResult {
  try {
    // ensureStorageDir, not a bare mkdir: a root that turned unwritable
    // mid-session (Defender Controlled Folder Access on Documents — LANE J/L)
    // heals here, and the collision scan below then reads the SAME dir the
    // copy/write lands in.
    const dir = ensureStorageDir('assets')

    if (typeof input.path === 'string' && input.path) {
      if (!existsSync(input.path)) return { ok: false, error: `File not found: ${input.path}` }
      const size = statSync(input.path).size
      if (size > MAX_COPY_BYTES) return { ok: false, error: 'File is too large (max 250MB).' }
      const wanted = toDesignAssetName(input.path)
      if (!wanted) return { ok: false, error: 'Unsupported media type.' }
      const name = uniqueAssetName(dir, wanted, size)
      const abs = join(dir, name)
      if (!existsSync(abs) || statSync(abs).size !== size) copyStorageFile('assets', name, input.path)
      return { ok: true, name, relPath: `assets/${name}`, bytes: size }
    }

    if (input.bytes && typeof input.name === 'string') {
      const buf = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
      if (buf.byteLength === 0) return { ok: false, error: 'Empty file.' }
      if (buf.byteLength > MAX_IPC_BYTES) return { ok: false, error: 'File is too large to attach without a disk path (max 64MB).' }
      const wanted = toDesignAssetName(input.name)
      if (!wanted) return { ok: false, error: 'Unsupported media type.' }
      const name = uniqueAssetName(dir, wanted, buf.byteLength)
      const abs = join(dir, name)
      if (!existsSync(abs) || statSync(abs).size !== buf.byteLength) writeStorageFile('assets', name, buf)
      return { ok: true, name, relPath: `assets/${name}`, bytes: buf.byteLength }
    }

    return { ok: false, error: 'Nothing to attach.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Absolute path of a servable asset name — fail-closed on anything that is
 *  not a bare, known-extension media filename present in the assets dir. */
export function resolveDesignAssetPath(name: string): string | null {
  if (!isDesignAssetName(name)) return null
  const abs = join(designAssetsDir(), name)
  return existsSync(abs) ? abs : null
}
