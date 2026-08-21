// apps/desktop/electron/services/freellmapi-patches.ts
//
// The vendor-patch manifest, and the proof that a relay tree actually carries
// what the manifest promises.
//
// WHY THIS FILE EXISTS. On 2026-08-01 an installer shipped with vendor patch #2
// missing. Nothing was broken — `git apply --check` of that patch against the
// shipped tree exits 0, so it would have applied. The step simply never ran, and
// the pipeline could not tell anyone: its `catch` printed "already present —
// skipping" for a successful idempotent skip AND for a genuine failure AND
// (by omission) for a step that never happened. The relay went out without the
// Kilo and Zen upstreams, the host app kept advertising them, and the first
// keyless send died on a dead OpenRouter key that had nothing in front of it.
//
// So: the ordered list and its proof markers live in ONE file
// (scripts/patches/manifest.json, shipped to resources/patches), and everything
// that builds or ships the relay reads that file and CHECKS THE RESULT —
// the package-time build (scripts/download-sidecars.mjs), the runtime install
// fallback (freellmapi-installer.ts), and a unit test that fails if the
// checked-in tree is missing a marker.
//
// Deliberately Electron-free: pure fs + paths, so the test can call it against
// the repo without standing up an Electron app.

import { existsSync, readFileSync } from 'fs'
import { join }                     from 'path'

export interface PatchMarker {
  /** Path inside the relay tree, forward slashes. */
  path:     string
  /** Literal substring the patch is supposed to introduce there. */
  contains: string
}

export interface PatchEntry {
  file:    string
  what:    string
  /** Proof the SOURCE tree was patched. */
  markers: PatchMarker[]
  /**
   * Proof the compiled `server/dist` — the code that actually runs — was
   * rebuilt from that patched source. Without this, a tree that was patched and
   * never rebuilt would verify clean while serving the old relay: a green check
   * on a wrong artifact, the same class of lie this whole file exists to end.
   */
  builtMarkers?: PatchMarker[]
}

/** Which half of the proof to check. Runtime callers want 'both'. */
export type MarkerScope = 'source' | 'built' | 'both'

/** The manifest file name inside a patches directory. */
export const PATCH_MANIFEST = 'manifest.json'

/**
 * Read the ordered patch list. Throws when the manifest is absent or empty —
 * a caller that cannot read the manifest does not know what the relay should
 * contain, and guessing is what produced the bug this file exists to prevent.
 */
export function loadPatchManifest(patchesDir: string): PatchEntry[] {
  const file = join(patchesDir, PATCH_MANIFEST)
  if (!existsSync(file)) {
    throw new Error(`freellmapi patch manifest not found at ${file}`)
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { patches?: PatchEntry[] }
  const patches = parsed.patches
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new Error(`freellmapi patch manifest ${file} lists no patches`)
  }
  return patches
}

export interface PatchVerdict {
  file:    string
  what:    string
  /** True iff every marker for this patch is present in the tree. */
  applied: boolean
  /** Human-readable "path :: marker" for each marker that is absent. */
  missing: string[]
}

/**
 * Does this relay tree carry what the patch claims to add?
 *
 * A missing FILE counts as a missing marker rather than an exception: an
 * absent or half-built sidecar should read as "not verified", never as a crash
 * on a UI path.
 */
export function verifyPatch(sidecarDir: string, entry: PatchEntry, scope: MarkerScope = 'both'): PatchVerdict {
  const wanted: PatchMarker[] = [
    ...(scope === 'built'  ? [] : entry.markers ?? []),
    ...(scope === 'source' ? [] : entry.builtMarkers ?? []),
  ]
  const missing: string[] = []
  for (const m of wanted) {
    const file = join(sidecarDir, ...m.path.split('/'))
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { missing.push(`${m.path} (unreadable)`); continue }
    if (!text.includes(m.contains)) missing.push(`${m.path} :: ${m.contains}`)
  }
  return { file: entry.file, what: entry.what, applied: missing.length === 0, missing }
}

/** Same, for the whole ordered list. */
export function verifyAllPatches(sidecarDir: string, entries: PatchEntry[], scope: MarkerScope = 'both'): PatchVerdict[] {
  return entries.map(e => verifyPatch(sidecarDir, e, scope))
}

/**
 * One-call convenience for the runtime paths: read the manifest, verify the
 * tree, and return the verdicts. Returns `null` — never throws — when the
 * manifest itself cannot be read, so a caller can distinguish "the relay is
 * wrong" (verdicts with `applied: false`) from "we cannot tell" (null).
 */
export function verifyFreellmapiTree(
  patchesDir: string | null,
  sidecarDir: string,
  scope: MarkerScope = 'both',
): PatchVerdict[] | null {
  if (!patchesDir) return null
  try {
    return verifyAllPatches(sidecarDir, loadPatchManifest(patchesDir), scope)
  } catch {
    return null
  }
}

/**
 * Log the verdicts. Loud on failure, quiet-but-present on success — the point
 * is that a half-patched relay can never again be silent.
 */
export function logPatchVerdicts(tag: string, verdicts: PatchVerdict[] | null): void {
  if (verdicts === null) {
    console.warn(
      `[${tag}] vendor patch manifest unreadable — cannot verify the relay carries the free-route `
      + `upstreams. Treat the free route as unproven.`,
    )
    return
  }
  for (const v of verdicts) {
    if (v.applied) {
      console.log(`[${tag}] vendor patch verified: ${v.file} (${v.what})`)
    } else {
      console.error(
        `[${tag}] vendor patch NOT IN THE RELAY: ${v.file} (${v.what}). Missing:\n`
        + v.missing.map(m => `    ${m}`).join('\n')
        + `\n    The free route is weaker than the UI claims. Re-run \`pnpm prepare:sidecars\` and repackage.`,
      )
    }
  }
}
