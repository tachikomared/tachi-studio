// apps/desktop/test/unit/applyStyle.test.ts
import { describe, it, expect } from 'vitest'
import { applyStyle, SD_STYLES } from '../../electron/services/sd-cpp-models'

describe('applyStyle (Fooocus-style prompt wrapping)', () => {
  it('substitutes {prompt} in the positive template', () => {
    const r = applyStyle({ id: 'c', positive: '{prompt}, cinematic, 4k', negative: 'flat' }, 'a fox')
    expect(r.positive).toBe('a fox, cinematic, 4k')
    expect(r.negative).toBe('flat')
  })

  it('appends the user prompt when the template has no {prompt}', () => {
    const r = applyStyle({ id: 'm', positive: 'masterpiece', negative: '' }, 'a dog')
    expect(r.positive).toBe('masterpiece, a dog')
  })

  it('uses the bare positive when there is no {prompt} and no user prompt', () => {
    expect(applyStyle({ id: 'm', positive: 'masterpiece', negative: '' }, '').positive).toBe('masterpiece')
  })

  it('merges the style negative with an existing negative', () => {
    expect(applyStyle({ id: 'c', positive: '{prompt}', negative: 'blurry' }, 'x', 'lowres').negative)
      .toBe('blurry, lowres')
    expect(applyStyle({ id: 'c', positive: '{prompt}', negative: '' }, 'x', 'lowres').negative)
      .toBe('lowres')
  })

  it('ships a passthrough "none" style and several real presets', () => {
    const none = SD_STYLES.find(s => s.id === 'none')!
    expect(applyStyle(none, 'hello')).toEqual({ positive: 'hello', negative: '' })
    expect(SD_STYLES.length).toBeGreaterThan(1)
    expect(SD_STYLES.map(s => s.id)).toContain('cinematic')
  })
})
