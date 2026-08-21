// Design media assets: the fail-closed name gate the tachi-preview:// assets/
// route trusts (util/design-assets), and the prompt block the composer hands
// the generator (attach-media). Both PURE — no electron, no DOM.
import { describe, it, expect } from 'vitest'
import { isDesignAssetName, designAssetMime, toDesignAssetName } from '../../electron/services/util/design-assets'
import { buildAssetPromptBlock, assetChipLabel } from '../../src/pages/design/attach-media'

describe('isDesignAssetName (preview-protocol trust gate)', () => {
  it('accepts bare media filenames', () => {
    for (const n of ['0.mp4', 'crab clip (v2).webm', 'My_Track-01.mp3', 'loop.gif', 'vo take.wav']) {
      expect(isDesignAssetName(n), n).toBe(true)
    }
  })
  it('rejects traversal, separators, dotfiles, and non-media extensions', () => {
    for (const n of ['../secrets.mp4', 'a/b.mp4', 'a\\b.mp4', '.hidden.mp4', 'page.html', 'run.exe', 'clip.mkv', '', 'mp4']) {
      expect(isDesignAssetName(n), n).toBe(false)
    }
  })
})

describe('designAssetMime', () => {
  it('maps known extensions and refuses everything else', () => {
    expect(designAssetMime('0.mp4')).toBe('video/mp4')
    expect(designAssetMime('a.gif')).toBe('image/gif')
    expect(designAssetMime('a.wav')).toBe('audio/wav')
    expect(designAssetMime('a.html')).toBeNull()
    expect(designAssetMime('../a.mp4')).toBeNull()
  })
})

describe('toDesignAssetName', () => {
  it('strips directories and sanitizes into a servable name', () => {
    expect(toDesignAssetName('D:\\projects\\myshit\\0.mp4')).toBe('0.mp4')
    expect(toDesignAssetName('/tmp/крабик!!.mp4')).toBe('asset.mp4')
    expect(toDesignAssetName('my clip (final).MOV')).toBe('my clip (final).mov')
  })
  it('returns null for non-media extensions', () => {
    expect(toDesignAssetName('page.html')).toBeNull()
    expect(toDesignAssetName('noext')).toBeNull()
  })
  it('round-trips through the trust gate', () => {
    const n = toDesignAssetName('weird   name---.mp4')!
    expect(isDesignAssetName(n)).toBe(true)
  })
})

describe('buildAssetPromptBlock', () => {
  it('names the exact relative URL and forbids placeholders', () => {
    const block = buildAssetPromptBlock('0.mp4', 'video/mp4', { durationSec: 5.0, width: 1280, height: 720 })
    expect(block).toContain('assets/0.mp4')
    expect(block).toContain('src="assets/0.mp4"')
    expect(block).toContain('video/mp4, 5.0s, 1280×720')
    expect(block).toContain('do NOT ask for it')
  })
  it('omits unknown metadata instead of inventing it', () => {
    const block = buildAssetPromptBlock('a.mp3', 'audio/mpeg', {})
    expect(block).toContain('(audio/mpeg)')
    expect(block).not.toContain('NaN')
    expect(block).not.toContain('undefined')
  })
})

describe('assetChipLabel', () => {
  it('shows name and duration when known', () => {
    expect(assetChipLabel('0.mp4', { durationSec: 5.04 })).toBe('🎞 0.mp4 · 5.0s')
    expect(assetChipLabel('a.mp3', {})).toBe('🎞 a.mp3')
  })
})
