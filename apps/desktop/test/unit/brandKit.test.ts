// test/unit/brandKit.test.ts — brandKitToMarkdown (pure) for brand-from-URL.
import { describe, it, expect } from 'vitest'
import { brandKitToMarkdown, type BrandKit } from '../../electron/services/page-render'

const KIT: BrandKit = {
  url: 'https://acme.example',
  siteName: 'Acme',
  colors: ['#0f9e8e', '#222222', '#e2637d'],
  fonts: ['Georgia', 'Inter'],
  logo: 'https://acme.example/logo.png',
  copy: ['Precision widgets, engineered.', 'Get started'],
}

describe('brandKitToMarkdown', () => {
  it('renders every harvested facet into the direction block', () => {
    const md = brandKitToMarkdown(KIT)
    expect(md).toContain('# Brand: Acme')
    expect(md).toContain('https://acme.example')
    expect(md).toContain('#0f9e8e, #222222, #e2637d')  // palette, order preserved
    expect(md).toContain('Georgia, Inter')
    expect(md).toContain('logo.png')
    expect(md).toContain('Precision widgets, engineered.')
    expect(md.toLowerCase()).toContain('use the palette')  // the design instruction
  })

  it('omits empty sections gracefully', () => {
    const md = brandKitToMarkdown({ url: 'https://x.test', siteName: 'X', colors: [], fonts: [], copy: [] })
    expect(md).toContain('# Brand: X')
    expect(md).not.toContain('**Palette**')
    expect(md).not.toContain('**Typefaces**')
    expect(md).not.toContain('**Logo**')
  })
})
