import { describe, it, expect } from 'vitest'
import {
  buildHyperframesSystemPrompt,
  extractHyperframesHtml,
  buildHyperframesPreviewHtml,
  buildHyperframesCaptureHtml,
  buildClipWindowScript,
  extractHyperframesMeta,
  HYPERFRAMES_COMPOSITION_ID,
} from './hyperframes.js'
import { DESIGN_SCAFFOLD_MARK } from './scaffold.js'

describe('buildHyperframesSystemPrompt', () => {
  it('demands one html block, the timeline contract, and determinism bans', () => {
    const p = buildHyperframesSystemPrompt()
    expect(p).toMatch(/```html/)
    expect(p).toContain('__timelines')
    expect(p).toContain('data-composition-id')
    expect(p).toContain('class="clip"')
    expect(p).toMatch(/paused: true/)
    expect(p).toMatch(/Date\.now/) // listed as forbidden
    expect(p).toContain(HYPERFRAMES_COMPOSITION_ID)
  })
  it('injects the art-direction brief when provided', () => {
    expect(buildHyperframesSystemPrompt({ brief: 'MOOD: neon noir' })).toContain('MOOD: neon noir')
  })
})

describe('extractHyperframesHtml', () => {
  it('pulls the fenced html block', () => {
    const reply = 'Here you go:\n```html\n<!doctype html><body>hi</body>\n```\nDone.'
    expect(extractHyperframesHtml(reply)).toBe('<!doctype html><body>hi</body>')
  })
  it('falls back to the whole text when unfenced', () => {
    expect(extractHyperframesHtml('  <div id="x"></div>  ')).toBe('<div id="x"></div>')
  })
  it('recovers the document from a TRUNCATED reply (unterminated fence)', () => {
    const cut = 'Composition below:\n```html\n<!doctype html><body><div id="design"><div class="clip">'
    expect(extractHyperframesHtml(cut)).toContain('id="design"')
    expect(extractHyperframesHtml(cut)).not.toContain('```')
  })
})

describe('buildHyperframesPreviewHtml', () => {
  const comp = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="design" data-composition-id="design"></div>
<script>const tl = gsap.timeline({paused:true}); window.__timelines={}; window.__timelines["design"]=tl;</script>
</body></html>`

  it('injects gsap in <head> and a play/loop bootstrap before </body>', () => {
    const out = buildHyperframesPreviewHtml(comp, 'tachi-preview://asset/gsap.min.js')
    // gsap loaded in head (before the composition script that uses window.gsap)
    expect(out).toMatch(/<script src="tachi-preview:\/\/asset\/gsap\.min\.js"><\/script><\/head>/)
    // bootstrap plays the registered timeline
    expect(out).toContain('window.__timelines')
    expect(out).toContain('.play(0)')
    // bootstrap comes AFTER the composition's own registering script
    expect(out.indexOf('__timelines["design"]=tl')).toBeLessThan(out.lastIndexOf('.play(0)'))
  })

  it('handles a bare composition with no <head>/<body>', () => {
    const bare = '<div id="design"></div><script>window.__timelines={design:1}</script>'
    const out = buildHyperframesPreviewHtml(bare, 'g.js')
    expect(out).toContain('<script src="g.js"></script>')
    expect(out).toContain('.play(0)')
  })

  it('stamps the scaffold version in both wrap branches (stale-preview detection)', () => {
    expect(buildHyperframesPreviewHtml(comp, 'g.js')).toContain(DESIGN_SCAFFOLD_MARK)
    expect(buildHyperframesPreviewHtml('<div id="design"></div>', 'g.js')).toContain(DESIGN_SCAFFOLD_MARK)
  })
})

describe('extractHyperframesMeta', () => {
  it('reads width/height/duration from the root data attributes', () => {
    const comp = '<div id="design" data-composition-id="design" data-width="1920" data-height="1080" data-duration="7.5">'
    expect(extractHyperframesMeta(comp)).toEqual({ width: 1920, height: 1080, duration: 7.5 })
  })

  it('falls back to 1280x720 @ 5s when attributes are missing or garbage', () => {
    expect(extractHyperframesMeta('<div id="design">')).toEqual({ width: 1280, height: 720, duration: 5 })
    expect(extractHyperframesMeta('<div data-width="zero" data-duration="-3">')).toEqual({ width: 1280, height: 720, duration: 5 })
  })

  it('clamps hallucinated extremes so a capture loop stays bounded', () => {
    const comp = '<div data-width="99999" data-height="4" data-duration="99999">'
    const m = extractHyperframesMeta(comp)
    expect(m.width).toBe(3840)
    expect(m.height).toBe(16)
    expect(m.duration).toBe(120)
  })
})

describe('buildHyperframesCaptureHtml', () => {
  const comp = '<!doctype html><html><head><style></style></head><body><div id="design"></div><script>window.__timelines={design:1}</script></body></html>'

  it('inlines gsap + the clip-window applier into <head> and never adds the play bootstrap', () => {
    const out = buildHyperframesCaptureHtml(comp, 'GSAP_SRC_HERE')
    expect(out).toContain('<script>GSAP_SRC_HERE</script>')
    expect(out).toContain('window.__hfApplyClips')
    // Injection lands inside <head>, before the composition's own markup.
    expect(out.indexOf('GSAP_SRC_HERE')).toBeLessThan(out.indexOf('</head>'))
    expect(out.indexOf('__hfApplyClips')).toBeLessThan(out.indexOf('</head>'))
    expect(out).not.toContain('.play(0)')
    expect(out).not.toContain('repeat(-1)')
  })

  it('handles a bare composition with no <head>/<body>', () => {
    const out = buildHyperframesCaptureHtml('<div id="design"></div>', 'G')
    expect(out.startsWith('<script>G</script>')).toBe(true)
    expect(out).toContain('window.__hfApplyClips')
  })

  it('clip-window applier toggles visibility by data-start/data-duration', () => {
    // The applier is host-run JS; sanity-check its semantics textually — it
    // must window direct .clip children and keep an end-of-video clip visible
    // at the final frame (end >= total → Infinity).
    const s = buildClipWindowScript()
    expect(s).toContain("classList.contains('clip')")
    expect(s).toContain('data-start')
    expect(s).toContain('end = Infinity')
    expect(s).toContain("style.visibility")
  })
})
