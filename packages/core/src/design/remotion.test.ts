// packages/core/src/design/remotion.test.ts
import { describe, it, expect } from 'vitest'
import { buildAnimationSystemPrompt, extractCompositionCode, sanitizeComposition, buildRemotionHtml, buildRemotionHtmlFromJs, buildRemotionEntry, REMOTION_GLOBALS } from './remotion.js'
import { DESIGN_SCAFFOLD_MARK } from './scaffold.js'

describe('REMOTION_GLOBALS', () => {
  it('exposes the audio/video media primitives so compositions can use sound', () => {
    expect(REMOTION_GLOBALS).toContain('Audio')
    expect(REMOTION_GLOBALS).toContain('Video')
    expect(REMOTION_GLOBALS).toContain('OffthreadVideo')
  })
})

describe('buildAnimationSystemPrompt', () => {
  it('demands a single tsx block, the Composition+config exports, and forbids CSS animation', () => {
    const p = buildAnimationSystemPrompt()
    expect(p).toMatch(/```tsx/)
    expect(p).toContain('Composition')
    expect(p).toContain('config')
    expect(p).toMatch(/useCurrentFrame/)
    expect(p).toMatch(/FORBIDDEN/)
    // lists the in-scope globals so the model writes no imports
    expect(p).toContain(REMOTION_GLOBALS[1]) // useCurrentFrame
  })
  it('teaches <Audio> with the allowed sources (https or user-named staticFile) and bans invented files', () => {
    const p = buildAnimationSystemPrompt()
    expect(p).toMatch(/<Audio/)
    expect(p).toMatch(/https/)
    expect(p).toMatch(/staticFile\(/)
    expect(p).toMatch(/never invent/i)
  })
  it('appends context when provided', () => {
    expect(buildAnimationSystemPrompt({ context: 'brand: ACME' })).toContain('brand: ACME')
  })
  it("embeds Remotion's official authoring rules (clamp, interpolate-first, useVideoConfig)", () => {
    const p = buildAnimationSystemPrompt()
    expect(p).toMatch(/official/i)
    expect(p).toMatch(/clamp/)
    expect(p).toMatch(/useVideoConfig/)
  })
  it('injects the art-direction brief when provided', () => {
    expect(buildAnimationSystemPrompt({ brief: 'MOTION BEATS: spring in' })).toMatch(/ART DIRECTION/)
  })
})

describe('extractCompositionCode', () => {
  it('prefers a tsx fence', () => {
    const reply = 'sure:\n```tsx\nconst Composition = () => null\nconst config = {}\n```\n'
    expect(extractCompositionCode(reply)).toContain('const Composition')
  })
  it('falls back to a bare fence, then raw', () => {
    expect(extractCompositionCode('```\nconst x = 1\n```')).toBe('const x = 1')
    expect(extractCompositionCode('const y = 2')).toBe('const y = 2')
  })
})

describe('sanitizeComposition', () => {
  it('strips import lines and export keywords', () => {
    const code = [
      "import React from 'react'",
      "import { interpolate } from 'remotion'",
      'export const Composition = () => null',
      'export default Composition',
      'export { config }',
    ].join('\n')
    const out = sanitizeComposition(code)
    expect(out).not.toMatch(/^\s*import /m)
    expect(out).toContain('const Composition = () => null')
    expect(out).not.toMatch(/export\s+default/)
    expect(out).not.toMatch(/export\s*\{/)
  })
})

describe('buildRemotionHtml', () => {
  it('produces a self-contained Player page with the (sanitized) composition inlined', () => {
    const html = buildRemotionHtml("import {interpolate} from 'remotion'\nexport const Composition = () => null\nconst config = { fps: 24 }")
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@remotion/player')
    expect(html).toContain('importmap')
    expect(html).toContain('createRoot')
    expect(html).toContain('const Composition = () => null')
    // import line stripped, export keyword removed
    expect(html).not.toMatch(/import \{interpolate\}/)
    expect(html).toContain('@babel/standalone')
    expect(html).toContain('id="err"') // error surface present
  })
  it('puts the media primitives in scope (Audio/Video/OffthreadVideo destructured from remotion)', () => {
    const html = buildRemotionHtml('const Composition = () => null')
    expect(html).toMatch(/const \{[^}]*\bAudio\b[^}]*\} = Remotion/)
    expect(html).toMatch(/const \{[^}]*\bVideo\b[^}]*\} = Remotion/)
    expect(html).toMatch(/const \{[^}]*\bOffthreadVideo\b[^}]*\} = Remotion/)
  })
})

describe('buildRemotionEntry', () => {
  it('produces a registerRoot entry that aliases Remotion Composition and wires config', () => {
    const entry = buildRemotionEntry("import {interpolate} from 'remotion'\nexport const Composition = () => null\nconst config = { durationInFrames: 90, fps: 24, width: 1080, height: 1920 }")
    // imports React + remotion globals + registerRoot, aliasing Remotion's <Composition>
    expect(entry).toMatch(/import React from 'react'/)
    expect(entry).toMatch(/Composition as RemotionComposition/)
    expect(entry).toMatch(/registerRoot\(RemotionRoot\)/)
    // the user's import is stripped, the component is inlined
    expect(entry).not.toMatch(/import \{interpolate\}/)
    expect(entry).toContain('const Composition = () => null')
    // dimensions/duration are read from the generated `config`, with safe fallbacks
    expect(entry).toContain('__cfg.durationInFrames')
    expect(entry).toContain('__cfg.fps')
    expect(entry).toContain('component: Composition')
  })
  it('uses the given composition id and a guarded (>=1) duration', () => {
    const entry = buildRemotionEntry('const Composition = () => null; const config = {};', 'promo')
    expect(entry).toContain('id: "promo"')
    expect(entry).toMatch(/Math\.max\(1, Math\.round\(__cfg\.durationInFrames \|\| 150\)\)/)
  })
  it('imports the media primitives so exported MP4s can carry sound', () => {
    const entry = buildRemotionEntry('const Composition = () => null')
    expect(entry).toMatch(/import \{[^}]*\bAudio\b[^}]*\} from 'remotion'/)
    expect(entry).toMatch(/import \{[^}]*\bVideo\b[^}]*\} from 'remotion'/)
    expect(entry).toMatch(/import \{[^}]*\bOffthreadVideo\b[^}]*\} from 'remotion'/)
  })
})

describe('buildRemotionHtmlFromJs', () => {
  it('emits a Babel-FREE ES-module Player page with the compiled JS inlined', () => {
    const html = buildRemotionHtmlFromJs('const Composition = () => React.createElement("div"); const config = { fps: 30 };')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@remotion/player')
    expect(html).toContain('importmap')
    expect(html).toContain('createRoot')
    expect(html).toContain('React.createElement("div")') // compiled js inlined verbatim
    // the whole point of the fast path: no Babel download, no runtime transpile
    expect(html).not.toContain('@babel/standalone')
    expect(html).not.toContain('text/babel')
    expect(html).toContain('type="module"')
    expect(html).toContain('id="err"') // error surface preserved
  })
  it('puts the media primitives in scope (Audio/Video/OffthreadVideo destructured from remotion)', () => {
    const html = buildRemotionHtmlFromJs('const Composition = () => null;')
    expect(html).toMatch(/const \{[^}]*\bAudio\b[^}]*\} = Remotion/)
    expect(html).toMatch(/const \{[^}]*\bVideo\b[^}]*\} = Remotion/)
    expect(html).toMatch(/const \{[^}]*\bOffthreadVideo\b[^}]*\} = Remotion/)
  })
  it('recovers the module from a TRUNCATED reply (unterminated trailing fence)', () => {
    // A reply cut at the output limit ends INSIDE the fence — the old extractor
    // found zero blocks and the whole build failed with "no Composition".
    const cut = 'Here is the animation:\n```tsx\nconst config = { fps: 30 };\nconst Composition = () => {\n  return <AbsoluteFill>'
    expect(extractCompositionCode(cut)).toContain('const Composition')
    // Closed helper block + truncated main block → the main block still wins.
    const mixed = '```ts\nconst helper = 1\n```\nNow the module:\n```tsx\nconst Composition = () => null\nconst config = { fps: 30, durationInFrames: 300, width: 1920, height: 1080 }\n// …cut here'
    expect(extractCompositionCode(mixed)).toContain('const Composition')
  })
  it('raises the Player shared-audio pool past the default 5 and shows errors readably', () => {
    // Default numberOfSharedAudioTags is 5 and the Player THROWS when a 6th
    // simultaneous <Audio> mounts — SFX-heavy compositions died mid-playback
    // with a bare ⚠ triangle. Both scaffolds must raise the pool and render
    // the actual error text via errorFallback.
    for (const html of [buildRemotionHtml('const Composition = () => null;'), buildRemotionHtmlFromJs('const Composition = () => null;')]) {
      expect(html).toContain('numberOfSharedAudioTags: 32')
      expect(html).toContain('errorFallback')
      expect(html).toContain('Composition error:')
    }
  })
  it('stamps the scaffold version so DesignPage can detect stale baked previews', () => {
    // Preview html is persisted per message at generation time; without the
    // stamp, sessions built before a scaffold fix replay the old scaffold
    // forever (this is exactly how the audio-pool crash survived one ship).
    for (const html of [buildRemotionHtml('const Composition = () => null;'), buildRemotionHtmlFromJs('const Composition = () => null;')]) {
      expect(html).toContain(DESIGN_SCAFFOLD_MARK)
    }
  })
})

describe('buildAnimationSystemPrompt · audioFiles', () => {
  it('lists ONLY the provided files via staticFile() and forbids invented names', () => {
    const p = buildAnimationSystemPrompt({ audioFiles: ['vo-1.wav', 'sfx-click.wav'] })
    expect(p).toContain("staticFile('vo-1.wav')")
    expect(p).toContain("staticFile('sfx-click.wav')")
    expect(p).toContain('ONLY audio you may reference')
    expect(p).toMatch(/NEVER invent an audio filename/)
  })
  it('omits the AUDIO section entirely when no files exist', () => {
    expect(buildAnimationSystemPrompt({})).not.toContain('AUDIO —')
    expect(buildAnimationSystemPrompt({ audioFiles: [] })).not.toContain('AUDIO —')
    expect(buildAnimationSystemPrompt({ audioFiles: ['  '] })).not.toContain('AUDIO —')
  })
})
