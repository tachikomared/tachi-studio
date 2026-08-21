// apps/desktop/electron/services/util/init-image.ts
//
// THE INIT FRAME HAS TO BECOME A FILE ON DISK.
//
// The renderer cannot hand main a path: a browser <input type=file> yields a
// File, and ParamFields reads it as a `data:` URL (that is what the composer
// stores in `params.image_url`, and what the preview <img> renders). sd-cli, on
// the other side, only takes `-i <path>`. Nothing in between converted, so the
// composer's INIT FRAME was dropped on the floor for every local run — the
// canvas node path (graph-to-agentkit) does this conversion inline and is
// exactly why the SAME image works there and not here.
//
// Pure-ish and injectable so the whole table is pinned by tests instead of by a
// screenshot of a render that takes an hour.

import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

/** A `data:<mime>[;base64],<payload>` URL, split into its three parts. */
const DATA_URL = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s

/**
 * mime → the extension sd-cli's loader expects to see. Unknown ⇒ .png.
 *
 * EXPORTED because there are two materialisation sites, and the other one
 * (graph-to-agentkit's canvas branch) hardcoded `.png` for every mime — a JPEG
 * the renderer handed over reached sd-cli under a name that lied about its
 * bytes. One table, both routes. The boot sweep's SD_INIT_TEMP_RE has to list
 * exactly the extensions this can emit, or a leftover it cannot match is
 * uncollectable forever (that is how the .jpg/.webp/.bmp temps escaped it).
 */
export function extForMime(mime: string): string {
  const m = mime.trim().toLowerCase()
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/bmp')  return '.bmp'
  return '.png'
}

export interface MaterializeDeps {
  /** Where a decoded data: URL is written. Defaults to the OS temp dir. */
  dir?:    string
  /** Clock for the file name (tests pin it). */
  now?:    () => number
  /** Collision suffix for the file name (tests pin it). */
  entropy?: () => string
  write?:  (path: string, bytes: Buffer) => void
  exists?: (path: string) => boolean
}

/**
 * What the caller may hand sd-cli, and what the caller now OWNS.
 *
 * The distinction is the whole point: main writes a temp for a `data:` URL and
 * must delete it when the run ends, but a `path` reference is the user's own
 * picture in the user's own folder and must survive every code path. Returning
 * one string could not tell the two apart, so the Media-page handlers deleted
 * neither and leaked one temp per Generate click.
 */
export interface MaterializedInit {
  /** What sd-cli opens with `-i` — undefined when there was nothing usable. */
  path?:    string
  /** Set ONLY when THIS call wrote that file, i.e. the only thing to rm. */
  ownTemp?: string
}

/**
 * Turn whatever the composer stored under `image_url` into an on-disk path
 * sd-cli can open with `-i`, or undefined when there is nothing usable.
 *
 *   data:image/png;base64,…  → decoded and written to a temp file (the case the
 *                              MEDIA composer always produces)
 *   file:///C:/pic.png       → converted to a path, when it exists
 *   C:\pic.png / /pic.png    → passed through, when it exists
 *   http(s)://…              → undefined. The one-shot sd-cli does not fetch,
 *                              and silently downloading a remote URL inside a
 *                              generation is not this function's decision to
 *                              make (PRIVATE MODE exists).
 *   '' / null / 42 / {}      → undefined
 *
 * NEVER throws: a malformed data URL or an unwritable temp dir yields undefined
 * and the generation runs as pure text→image, exactly as it does with no init
 * frame at all. A dropped init image must not also lose the render.
 *
 * Callers that have to CLEAN UP after the run want materializeInitImageOwned
 * below; this is the thin "just give me the path" wrapper over it.
 */
export function materializeInitImage(ref: unknown, deps: MaterializeDeps = {}): string | undefined {
  return materializeInitImageOwned(ref, deps).path
}

/**
 * materializeInitImage, plus the answer to "may I delete this when the run
 * ends?" — `ownTemp` is set on the data: URL branch only, because that is the
 * one branch where the file did not exist a moment ago.
 */
export function materializeInitImageOwned(ref: unknown, deps: MaterializeDeps = {}): MaterializedInit {
  if (typeof ref !== 'string') return {}
  const raw = ref.trim()
  if (raw === '') return {}

  const write   = deps.write   ?? ((p: string, b: Buffer) => writeFileSync(p, b))
  const exists  = deps.exists  ?? ((p: string) => existsSync(p))
  const dir     = deps.dir     ?? tmpdir()
  const now     = deps.now     ?? (() => Date.now())
  // Two Generate clicks inside one millisecond would otherwise write the SAME
  // filename, and the second run would generate from the first one's frame —
  // worse now that the file is deleted when a run ends, since the loser can also
  // have it pulled out from under it mid-render. Same entropy the canvas route
  // carries, kept hex so the boot sweep's pattern still matches the name.
  const entropy = deps.entropy ?? (() => randomUUID().slice(0, 8))

  const dm = DATA_URL.exec(raw)
  if (dm) {
    const [, mime, flags, payload] = dm
    // Only base64 payloads: a percent-encoded data URL is not something the
    // composer can produce, and guessing at it would write a corrupt file.
    if (!/;base64/i.test(flags ?? '')) return {}
    if (!payload) return {}
    try {
      const bytes = Buffer.from(payload, 'base64')
      if (bytes.length === 0) return {}
      const out = join(dir, `sd-init-${now()}-${entropy()}${extForMime(mime)}`)
      write(out, bytes)
      // The ONLY branch that reports ownership: we just created this file.
      return { path: out, ownTemp: out }
    } catch { return {} }
  }

  if (/^file:\/\//i.test(raw)) {
    try {
      const p = fileURLToPath(raw)
      return exists(p) ? { path: p } : {}
    } catch { return {} }
  }

  // A remote reference is not fetched here — see the doc comment.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return {}

  return exists(raw) ? { path: raw } : {}
}
