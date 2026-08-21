// apps/desktop/test/unit/designAudio.test.ts
//
// Pure helpers behind Design-tab composition audio: the filename gate that
// decides what the tachi-preview:// protocol may serve out of the design-audio
// dir (staticFile('vo.wav') resolves doc-relative, so a hostile composition
// could request ANY path — only bare, known-extension audio names may pass),
// the sanitizer that turns user text into such a name, and the dir fingerprint
// that busts the MP4 bundle cache when voiceover files change.
import { describe, it, expect } from 'vitest'
import { isDesignAudioName, toDesignAudioName, designAudioMime, audioDirFingerprint } from '../../electron/services/util/design-audio'

describe('isDesignAudioName', () => {
  it('accepts bare audio filenames with known extensions', () => {
    expect(isDesignAudioName('vo.wav')).toBe(true)
    expect(isDesignAudioName('vo-line 2 (final).wav')).toBe(true)
    expect(isDesignAudioName('track.mp3')).toBe(true)
    expect(isDesignAudioName('VO-1.WAV')).toBe(true)
  })
  it('rejects traversal, separators, dotfiles, and non-audio extensions', () => {
    expect(isDesignAudioName('../secrets.wav')).toBe(false)
    expect(isDesignAudioName('..\\secrets.wav')).toBe(false)
    expect(isDesignAudioName('sub/vo.wav')).toBe(false)
    expect(isDesignAudioName('sub\\vo.wav')).toBe(false)
    expect(isDesignAudioName('.hidden.wav')).toBe(false)
    expect(isDesignAudioName('page.html')).toBe(false)
    expect(isDesignAudioName('vo.wav.html')).toBe(false)
    expect(isDesignAudioName('')).toBe(false)
  })
})

describe('toDesignAudioName', () => {
  it('slugs arbitrary text into a servable .wav name', () => {
    const n = toDesignAudioName('Scene 1: "intro" <VO>')
    expect(isDesignAudioName(n)).toBe(true)
    expect(n.endsWith('.wav')).toBe(true)
  })
  it('does not double the extension and falls back when nothing survives', () => {
    expect(toDesignAudioName('intro.wav')).toBe('intro.wav')
    expect(isDesignAudioName(toDesignAudioName('///'))).toBe(true)
  })
})

describe('designAudioMime', () => {
  it('maps known audio extensions and rejects the rest', () => {
    expect(designAudioMime('vo.wav')).toBe('audio/wav')
    expect(designAudioMime('a.mp3')).toBe('audio/mpeg')
    expect(designAudioMime('a.txt')).toBeNull()
  })
})

describe('audioDirFingerprint', () => {
  it('is stable across entry order and changes with content', () => {
    const a = [{ name: 'a.wav', size: 10, mtimeMs: 1000 }, { name: 'b.wav', size: 20, mtimeMs: 2000 }]
    const b = [a[1], a[0]]
    expect(audioDirFingerprint(a)).toBe(audioDirFingerprint(b))
    expect(audioDirFingerprint(a)).not.toBe(audioDirFingerprint([{ ...a[0], size: 11 }, a[1]]))
    expect(audioDirFingerprint([])).toBe('')
  })
})
