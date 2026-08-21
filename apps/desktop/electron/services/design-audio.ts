// apps/desktop/electron/services/design-audio.ts
//
// Composition audio for the Design tab. Synthesized voiceover (the Media tab's
// piper sidecar) lands in the user-visible storage root (<storage root>/Audio,
// default Documents\Tachi Studio\Audio) as bare .wav files that a composition
// references with <Audio src={staticFile('vo.wav')} />:
//   - live preview: staticFile resolves doc-relative, so the tachi-preview://
//     protocol serves the file out of the audio roots (see preview-protocol.ts);
//   - MP4 export: design-render passes designAudioPublicDir() as the Remotion
//     bundle's publicDir, so the headless render resolves the same staticFile
//     URL and renderMedia muxes the audio natively.
// One filename contract — the same composition code plays with sound in the
// preview AND exports with sound.
//
// BACK-COMPAT: audio synthesized before the storage-root change lives in the
// LEGACY <userData>/design-audio dir. Every reader here (listing, fingerprint,
// publicDir, path resolution) checks BOTH roots — storage root wins on a name
// collision; only NEW writes go to the storage root.

import { app } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { synthesize } from './piper-client'
import { storageDir, legacyDir, ensureStorageDir, copyStorageFile } from './storage-root'
import { toDesignAudioName, audioDirFingerprint, isDesignAudioName } from './util/design-audio'

/** Where NEW audio is written: the user-visible storage root's Audio folder. */
export function designAudioDir(): string {
  return storageDir('audio')
}

/** Legacy pre-storage-root location (<userData>/design-audio) — read-only
 *  back-compat so audio the user already synthesized keeps working. */
export function legacyDesignAudioDir(): string {
  return legacyDir('audio')
}

/** All servable audio entries across BOTH roots, storage root winning on a
 *  name collision (legacy is scanned first so the new root overwrites it). */
function mergedAudioEntries(): Array<{ name: string; dir: string; size: number; mtimeMs: number }> {
  const byName = new Map<string, { name: string; dir: string; size: number; mtimeMs: number }>()
  for (const dir of [legacyDesignAudioDir(), designAudioDir()]) {
    let names: string[]
    try { names = readdirSync(dir) } catch { continue /* root missing — fine */ }
    for (const name of names) {
      if (!isDesignAudioName(name)) continue
      try {
        const s = statSync(join(dir, name))
        byName.set(name, { name, dir, size: s.size, mtimeMs: s.mtimeMs })
      } catch { /* vanished mid-scan — skip */ }
    }
  }
  return [...byName.values()]
}

/** Absolute path of a servable audio name — storage root first, then legacy
 *  (previews/exports of compositions made before the move keep their sound). */
export function resolveDesignAudioPath(name: string): string | null {
  for (const dir of [designAudioDir(), legacyDesignAudioDir()]) {
    const abs = join(dir, name)
    if (existsSync(abs)) return abs
  }
  return null
}

/** A single dir usable as a Remotion `publicDir`, or undefined when there is
 *  no audio (bundle() throws on a missing publicDir, and an empty one is
 *  pointless). When files live in only one root, that root is returned as-is;
 *  when they are SPLIT across storage root + legacy, they are staged into one
 *  merged dir (internal userData cache) because bundle() takes exactly one. */
export function designAudioPublicDir(): string | undefined {
  try {
    const entries = mergedAudioEntries()
    if (entries.length === 0) return undefined
    const roots = [...new Set(entries.map(e => e.dir))]
    if (roots.length === 1) return roots[0]
    const staging = join(app.getPath('userData'), 'design-audio-publicdir')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    for (const e of entries) copyFileSync(join(e.dir, e.name), join(staging, e.name))
    return staging
  } catch { /* unreadable — render proceeds without audio assets */ }
  return undefined
}

/** Fingerprint of the current audio files across both roots ('' when none) —
 *  part of the MP4 bundle-cache key, so re-synthesized voiceover invalidates
 *  cached bundles. */
export function designAudioDirFingerprint(): string {
  try {
    return audioDirFingerprint(mergedAudioEntries())
  } catch {
    return ''
  }
}

export interface DesignAudioEntry { name: string; size: number; mtimeMs: number }

/** Servable audio files across both roots, newest first — feeds the Voiceover
 *  panel and the generation prompt's AUDIO allowlist. */
export function listDesignAudio(): DesignAudioEntry[] {
  return mergedAudioEntries()
    .map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Copy an existing audio file (a Media-tab artifact, a Nodes TTS result…)
 * into design-audio under a servable bare name. The extension gate rejects
 * anything that is not a known audio type.
 */
export function importDesignAudio(srcPath: string): { file: string; path: string } {
  const base = srcPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''
  const candidate = toDesignAudioName(base.slice(0, base.length - ext.length)).replace(/\.wav$/i, '') + ext.toLowerCase()
  if (!isDesignAudioName(candidate)) throw new Error(`Not an audio file: ${base}`)
  // copyStorageFile: re-probes + retries once when the cached root went
  // unwritable (CFA), and `dest` is the path actually written.
  const dest = copyStorageFile('audio', candidate, srcPath)
  return { file: candidate, path: dest }
}

export interface DesignVoInput { voiceId: string; text: string; name?: string }
export interface DesignVoResult { file: string; path: string }

/**
 * Synthesize a voiceover line with piper into the audio storage dir and return
 * the bare filename a composition should pass to staticFile(). Unnamed lines
 * get a (voice,text)-digest name and are reused when already on disk; an
 * explicit `name` always re-synthesizes (the caller is iterating on that slot).
 */
export async function synthesizeDesignVo(input: DesignVoInput): Promise<DesignVoResult> {
  const named = typeof input.name === 'string' && input.name.trim().length > 0
  const digest = createHash('sha1').update(`${input.voiceId}\n${input.text}`).digest('hex').slice(0, 10)
  const file = named ? toDesignAudioName(input.name!) : `vo-${digest}.wav`
  // ensureStorageDir heals an unwritable root BEFORE the "already synthesized?"
  // check, so the existence probe and the copy below agree on one root.
  const dir = ensureStorageDir('audio')
  let dest = join(dir, file)
  if (named || !existsSync(dest)) {
    // Digest lines synthesized BEFORE the storage-root change live in the
    // legacy dir — reuse them with a copy instead of re-running piper.
    const legacyPath = join(legacyDesignAudioDir(), file)
    if (!named && existsSync(legacyPath)) {
      dest = copyStorageFile('audio', file, legacyPath)
    } else {
      const r = await synthesize({ voiceId: input.voiceId, text: input.text })
      dest = copyStorageFile('audio', file, r.path)
    }
  }
  return { file, path: dest }
}
