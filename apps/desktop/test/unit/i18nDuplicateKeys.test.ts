// Guard against DUPLICATE keys in locale JSONs (any nesting level).
//
// JSON.parse keeps the LAST occurrence of a duplicated key, so a second
// "filePreview" block appended to es/agent.json silently SHADOWED the first
// block's translations with zero errors anywhere (seen live 2026-07-19; the
// shadowed block held the only saveCopy* translations while en had lost the
// keys entirely). The i18nConsistency parity test can NOT catch this — it
// sees only the post-parse (last-wins) object. This test walks the RAW text.
import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs script, no types; the shapes are asserted below.
import { findDuplicateKeys, scanLocales } from '../../scripts/check-i18n-duplicate-keys.mjs'

describe('locale JSON duplicate keys', () => {
  it('the detector actually detects (self-test)', () => {
    const dupes = findDuplicateKeys('{"a":{"x":1,"x":2},"b":1,"b":2}', 'synthetic') as string[]
    expect(dupes).toEqual(['a.x', 'b'])
    expect(findDuplicateKeys('{"a":{"x":1},"b":[{"k":1},{"k":2}]}', 'clean')).toEqual([])
  })

  it('no locale file contains a duplicate key at any nesting level', () => {
    const { files, duplicates } = scanLocales() as { files: number; duplicates: Array<{ file: string; path: string }> }
    expect(files).toBeGreaterThan(150) // 8 locales × 21 namespaces
    expect(duplicates.map(d => `${d.file} :: ${d.path}`)).toEqual([])
  })
})
