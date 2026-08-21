// apps/desktop/test/unit/customThemeStore.test.ts
//
// Store-level coverage for imported ("custom:") themes in
// src/store/theme.store.ts: the ONE <style id="tachi-custom-themes"> element,
// the data-theme handoff, persistence through window.tachi.settings.save, and
// the cleanup paths (remove the active theme, remove the last theme).
//
// The desktop vitest env is 'node', so a minimal document/localStorage/window
// stub is installed BEFORE the store is imported — same recipe as
// artifactsStore.test.ts, but the DOM shim also has to model head children so
// getElementById/remove behave like the real thing.

import { describe, it, expect, beforeEach } from 'vitest'

interface FakeEl {
  id: string
  textContent: string
  remove(): void
}

const headChildren: FakeEl[] = []
const attrs: Record<string, string> = {}
const memStore = new Map<string, string>()
const saved: Array<Record<string, unknown>> = []

;(globalThis as Record<string, unknown>).document = {
  documentElement: {
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    getAttribute: (k: string) => attrs[k] ?? null,
  },
  createElement: (): FakeEl => {
    const el: FakeEl = {
      id: '',
      textContent: '',
      remove() {
        const i = headChildren.indexOf(el)
        if (i >= 0) headChildren.splice(i, 1)
      },
    }
    return el
  },
  getElementById: (id: string) => headChildren.find((c) => c.id === id) ?? null,
  head: { appendChild: (el: FakeEl) => { headChildren.push(el) } },
}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: {
    settings: {
      save: async (patch: Record<string, unknown>) => { saved.push(patch) },
      load: async () => ({ theme: 'tachi-dark', customThemes: [] }),
    },
    theme: { apply: async () => {} },
  },
}

const { useThemeStore, CUSTOM_THEME_STYLE_ID, isCustomTheme, customThemeSlug, initTheme } =
  await import('../../src/store/theme.store')

const styleEl = () => headChildren.find((c) => c.id === CUSTOM_THEME_STYLE_ID) ?? null

const theme = (id: string, label = id) => ({
  id,
  label,
  css: `/* ${label} */\n:root[data-theme="custom:${id}"] { --bg-base: #101010; --accent: #7c5cff; }\n`,
})

/** The same theme WITH the optional structure layer an import can now carry. */
const themeWithStructure = (id: string, label = id) => ({
  ...theme(id, label),
  structureCss:
    `/* Structure layer for "${label}" — custom:${id} */\n` +
    `:root[data-theme="custom:${id}"] button { clip-path: polygon(9px 0, 100% 0, 0 100%); }\n` +
    `@keyframes custom-${id}-pulse { 0% { opacity: 1; } }\n`,
})

beforeEach(() => {
  headChildren.length = 0
  saved.length = 0
  memStore.clear()
  for (const k of Object.keys(attrs)) delete attrs[k]
  useThemeStore.setState({ theme: 'tachi-dark', customThemes: [] })
})

describe('custom theme id helpers', () => {
  it('recognises and unwraps the custom: prefix', () => {
    expect(isCustomTheme('custom:neo')).toBe(true)
    expect(isCustomTheme('tachi-dark')).toBe(false)
    expect(customThemeSlug('custom:neo')).toBe('neo')
    expect(customThemeSlug('comic')).toBeNull()
  })
})

describe('apply / persist round-trip', () => {
  it('injects ONE style element and persists the list', () => {
    useThemeStore.getState().addCustomTheme(theme('neo', 'Neo Brutal'))

    const el = styleEl()
    expect(el).not.toBeNull()
    expect(headChildren.filter((c) => c.id === CUSTOM_THEME_STYLE_ID)).toHaveLength(1)
    expect(el!.textContent).toContain(':root[data-theme="custom:neo"]')
    expect(saved).toEqual([{ customThemes: [expect.objectContaining({ id: 'neo' })] }])
  })

  it('stamps data-theme, localStorage and settings when the theme is activated', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().setTheme('custom:neo')

    expect(attrs['data-theme']).toBe('custom:neo')
    expect(memStore.get('tachi-theme')).toBe('custom:neo')
    expect(saved.at(-1)).toEqual({ theme: 'custom:neo' })
  })

  it('keeps every imported sheet in the SAME element (they are inert until selected)', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().addCustomTheme(theme('pastel'))

    expect(headChildren.filter((c) => c.id === CUSTOM_THEME_STYLE_ID)).toHaveLength(1)
    expect(styleEl()!.textContent).toContain('custom:neo')
    expect(styleEl()!.textContent).toContain('custom:pastel')
  })

  it('replaces an existing theme with the same id instead of duplicating it', () => {
    useThemeStore.getState().addCustomTheme(theme('neo', 'Neo v1'))
    useThemeStore.getState().addCustomTheme({ ...theme('neo', 'Neo v2'), css: '/* v2 */\n:root[data-theme="custom:neo"] { --bg-base: #fff; }' })

    const list = useThemeStore.getState().customThemes
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('Neo v2')
    expect(styleEl()!.textContent).toContain('/* v2 */')
    expect(styleEl()!.textContent).not.toContain('#101010')
  })
})

