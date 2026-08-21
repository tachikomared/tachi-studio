// apps/desktop/test/unit/spendRows.test.ts
//
// The 30-DAY SPEND panel's one naming decision, and the properties that keep it
// from turning a ledger into an edited ledger.
//
// Background: until 64c837d (2026-08-01) tachi/loop.ts wrote its OWN name into
// the provider column — and that commit closed only the loop; its own body
// records "NOTICED, NOT FIXED" for fusion.ipc.ts and openclaude-client.ts,
// which were closed the next day in 6256c92. Citing one commit for both was
// the kind of tidy-looking provenance this file exists to avoid.
// the ledger's provider column instead of the gateway that served the request,
// so a historical `tachi` row sits on the dashboard next to real gateways and
// reads as if it were one. The row is real spend and stays; the fix is that it
// now says what it is.
//
// Node env, no DOM — hence the pure module beside the component (the same shape
// as civitaiDetail.ts beside its panel). The renderer half is asserted against
// its source, which is how ActivityStrip's wiring is pinned in this suite.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isLegacyHarnessRow, spendRowLabel, LEGACY_HARNESS_LEDGER_ID } from '../../src/components/console/spendRows'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

describe('the legacy harness row is labelled, not deleted and not renamed', () => {
  it('tags the harness self-label and nothing else', () => {
    expect(isLegacyHarnessRow(LEGACY_HARNESS_LEDGER_ID)).toBe(true)
    expect(spendRowLabel('tachi', 'legacy harness')).toBe('tachi · legacy harness')
  })

  it('leaves every real gateway row exactly as the ledger spells it', () => {
    for (const id of ['bankr-gateway', 'opengateway', 'venice', 'surplus', 'ollama', 'freellmapi-local']) {
      expect(isLegacyHarnessRow(id)).toBe(false)
      expect(spendRowLabel(id, 'legacy harness')).toBe(id)
    }
  })

  it('does NOT tag openclaude, which is still written today', () => {
    // Same defect class — a component naming itself — but openclaude-client.ts
    // still falls back to the literal 'openclaude' for a sidecar run whose
    // spawn predates the id capture. Calling that row history would be a claim
    // the next such run disproves, so the set stays closed at 'tachi'.
    expect(isLegacyHarnessRow('openclaude')).toBe(false)
    expect(spendRowLabel('openclaude', 'legacy harness')).toBe('openclaude')
  })

  it('keeps the raw ledger id first and intact, so the row stays greppable against cost-ledger.jsonl', () => {
    const label = spendRowLabel('tachi', 'legacy harness')
    expect(label.startsWith('tachi')).toBe(true)
    expect(label).toContain('tachi')
  })

  it('degrades to the bare id rather than a dangling separator when the tag is missing', () => {
    // A locale that has not been translated yet must look like today's
    // dashboard, never like `tachi · `.
    expect(spendRowLabel('tachi', '')).toBe('tachi')
    expect(spendRowLabel('tachi', '   ')).toBe('tachi')
  })
})

describe('the spend panel actually uses the decision (asserted against its source)', () => {
  const tab = () => read('src/components/console/ObservabilityTab.tsx')

  it('routes every provider row label through spendRowLabel', () => {
    const src = tab()
    expect(src).toContain("import { isLegacyHarnessRow, spendRowLabel } from './spendRows'")
    expect(src).toContain('label={spendRowLabel(id,')
    // The old unconditional `label={id}` must be gone, or the tag never shows.
    expect(src).not.toContain('<Row key={id} label={id}')
  })

  it('hangs the long explanation on a tooltip, not on the label the user must read', () => {
    expect(tab()).toContain('title={isLegacyHarnessRow(id)')
  })
})

describe('i18n: the legacy tag speaks all eight languages', () => {
  // Harvested from the component, so a later t('observability.x') added to this
  // panel fails here until it is translated — the check cannot go stale.
  const asked = Array.from(
    new Set(
      [...read('src/components/console/ObservabilityTab.tsx')
        .matchAll(/t\('(observability\.[a-zA-Z.]+)'/g)].map(m => m[1]),
    ),
  ).sort()

  it('asks for the two keys this change introduced', () => {
    expect(asked).toContain('observability.legacyHarnessTag')
    expect(asked).toContain('observability.legacyHarnessNote')
  })

  for (const lang of LANGS) {
    it(`${lang}: every observability key the panel asks for resolves to a non-empty string`, () => {
      const ns = JSON.parse(read(`src/i18n/locales/${lang}/common.json`)) as Record<string, unknown>
      for (const key of asked) {
        const value = key.split('.').reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          ns,
        )
        expect(typeof value, `${lang}/common.json missing ${key}`).toBe('string')
        expect((value as string).trim().length, `${lang}/common.json empty ${key}`).toBeGreaterThan(0)
      }
    })
  }
})
