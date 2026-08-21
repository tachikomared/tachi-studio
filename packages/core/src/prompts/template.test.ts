import { describe, it, expect } from 'vitest'
import { extractVariables, extractUserVariables, renderTemplate, buildAutoVariableValues, starterTemplates } from './template.js'

describe('extractVariables', () => {
  it('returns unique names in first-appearance order', () => {
    expect(extractVariables('{{a}} then {{ b }} then {{a}} again')).toEqual(['a', 'b'])
  })
  it('ignores non-identifier braces (JSON/code in a template body)', () => {
    expect(extractVariables('const x = {{ 1: 2 }}; {"k": "v"} {{ok_name}}')).toEqual(['ok_name'])
  })
  it('empty body → no variables', () => {
    expect(extractVariables('no slots here')).toEqual([])
  })
})

describe('renderTemplate', () => {
  it('fills provided values', () => {
    expect(renderTemplate('Hi {{name}}, meet {{other}}', { name: 'Ann', other: 'Bob' })).toBe('Hi Ann, meet Bob')
  })
  it('keeps the literal slot when a value is missing or empty (nothing silently dropped)', () => {
    expect(renderTemplate('Hi {{name}}!', {})).toBe('Hi {{name}}!')
    expect(renderTemplate('Hi {{name}}!', { name: '' })).toBe('Hi {{name}}!')
  })
})

describe('starterTemplates', () => {
  it('ships a small seed set with stable ids and parseable variables', () => {
    const s = starterTemplates(123)
    expect(s.length).toBeGreaterThanOrEqual(4)
    for (const tItem of s) {
      expect(tItem.id.startsWith('starter-')).toBe(true)
      expect(tItem.createdAt).toBe(123)
      expect(() => extractVariables(tItem.body)).not.toThrow()
    }
    expect(extractVariables(s[0].body)).toContain('text')
  })
})

describe('auto-variables', () => {
  it('extractUserVariables drops the auto-vars, keeps real ones', () => {
    const body = 'On {{date}} at {{time}}, {{model}} on {{os}} should {{task}} for {{name}}.'
    expect(extractUserVariables(body)).toEqual(['task', 'name'])
    // extractVariables still returns everything
    expect(extractVariables(body)).toContain('date')
  })

  it('buildAutoVariableValues fills date/time/datetime/os/model deterministically', () => {
    const v = buildAutoVariableValues({ now: 1751932800000, os: 'Win32', model: 'claude-opus-4.8', locale: 'en-US' })
    expect(v.os).toBe('Win32')
    expect(v.model).toBe('claude-opus-4.8')
    expect(typeof v.date).toBe('string')
    expect(v.date.length).toBeGreaterThan(0)
    expect(typeof v.datetime).toBe('string')
  })

  it('renders auto-vars end to end, user values still win on collision', () => {
    const auto = buildAutoVariableValues({ now: 1751932800000, os: 'Linux', model: 'gpt-5', locale: 'en-US' })
    const body = 'model={{model}} os={{os}} name={{name}}'
    const out = renderTemplate(body, { ...auto, name: 'Ann' })
    expect(out).toContain('model=gpt-5')
    expect(out).toContain('os=Linux')
    expect(out).toContain('name=Ann')
    // user override wins
    expect(renderTemplate('{{model}}', { ...auto, model: 'OVERRIDE' })).toBe('OVERRIDE')
  })
})