// The optional structure layer (packages/core/src/design/theme-extract.ts):
// palette first, chassis right after it, both inside the one shared element.
describe('structure layer', () => {
  it('injects the structure sheet AFTER its own palette block', () => {
    useThemeStore.getState().addCustomTheme(themeWithStructure('neo'))

    const css = styleEl()!.textContent
    expect(css).toContain('@keyframes custom-neo-pulse')
    expect(css.indexOf('--bg-base')).toBeLessThan(css.indexOf('clip-path'))
  })

  it('persists structureCss alongside the palette', () => {
    useThemeStore.getState().addCustomTheme(themeWithStructure('neo'))
    expect(saved).toEqual([{
      customThemes: [expect.objectContaining({ id: 'neo', structureCss: expect.stringContaining('clip-path') })],
    }])
  })

  it('leaves a LEGACY entry (no structureCss) exactly as it was', () => {
    useThemeStore.getState().addCustomTheme(theme('legacy'))
    expect(styleEl()!.textContent).toBe(theme('legacy').css)
  })

  it('mixes legacy and structured themes in the same element', () => {
    useThemeStore.getState().addCustomTheme(theme('legacy'))
    useThemeStore.getState().addCustomTheme(themeWithStructure('neo'))

    const css = styleEl()!.textContent
    expect(headChildren.filter((c) => c.id === CUSTOM_THEME_STYLE_ID)).toHaveLength(1)
    expect(css).toContain('custom:legacy')
    expect(css).toContain('@keyframes custom-neo-pulse')
  })

  it('takes the structure layer away with the theme', () => {
    useThemeStore.getState().addCustomTheme(themeWithStructure('neo'))
    useThemeStore.getState().addCustomTheme(theme('pastel'))
    useThemeStore.getState().removeCustomTheme('neo')

    expect(styleEl()!.textContent).not.toContain('clip-path')
  })

  it('drops the structure layer when a theme is re-imported without one', () => {
    useThemeStore.getState().addCustomTheme(themeWithStructure('neo'))
    useThemeStore.getState().addCustomTheme(theme('neo'))

    expect(styleEl()!.textContent).not.toContain('clip-path')
  })
})

describe('removal', () => {
  it('drops the sheet and persists the shorter list', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().addCustomTheme(theme('pastel'))
    saved.length = 0

    useThemeStore.getState().removeCustomTheme('neo')

    expect(useThemeStore.getState().customThemes.map((t) => t.id)).toEqual(['pastel'])
    expect(styleEl()!.textContent).not.toContain('custom:neo')
    expect(saved[0]).toEqual({ customThemes: [expect.objectContaining({ id: 'pastel' })] })
  })

  it('removes the <style> element entirely when the last theme goes', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().removeCustomTheme('neo')
    expect(styleEl()).toBeNull()
  })

  it('falls back to tachi-dark when the ACTIVE theme is deleted', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().setTheme('custom:neo')

    useThemeStore.getState().removeCustomTheme('neo')

    expect(useThemeStore.getState().theme).toBe('tachi-dark')
    expect(attrs['data-theme']).toBe('tachi-dark')
  })

  it('leaves the active BUILT-IN theme alone when another custom theme is deleted', () => {
    useThemeStore.getState().addCustomTheme(theme('neo'))
    useThemeStore.getState().setTheme('comic')
    useThemeStore.getState().removeCustomTheme('neo')
    expect(useThemeStore.getState().theme).toBe('comic')
  })
})

describe('initTheme', () => {
  it('stamps the saved theme and injects the sheets it was handed', () => {
    initTheme('custom:neo', [theme('neo')])
    expect(attrs['data-theme']).toBe('custom:neo')
    expect(useThemeStore.getState().customThemes).toHaveLength(1)
    expect(styleEl()!.textContent).toContain('custom:neo')
  })

  it('does not persist anything on boot (hydration is not a user edit)', () => {
    initTheme('custom:neo', [theme('neo')])
    expect(saved).toEqual([])
  })

  it('injects nothing when there are no imported themes', () => {
    initTheme('tachi-dark', [])
    expect(styleEl()).toBeNull()
  })
})
