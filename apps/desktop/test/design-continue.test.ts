// Pure helpers of the design generation pipeline — the continuation stitcher
// and the animate validity gate (the parts that decide whether a follow-up
// build survives an output-limit cut or a conversational reply).
import { describe, it, expect } from 'vitest'
import { stitchContinuation, animationValid, repairPrompt } from '../electron/services/design-continue'

describe('stitchContinuation', () => {
  it('appends a clean continuation verbatim', () => {
    expect(stitchContinuation('const a = 1\nconst b =', ' 2\nconst c = 3')).toBe('const a = 1\nconst b = 2\nconst c = 3')
  })
  it('drops a re-opened code fence when the partial is inside an unclosed fence', () => {
    const prev = 'Here:\n```tsx\nconst Composition = () => {\n  return ('
    const cont = '```tsx\n    <AbsoluteFill />\n  )\n}\n```'
    const out = stitchContinuation(prev, cont)
    expect(out).toContain('const Composition')
    expect(out).toContain('<AbsoluteFill />')
    // the re-opened fence is gone; the CLOSING fence of the module survives
    expect(out.match(/```/g)?.length).toBe(2)
  })
  it('keeps a fence that opens OUTSIDE any unclosed fence (prose partials)', () => {
    const prev = 'Sure — here is the plan.'
    const cont = '\n```tsx\nconst Composition = () => null\n```'
    expect(stitchContinuation(prev, cont)).toContain('```tsx')
  })
  it('de-duplicates an overlapping seam (model repeats the tail it was cut on)', () => {
    const prev = 'const config = { fps: 30, durationInFrames: 300 }'
    const cont = 'fps: 30, durationInFrames: 300 }\nconst Composition = () => null'
    const out = stitchContinuation(prev, cont)
    expect(out).toBe('const config = { fps: 30, durationInFrames: 300 }\nconst Composition = () => null')
  })
})

describe('animationValid', () => {
  it('remotion needs a Composition component', () => {
    expect(animationValid('const Composition = () => null', 'remotion')).toBe(true)
    expect(animationValid('const Comp = () => null', 'remotion')).toBe(false)
    expect(animationValid('', 'remotion')).toBe(false)
    expect(animationValid(undefined, 'remotion')).toBe(false)
  })
  it('hyperframes needs the __timelines registration', () => {
    expect(animationValid('<script>window.__timelines = { design: tl }</script>', 'hyperframes')).toBe(true)
    expect(animationValid('<div id="design"></div>', 'hyperframes')).toBe(false)
  })
})

describe('repairPrompt', () => {
  it('is engine-specific and demands one full fenced module', () => {
    expect(repairPrompt('remotion')).toContain('const Composition')
    expect(repairPrompt(undefined)).toContain('const Composition') // remotion is the default engine
    expect(repairPrompt('hyperframes')).toContain('__timelines')
  })
})
