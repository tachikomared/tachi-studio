// apps/desktop/electron/services/util/design-assets.ts
//
// PURE helpers behind Design-tab MEDIA ASSETS (unit-tested, no electron).
//
// A user can attach a video/audio/gif to the design composer; the file is
// copied into the design-assets storage dir and the generated page references
// it as `assets/<name>`. In the live preview that relative URL resolves
// doc-relative onto the tachi-preview:// protocol as an UNTRUSTED path chosen
// by generated code — these helpers are the gate that keeps the `assets/` route
// from serving anything but a bare, known-extension media filename out of that
// one dir (same contract as util/design-audio.ts for voiceover).

const ASSET_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
}

/** Extensions the design-asset pipeline accepts (keep in sync with ASSET_MIME). */
export const DESIGN_ASSET_EXTS = Object.keys(ASSET_MIME)

// Bare filename: starts alphanumeric (no dotfiles), conservative class with NO
// path separators, then a known media extension.
const ASSET_NAME_RE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}\\.(${DESIGN_ASSET_EXTS.join('|')})$`, 'i',
)

/** true when `name` is a bare media filename the preview protocol may serve. */
export function isDesignAssetName(name: string): boolean {
  return ASSET_NAME_RE.test(name)
}

/** Content-Type for a servable asset name, or null when it isn't one. */
export function designAssetMime(name: string): string | null {
  if (!isDesignAssetName(name)) return null
  const ext = name.split('.').pop()!.toLowerCase()
  return ASSET_MIME[ext] ?? null
}

/** Sanitize an arbitrary (user-chosen) filename into a servable asset name.
 *  Keeps the extension; returns null when the extension isn't a media one. */
export function toDesignAssetName(raw: string): string | null {
  const trimmed = (raw || '').split(/[\\/]/).pop() || ''
  const dot = trimmed.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = trimmed.slice(dot + 1).toLowerCase()
  if (!(ext in ASSET_MIME)) return null
  const base = trimmed.slice(0, dot)
    .replace(/[^A-Za-z0-9 ._()-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
    .slice(0, 80)
  const name = `${base || 'asset'}.${ext}`
  return isDesignAssetName(name) ? name : null
}
