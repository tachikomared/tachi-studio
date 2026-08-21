// apps/desktop/test/unit/mediaNodeStaleModel.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 3D — item 3: THE STALE-MODEL LIE.
//
// A canvas media node whose `data.model` id fell out of the catalog — removed,
// renamed, or a flow shared from a machine that has it and this one doesn't —
// used to render a <select> with NO option matching `value={model}`: the
// control looked blank (or defaulted to whatever the browser falls back to for
// an unmatched value) while `model` itself — what runNode / runMediaNode
// actually send to the engine — stayed the stale id. The select and the
// engine disagreed about what was selected, and only the select was visible.
//
// The fix renders the out-of-catalog id as a real, DISABLED <option> so the
// control is honest about what would run and that it is not a live choice —
// the same "an out-of-enum value is SHOWN, not hidden" idiom
// NodeConfigPanel's ModelField already uses for a provider/prompt node's
// model field (kept selectable there because that field is free-text; here it
// is disabled because re-selecting the same stale id is never the fix).
//
// This project has no @testing-library/react in its toolchain (checked: zero
// hits across the whole test suite), and every other MediaNode.tsx behavior
// this repo pins (canvasLocalNegative.test.ts) does it at the SOURCE level —
// reading the file, stripping comments, and asserting on the exact code shape
// inside a named anchor slice. This file follows the same convention rather
// than introducing a new one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Source WITHOUT comments — this file's own doc comments quote the code
 *  shapes being asserted on, so a naive read() would let the comment satisfy
 *  the assertion the comment is describing. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

const read = (rel: string): string => stripComments(readFileSync(resolve(__dirname, '..', '..', rel), 'utf8'))

/** Non-vacuous slice between two anchors (civitaiCatalogTab's `between`, also
 *  used by canvasLocalNegative.test.ts). */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(40)
  return body
}

const MEDIA_NODE = 'src/pages/nodes/canvas/nodeTypes/MediaNode.tsx'

describe('MediaNode model picker: the stale-model option', () => {
  const src = read(MEDIA_NODE)
  const picker = between(src, "{models.length > 0 ? (", ") : (")

  it('renders a real <option> for a model id that is NOT in the loaded catalog', () => {
    // The exact honesty check: a non-empty `model` absent from `models`.
    expect(picker).toMatch(/model !== ''\s*&&\s*!models\.some\(m => m\.id === model\)/)
  })

  it('that option is DISABLED — re-selecting the stale id is never the fix', () => {
    const staleOption = between(picker, "!models.some(m => m.id === model)", '{models.map(')
    expect(staleOption).toContain('<option value={model} disabled>')
  })

  it('the stale option carries the raw id in its label (via i18n), not a blank/empty caption', () => {
    const staleOption = between(picker, "!models.some(m => m.id === model)", '{models.map(')
    expect(staleOption).toContain("t('mediaNode.staleModel'")
    expect(staleOption).toContain('id: model')
  })

  it('the ordinary catalog options are still rendered unconditionally after it', () => {
    expect(picker).toContain('{models.map(m => (')
    expect(picker).toContain('<option key={m.id} value={m.id}>{m.label || m.id}</option>')
  })

  it('the select itself is still keyed on the (possibly stale) model value — nothing overrides it to the first row', () => {
    expect(picker).toMatch(/<select[\s\S]*?value=\{model\}/)
  })
})

describe('the i18n key backing the disabled option has a sane English default', () => {
  it('en/nodes.json carries mediaNode.staleModel', () => {
    const json = JSON.parse(readFileSync(
      resolve(__dirname, '..', '..', 'src/i18n/locales/en/nodes.json'), 'utf8',
    )) as { mediaNode?: Record<string, string> }
    expect(json.mediaNode?.staleModel).toBeTruthy()
    expect(json.mediaNode!.staleModel).toContain('{{id}}')
  })
})
