// apps/desktop/test/unit/extractArtifacts.test.ts
//
// Pure-function coverage for the chat artifact extractor
// (src/pages/chat/extractArtifacts.ts):
//   - ```html / ```svg fences of any size → 'html' / 'svg'
//   - ```mermaid fences of ANY size → 'mermaid' (no length threshold)
//   - generic fences only when ≥8 lines or ≥200 chars → 'code'
//   - standalone <svg> in prose → 'svg' (but never double-extracted from a
//     fence already captured)
//   - title derivation from comments (// # <!-- %%)
//
// The module only type-imports the store, so no zustand/persist shims needed.
import { describe, it, expect } from 'vitest'
import { extractArtifacts } from '../../src/pages/chat/extractArtifacts'

const MSG = 'msg-1'

describe('extractArtifacts: fenced html/svg', () => {
  it('tags a ```html fence as kind html regardless of size', () => {
    const out = extractArtifacts('```html\n<p>hi</p>\n```', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('html')
    expect(out[0].language).toBe('html')
    expect(out[0].content).toBe('<p>hi</p>')
    expect(out[0].messageId).toBe(MSG)
  })

  it('tags a ```svg fence as kind svg', () => {
    const out = extractArtifacts('```svg\n<svg viewBox="0 0 1 1"></svg>\n```', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('svg')
  })

  it('does not double-extract the <svg> inside a captured svg fence', () => {
    const out = extractArtifacts('```svg\n<svg viewBox="0 0 1 1"></svg>\n```', MSG)
    expect(out).toHaveLength(1)
  })
})

describe('extractArtifacts: mermaid fences', () => {
  it('tags a ```mermaid fence as kind mermaid even when tiny', () => {
    const out = extractArtifacts('```mermaid\nflowchart TD\n  A-->B\n```', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('mermaid')
    expect(out[0].language).toBe('mermaid')
    expect(out[0].content).toBe('flowchart TD\n  A-->B')
  })

  it('derives the title from a %% comment (but not a %%{init}%% directive)', () => {
    const titled = extractArtifacts('```mermaid\n%% checkout flow\nflowchart TD\n  A-->B\n```', MSG)
    expect(titled[0].title).toBe('checkout flow')

    const directive = extractArtifacts("```mermaid\n%%{init: {'theme':'dark'}}%%\nflowchart TD\n  A-->B\n```", MSG)
    expect(directive[0].title).toBe('mermaid block #1')
  })
})

describe('extractArtifacts: generic code threshold', () => {
  it('skips short fences (<8 lines and <200 chars)', () => {
    const out = extractArtifacts('```js\nconst a = 1\nconst b = 2\n```', MSG)
    expect(out).toHaveLength(0)
  })

  it('extracts a fence with 8+ lines as code', () => {
    const body = Array.from({ length: 8 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const out = extractArtifacts('```ts\n' + body + '\n```', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('code')
    expect(out[0].language).toBe('ts')
  })

  it('extracts a fence with 200+ chars as code even with few lines', () => {
    const body = 'const s = "' + 'x'.repeat(200) + '"'
    const out = extractArtifacts('```js\n' + body + '\n```', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('code')
  })

  it('derives the title from a leading // comment', () => {
    const body = '// tiny helper\n' + Array.from({ length: 8 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const out = extractArtifacts('```ts\n' + body + '\n```', MSG)
    expect(out[0].title).toBe('tiny helper')
  })
})

describe('extractArtifacts: standalone <svg> in prose', () => {
  it('extracts an inline <svg> outside any fence', () => {
    const out = extractArtifacts('Here is a diagram: <svg viewBox="0 0 2 2"><rect/></svg> — neat.', MSG)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('svg')
    expect(out[0].content).toContain('<rect/>')
  })

  it('mixes fences and prose svg, in order', () => {
    const text = '```html\n<p>page</p>\n```\n\nAnd inline: <svg viewBox="0 0 1 1"></svg>'
    const out = extractArtifacts(text, MSG)
    expect(out.map(a => a.kind)).toEqual(['html', 'svg'])
  })
})
