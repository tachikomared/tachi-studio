// apps/desktop/test/unit/i18nConsistency.test.ts
//
// i18n locale parity guard. English (en) is the SOURCE OF TRUTH; every other
// language must ship the SAME set of deeply-nested keys per namespace, and no
// translated value may be an empty string. Files are read straight off disk
// with node:fs + JSON.parse (no electron / no import.meta), so this is a pure
// data test that runs in the 'node' environment.
//
// CURRENT STATE (2026-06-17): all 20 namespaces are at FULL parity across all 8
// languages and no locale ships a blank value — every namespace is asserted
// strictly here, so any future drift (a new English key left untranslated, or a
// blank value) fails immediately. KNOWN_GAPS / KNOWN_EMPTY are empty hooks kept
// only to document a deliberate, temporary gap should one ever arise.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const LOCALES_DIR = path.resolve(__dirname, '../../src/i18n/locales')
const SOURCE = 'en'

// All shipped UI languages (mirrors SUPPORTED_LOCALES in src/i18n/index.ts).
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
const OTHERS = LANGS.filter((l) => l !== SOURCE)

// Namespaces that are intentionally English-only (skip the parity check for
// these). Currently none — every namespace is meant to be translated — but the
// hook is here so an English-only namespace can be documented rather than
// silently failing.
const ENGLISH_ONLY_NS: readonly string[] = []

// --- known, documented divergences ---
//
// Empty: every namespace is at full parity and no locale ships a blank value, so
// all are asserted strictly below. Re-add an entry ONLY to document a deliberate,
// temporary gap (with a TODO to close it) — e.g. KNOWN_GAPS = { ns: { de: ['key'] } }
// or KNOWN_EMPTY = { 'ko/nodes': ['some.key'] }.
const KNOWN_GAPS: Record<string, Record<string, readonly string[]>> = {}
const KNOWN_EMPTY: Record<string, readonly string[]> = {}

// --- helpers ----------------------------------------------------------------

/** Recursively flatten a nested object into dot-joined leaf keys. */
function flattenKeys(obj: unknown, prefix = '', out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      flattenKeys((obj as Record<string, unknown>)[k], key, out)
    }
  } else {
    out.add(prefix)
  }
  return out
}

/** Flatten to [dotKey, leafValue] pairs (for empty-string scanning). */
function flattenEntries(
  obj: unknown,
  prefix = '',
  out: Array<[string, unknown]> = [],
): Array<[string, unknown]> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      flattenEntries((obj as Record<string, unknown>)[k], key, out)
    }
  } else {
    out.push([prefix, obj])
  }
  return out
}

function loadNs(lang: string, ns: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(LOCALES_DIR, lang, `${ns}.json`), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

/** Namespaces are derived from English so the test can't go stale on its own. */
const NAMESPACES = fs
  .readdirSync(path.join(LOCALES_DIR, SOURCE))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))

// --- tests ------------------------------------------------------------------

describe('i18n locale consistency', () => {
  it('discovers all 21 namespaces from the English source of truth', () => {
    expect(NAMESPACES.length).toBe(21)
    expect(NAMESPACES).toContain('common')
    expect(NAMESPACES).toContain('design')
  })

  it('ships every namespace file for every supported language', () => {
    for (const lang of LANGS) {
      for (const ns of NAMESPACES) {
        expect(fs.existsSync(path.join(LOCALES_DIR, lang, `${ns}.json`)), `${lang}/${ns}.json`).toBe(true)
      }
    }
  })

  it('parses as valid JSON for every (language, namespace)', () => {
    for (const lang of LANGS) {
      for (const ns of NAMESPACES) {
        expect(() => loadNs(lang, ns), `${lang}/${ns}.json`).not.toThrow()
      }
    }
  })

  // Strict parity for every namespace that is currently consistent. Any new
  // drift here fails immediately.
  describe('key parity vs English (strict for consistent namespaces)', () => {
    for (const ns of NAMESPACES) {
      if (ENGLISH_ONLY_NS.includes(ns)) continue
      const enKeys = flattenKeys(loadNs(SOURCE, ns))

      for (const lang of OTHERS) {
        const allowed = new Set(KNOWN_GAPS[ns]?.[lang] ?? [])
        const langKeys = flattenKeys(loadNs(lang, ns))

        it(`${lang}/${ns}: no EXTRA keys beyond English`, () => {
          const extra = [...langKeys].filter((k) => !enKeys.has(k))
          expect(extra, `extra keys in ${lang}/${ns}`).toEqual([])
        })

        it(`${lang}/${ns}: missing keys are exactly the documented backlog`, () => {
          const missing = [...enKeys].filter((k) => !langKeys.has(k)).sort()
          // Pin to the documented gap (empty for the 17 consistent namespaces).
          expect(missing, `missing keys in ${lang}/${ns}`).toEqual([...allowed].sort())
        })
      }
    }
  })

  // No empty-string translations anywhere, except the two documented ko/nodes
  // holes. Catches a translator leaving a value blank.
  describe('no empty translation values', () => {
    for (const lang of LANGS) {
      for (const ns of NAMESPACES) {
        const allowEmpty = new Set(KNOWN_EMPTY[`${lang}/${ns}`] ?? [])
        it(`${lang}/${ns}: every leaf is a non-empty string (modulo documented holes)`, () => {
          const empties: string[] = []
          for (const [key, val] of flattenEntries(loadNs(lang, ns))) {
            // every leaf must be a string
            expect(typeof val, `${lang}/${ns}:${key} should be a string`).toBe('string')
            if (typeof val === 'string' && val.trim() === '' && !allowEmpty.has(key)) {
              empties.push(key)
            }
          }
          expect(empties, `empty values in ${lang}/${ns}`).toEqual([])
        })
      }
    }
  })
})
