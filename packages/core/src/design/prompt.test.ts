// packages/core/src/design/prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildDesignSystemPrompt, extractHtmlDocument, renderSpec, buildBriefSystemPrompt, buildClarifySystemPrompt, parseClarifyReply, clarifyQuestionsToText } from './prompt.js'
import { BRAND_PRESETS, getPreset } from './presets.js'

describe('buildDesignSystemPrompt', () => {
  it('states the single-self-contained-HTML output contract', () => {
    const p = buildDesignSystemPrompt()
    expect(p).toMatch(/```html/)
    expect(p).toMatch(/self-contained/i)
    expect(p).toMatch(/<!doctype html>/i)
    expect(p).toMatch(/responsive/i)
  })

  it('injects the chosen preset palette + label', () => {
    const preset = getPreset('linear')!
    const p = buildDesignSystemPrompt({ preset })
    expect(p).toContain('Linear')
    expect(p).toContain(preset.spec.colors.accent) // #5e6ad2
    expect(p).toMatch(/DESIGN SYSTEM/i)
  })

  it('appends DESIGN.md direction and an iteration clause when asked', () => {
    const p = buildDesignSystemPrompt({ designMd: 'Use a duotone teal scheme.', iterating: true })
    expect(p).toContain('Use a duotone teal scheme.')
    expect(p).toMatch(/REFINING/i)
    expect(p).toMatch(/FULL updated document/i)
  })

  it('states the nine-section design discipline + anti-patterns', () => {
    const p = buildDesignSystemPrompt()
    expect(p).toMatch(/ANTI-PATTERNS/)
    expect(p).toMatch(/TYPOGRAPHY/)
    expect(p).toMatch(/HIERARCHY|hierarchy/)
  })

  it('injects the art-direction brief to implement exactly', () => {
    const p = buildDesignSystemPrompt({ brief: 'PALETTE: #ff0000 bg, #ffffff text' })
    expect(p).toMatch(/ART DIRECTION/)
    expect(p).toContain('PALETTE: #ff0000 bg')
  })

  it('enforces progressive enhancement (visible without JS) and bans AI-tell copy', () => {
    const p = buildDesignSystemPrompt()
    expect(p).toMatch(/without JS/i)        // page renders without scripts
    expect(p).toContain('opacity:0')        // never stuck-hidden behind a reveal
    expect(p).toMatch(/em-dash/i)           // anti-AI-tell copy rule
  })

  it('injects the design-taste layer: bans the AI-purple/cyan cliché + fake product UI + decorative version tags', () => {
    const p = buildDesignSystemPrompt()
    expect(p).toMatch(/DESIGN TASTE/)
    expect(p).toMatch(/purple\/indigo\/violet \+ cyan/i) // the AI-default palette is banned
    expect(p).toMatch(/Fake product UI/i)                // styled-div mockups banned
    expect(p).toMatch(/ONE accent color across the whole page/i)
  })
})

describe('buildBriefSystemPrompt', () => {
  it('demands concrete direction — palette, type, anti-patterns; layout for pages', () => {
    const page = buildBriefSystemPrompt('page')
    expect(page).toMatch(/PALETTE/)
    expect(page).toMatch(/AVOID/)
    expect(page).toMatch(/LAYOUT/)
    expect(page).not.toMatch(/MOTION BEATS/)
  })
  it('asks for timed motion beats in animate mode', () => {
    expect(buildBriefSystemPrompt('animate')).toMatch(/MOTION BEATS/)
  })
})

describe('buildClarifySystemPrompt', () => {
  it('asks a few clarifying questions, as strict JSON, and forbids producing a design yet', () => {
    const p = buildClarifySystemPrompt('page')
    expect(p).toMatch(/3.?5 questions/i)
    expect(p).toMatch(/DO NOT produce any design yet/i)
    expect(p).toMatch(/reference image|project code/i) // skip what's already provided
    expect(p).toContain('"questions"') // the structured-interview contract
    expect(p).toMatch(/ONLY a JSON object/i)
    expect(p).toMatch(/never include it as an option/i) // "you decide" is UI-provided
  })
  it('focuses on motion specifics in animate mode', () => {
    expect(buildClarifySystemPrompt('animate')).toMatch(/duration & mood|must-hit beats/i)
  })
})

describe('parseClarifyReply', () => {
  it('parses the strict-JSON contract', () => {
    const qs = parseClarifyReply('{"questions":[{"q":"Vibe?","options":["sleek","loud"],"default":"sleek"}]}')
    expect(qs).toEqual([{ q: 'Vibe?', options: ['sleek', 'loud'], default: 'sleek' }])
  })
  it('tolerates fences and surrounding prose', () => {
    const qs = parseClarifyReply('Sure!\n```json\n{"questions":[{"q":"Who is it for?","options":["devs"]}]}\n```')
    expect(qs?.[0].q).toBe('Who is it for?')
    expect(qs?.[0].options).toEqual(['devs'])
    expect(qs?.[0].default).toBeUndefined()
  })
  it('returns null for plain-text replies (legacy fallback)', () => {
    expect(parseClarifyReply('1. Who is it for?\n2. What vibe?')).toBeNull()
  })
  it('drops malformed entries and caps counts', () => {
    const qs = parseClarifyReply(JSON.stringify({
      questions: [{ q: '' }, { q: 'Real?', options: ['a', '', 'b'], default: 42 }],
    }))
    expect(qs).toEqual([{ q: 'Real?', options: ['a', 'b'], default: undefined }])
  })
})

describe('clarifyQuestionsToText', () => {
  it('renders numbered lines with options and defaults', () => {
    const text = clarifyQuestionsToText([
      { q: 'Vibe?', options: ['sleek', 'loud'], default: 'sleek' },
      { q: 'Anything else?', options: [] },
    ])
    expect(text).toBe('1. Vibe? (sleek / loud — default: sleek)\n2. Anything else?')
  })
})

describe('renderSpec', () => {
  it('renders palette, type, radius, density and motion lines', () => {
    const out = renderSpec(getPreset('tachi-brutalist')!.spec)
    expect(out).toMatch(/Palette:/)
    expect(out).toContain('#39ff14')
    expect(out).toMatch(/Corner radius: 0px/)
    expect(out).toMatch(/Motion:/)
  })
})

describe('extractHtmlDocument', () => {
  it('pulls the inner HTML from a ```html fenced block, dropping prose', () => {
    const reply = 'Here is your page:\n\n```html\n<!doctype html>\n<html><body>Hi</body></html>\n```\n\nHope you like it!'
    const html = extractHtmlDocument(reply)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<body>Hi</body>')
    expect(html).not.toContain('Hope you like it')
  })

  it('extracts a raw doctype document with no fences', () => {
    const reply = '<!DOCTYPE html>\n<html><head></head><body>Raw</body></html>'
    expect(extractHtmlDocument(reply)).toContain('<body>Raw</body>')
  })

  it('prepends a doctype when the document starts at <html>', () => {
    const reply = '```html\n<html lang="en"><body>x</body></html>\n```'
    expect(extractHtmlDocument(reply).toLowerCase().startsWith('<!doctype html>')).toBe(true)
  })

  it('falls back to a generic fenced block that contains a doc marker', () => {
    const reply = '```\n<!doctype html><html><body>g</body></html>\n```'
    expect(extractHtmlDocument(reply)).toContain('<body>g</body>')
  })

  it('returns trimmed text when there is no document at all', () => {
    expect(extractHtmlDocument('  just words  ')).toBe('just words')
    expect(extractHtmlDocument('')).toBe('')
  })
})

describe('BRAND_PRESETS', () => {
  it('has unique ids and complete specs', () => {
    const ids = BRAND_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(BRAND_PRESETS.length).toBeGreaterThanOrEqual(8)
    for (const p of BRAND_PRESETS) {
      expect(p.spec.colors.accent).toMatch(/^#|rgb/)
      expect(p.spec.fonts.heading).toBeTruthy()
      expect(p.label).toBeTruthy()
    }
  })
})
