// apps/desktop/src/i18n/index.ts
//
// react-i18next setup for the renderer. Resources live in
// ./locales/<lng>/<namespace>.json and are LAZY-loaded per (language,
// namespace) via Vite's import.meta.glob — only the active language's
// namespaces are fetched, and any missing translation falls back to English.
//
// One namespace per page (+ 'common' for shared UI like the sidebar) so that
// string extraction can fan out per page without editing a central registry:
// an extractor just drops locales/<lng>/<page>.json and it's picked up here.

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import resourcesToBackend from 'i18next-resources-to-backend'

/** Soft-standard set + Russian. All left-to-right (no RTL handling needed). */
export const SUPPORTED_LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

/** Native-name labels for the language switcher. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
}

// Build-time map of every bundled locale JSON → lazy import() loader. Vite emits
// each as its own chunk, so a file is fetched only when its (lng, ns) is needed.
const modules = import.meta.glob('./locales/**/*.json')

function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem('tachi-locale')
    if (v && (SUPPORTED_LOCALES as readonly string[]).includes(v)) return v as Locale
  } catch {
    /* localStorage unavailable (e.g. overlay window) — default to English */
  }
  return 'en'
}

void i18n
  .use(
    resourcesToBackend((lng: string, ns: string) => {
      const loader = modules[`./locales/${lng}/${ns}.json`]
      // Missing file → reject so i18next uses fallbackLng (English) instead.
      if (!loader) return Promise.reject(new Error(`i18n: no resource ${lng}/${ns}`))
      return loader() as Promise<{ default: Record<string, unknown> }>
    }),
  )
  .use(initReactI18next)
  .init({
    lng: readStoredLocale(),
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React escapes by default
    returnNull: false,
    react: { useSuspense: true },
  })

/** Switch the active UI language and remember the choice across restarts. */
export function setLocale(lng: Locale): void {
  try {
    localStorage.setItem('tachi-locale', lng)
  } catch {
    /* storage unavailable — language still changes for this session */
  }
  void i18n.changeLanguage(lng)
}

export default i18n
