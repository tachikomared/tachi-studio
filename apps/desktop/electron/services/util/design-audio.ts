// apps/desktop/electron/services/util/design-audio.ts
//
// PURE helpers behind Design-tab composition audio (unit-tested, no electron).
//
// Compositions reference voiceover as <Audio src={staticFile('vo.wav')} />.
// staticFile() resolves DOC-RELATIVE in the live preview, so the request lands
// on the tachi-preview:// protocol handler as an arbitrary path chosen by
// UNTRUSTED generated code — these helpers are the gate that keeps that route
// from ever serving anything but a bare, known-extension audio filename out of
// the design-audio dir. The fingerprint feeds the MP4 bundle-cache hash so a
// re-synthesized voiceover invalidates the cached webpack bundle (Remotion
// copies the public dir into the bundle at bundle time).

const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
}

// Bare filename: starts alphanumeric (no dotfiles), then a conservative
// character class with NO path separators, then a known audio extension.
const AUDIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,120}\.(wav|mp3|m4a|aac|ogg|opus|flac)$/i

/** true when `name` is a bare audio filename the preview protocol may serve. */
export function isDesignAudioName(name: string): boolean {
  return AUDIO_NAME_RE.test(name)
}

/** Content-Type for a servable audio name, or null when it isn't one. */
export function designAudioMime(name: string): string | null {
  if (!isDesignAudioName(name)) return null
  const ext = name.split('.').pop()!.toLowerCase()
  return AUDIO_MIME[ext] ?? null
}

/** Slug arbitrary text (a scene label, a line of VO) into a servable .wav name. */
export function toDesignAudioName(raw: string, fallback = 'vo'): string {
  const base = (raw || '')
    .replace(/\.wav$/i, '')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
    .slice(0, 80)
  return `${base || fallback}.wav`
}

/**
 * Order-independent fingerprint of the design-audio dir ('' when empty).
 * Included in the MP4 bundle-cache key so changed voiceover busts the cache.
 */
export function audioDirFingerprint(entries: Array<{ name: string; size: number; mtimeMs: number }>): string {
  if (entries.length === 0) return ''
  return entries.map(e => `${e.name}:${e.size}:${Math.round(e.mtimeMs)}`).sort().join('|')
}
