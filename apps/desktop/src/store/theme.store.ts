import { create } from 'zustand'
import { RETIRED_THEMES, type CustomTheme, type ThemeId } from '@tachi/core/src/settings/types'

/**
 * The active theme: a built-in id, or `custom:<slug>` pointing at an entry of
 * `customThemes` (imported from a design mockup — see
 * packages/core/src/design/theme-extract.ts).
 *
 * KNOWN LIMITATION — the first frame. index.html runs a tiny anti-FOUC script
 * that reads localStorage['tachi-theme'] and stamps `data-theme` before React
 * boots; its sha256 is pinned in the CSP (electron/main.ts). A custom theme's
 * CSS lives in settings, not in the bundle, so that first frame paints with the
 * DEFAULT palette and repaints once this store injects the sheet. Fixing it
 * would mean inlining user CSS into index.html and re-pinning the CSP hash —
 * deliberately not done.
 */
export type Theme = ThemeId

/** The themes that ship as a stylesheet. Custom ids are NOT listed here. */
export const VALID_THEMES: Theme[] = [
  'bankr', 'tachi-dark', 'tachi-neon', 'comic',
  'tachi-opus5', 'tachikoma-red',
]

/** The single <style> element every imported theme is injected through. */
export const CUSTOM_THEME_STYLE_ID = 'tachi-custom-themes'

export const isCustomTheme = (theme: string): theme is `custom:${string}` => theme.startsWith('custom:')

/** `custom:neo` -> `neo`; anything else -> null. */
export const customThemeSlug = (theme: string): string | null =>
  isCustomTheme(theme) ? theme.slice('custom:'.length) : null

/**
 * Write every stored custom theme into ONE <style> element (creating it on
 * first use, removing it when the list empties). Each block is already scoped
 * to its own `:root[data-theme="custom:<id>"]`, so having them all present is
 * inert — `data-theme` alone decides which one paints.
 *
 * A theme's optional STRUCTURE layer follows its palette block, so the geometry
 * can lean on the variables the palette just defined. It is scoped and its
 * keyframes are prefixed by the extractor (extractStructureCss), so it is inert
 * next to the other themes for exactly the same reason the palette block is.
 * Legacy entries have no structureCss and simply contribute nothing extra.
 */
function syncCustomThemeStyle(list: CustomTheme[]): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(CUSTOM_THEME_STYLE_ID)
  if (list.length === 0) {
    existing?.remove()
    return
  }
  const el = (existing ?? document.createElement('style')) as HTMLStyleElement
  el.id = CUSTOM_THEME_STYLE_ID
  el.textContent = list
    .map((t) => (t.structureCss ? `${t.css}\n${t.structureCss}` : t.css))
    .join('\n\n')
  if (!existing) document.head.appendChild(el)
}

const persist = (patch: { theme?: Theme; customThemes?: CustomTheme[] }) => {
  window.tachi?.settings.save(patch).catch(() => {})
}

interface ThemeStore {
  theme: Theme
  customThemes: CustomTheme[]
  setTheme: (t: Theme) => void
  /** Replace the whole list (boot hydration) — does NOT persist. */
  setCustomThemes: (list: CustomTheme[]) => void
  /** Add or replace by id, inject and persist. */
  addCustomTheme: (theme: CustomTheme) => void
  /** Remove by id; falls back to tachi-dark when the removed theme was active. */
  removeCustomTheme: (id: string) => void
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: 'tachi-dark',
  customThemes: [],
  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('tachi-theme', theme) } catch { /* storage unavailable */ }
    set({ theme })
    persist({ theme })
    window.tachi?.theme?.apply?.(theme).catch(() => {})
  },
  setCustomThemes: (customThemes) => {
    syncCustomThemeStyle(customThemes)
    set({ customThemes })
  },
  addCustomTheme: (theme) => {
    const next = [...get().customThemes.filter((t) => t.id !== theme.id), theme]
    syncCustomThemeStyle(next)
    set({ customThemes: next })
    persist({ customThemes: next })
  },
  removeCustomTheme: (id) => {
    const next = get().customThemes.filter((t) => t.id !== id)
    syncCustomThemeStyle(next)
    set({ customThemes: next })
    persist({ customThemes: next })
    if (get().theme === `custom:${id}`) get().setTheme('tachi-dark')
  },
}))

/**
 * A theme id read off disk, mapped to one this build can actually paint.
 *
 * RETIRED THEMES. A deleted theme is still sitting in the settings file (and in
 * localStorage) of every user who happened to be on it, and its sheet is gone
 * from the bundle — so stamping it verbatim gives a window with NO palette
 * variables at all, not a fallback. Coerce it to its replacement instead. The
 * caller also PERSISTS the corrected value, so this runs once per install.
 *
 * `custom:` ids and unknown ids pass through untouched: a custom theme's sheet
 * arrives from settings a moment later, and silently rewriting an id we simply
 * do not recognise would delete a user's imported theme on downgrade.
 */
function resolveSavedTheme(saved: Theme): { theme: Theme; migrated: boolean } {
  const replacement = RETIRED_THEMES[saved as string]
  return replacement
    ? { theme: replacement as Theme, migrated: true }
    : { theme: saved, migrated: false }
}

/**
 * Boot: stamp the saved theme, then make sure the imported sheets exist.
 *
 * `customThemes` is optional so the existing single-argument call site keeps
 * working; when it is omitted the store hydrates itself from settings (one
 * extra JSON read, best-effort). The theme attribute is stamped FIRST either
 * way — a custom theme simply repaints when its sheet lands.
 *
 * KNOWN LIMITATION, retired themes only: index.html's anti-FOUC script stamps
 * the RAW localStorage value before React exists, and its sha256 is pinned in
 * the CSP, so it cannot do the mapping. On the single boot after a theme is
 * retired the first frame therefore paints unstyled; the rewrite below fixes
 * every boot after that. Deliberately not worth re-pinning a CSP hash for.
 */
export function initTheme(savedRaw: Theme, customThemes?: CustomTheme[]) {
  const { theme: saved, migrated } = resolveSavedTheme(savedRaw)
  document.documentElement.setAttribute('data-theme', saved)
  useThemeStore.setState({ theme: saved })
  if (migrated) {
    // Self-heal both stores so neither the anti-FOUC script nor the next boot
    // ever sees the retired id again.
    try { localStorage.setItem('tachi-theme', saved) } catch { /* storage unavailable */ }
    persist({ theme: saved })
  }
  window.tachi?.theme?.apply?.(saved).catch(() => {})
  if (customThemes) {
    useThemeStore.getState().setCustomThemes(customThemes)
    return
  }
  window.tachi?.settings.load()
    .then((s) => {
      const list = s?.customThemes ?? []
      if (list.length > 0) useThemeStore.getState().setCustomThemes(list)
    })
    .catch(() => { /* no imported themes this session */ })
}
