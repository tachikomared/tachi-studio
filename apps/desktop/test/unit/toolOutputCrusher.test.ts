// apps/desktop/test/unit/toolOutputCrusher.test.ts
//
// Tests for the headroom-inspired (CLEAN-ROOM) JSON-aware tool-output crusher
// added to the deterministic compactor:
//   1. an array of 100 similar objects crushes >60% and carries the markers;
//   2. deeply nested giants are pruned within a tight budget;
//   3. non-JSON output takes the OLD head/tail path untouched (byte-identical);
//   4. malformed JSON falls back to the old path;
//   5. the expand_compacted original-retention path still returns the FULL
//      original byte-for-byte (crushing only affects the in-flight copy).

import { describe, it, expect } from 'vitest'
import { crushJson, compactToolOutput } from '../../electron/services/tool-output-compactor'
import { CompactedStore, queryCompacted } from '@tachi/core'

describe('crushJson — arrays of similar objects', () => {
  it('crushes a 100-similar-item array >60% with the crush + key-schema markers', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item ${i}`,
      value: i * 3,
      active: i % 2 === 0,
    }))
    const raw = JSON.stringify(arr)
    const res = crushJson(raw)

    expect(res).not.toBeNull()
    expect(res!.crushed).toBe(true)
    // marker + one key-schema line, both present
    expect(res!.text).toContain('similar items crushed')
    expect(res!.text).toMatch(/keys: active, id, name, value/)
    // K = 100 - 5 - 2 = 93 items collapsed
    expect(res!.text).toContain('93 similar items crushed')
    // >60% reduction
    expect(res!.text.length).toBeLessThan(raw.length * 0.4)
    // output stays VALID JSON (markers are just string elements)
    expect(() => JSON.parse(res!.text)).not.toThrow()
    // deterministic: same input → same bytes
    expect(crushJson(raw)!.text).toBe(res!.text)
  })

  it('keeps the first 5 and last 2 real items around the marker', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i }))
    const parsed = JSON.parse(crushJson(JSON.stringify(arr))!.text) as unknown[]
    // 5 head + 1 marker + 2 tail = 8 elements
    expect(parsed.length).toBe(8)
    expect(parsed[0]).toEqual({ id: 0 })
    expect(parsed[4]).toEqual({ id: 4 })
    expect(typeof parsed[5]).toBe('string') // the marker
    expect(parsed[6]).toEqual({ id: 98 })
    expect(parsed[7]).toEqual({ id: 99 })
  })

  it('summarises a large primitive array by element type', () => {
    const nums = Array.from({ length: 1000 }, (_, i) => i)
    const res = crushJson(JSON.stringify(nums))!
    expect(res.crushed).toBe(true)
    expect(res.text).toContain('similar items crushed')
    expect(res.text).toContain('type: number')
  })

  it('surfaces the crush marker through compactToolOutput (preferred over head/tail)', () => {
    const arr = Array.from({ length: 120 }, (_, i) => ({ id: i, name: `row ${i}`, note: `value-${i}` }))
    const raw = JSON.stringify(arr)
    expect(raw.length).toBeGreaterThan(4000) // over the compaction threshold
    const c = compactToolOutput({ toolName: 'read', stdout: raw, stderr: '', exitCode: 0 })
    expect(c.inlineText).toContain('similar items crushed')
    expect(c.stats.reducedChars).toBeLessThan(c.stats.rawChars)
    // lossy → carries the authoritative footer + content id
    expect(c.inlineText).toContain('[tachi-compactor]')
  })
})

describe('crushJson — oversized string fields', () => {
  it('truncates a long string field with an explicit marker', () => {
    const obj = { blob: 'z'.repeat(5000), keep: 'short' }
    const res = crushJson(JSON.stringify(obj))!
    expect(res.crushed).toBe(true)
    expect(res.text).toContain('chars truncated')
    expect(res.text).toContain('short') // small fields untouched
    expect(res.text.length).toBeLessThan(1000)
    expect(() => JSON.parse(res.text)).not.toThrow()
  })
})

describe('crushJson — nested giants pruned within budget', () => {
  it('prunes a deeply nested container holding a huge array', () => {
    // A 1000-element array buried 8 levels deep — the depth budget must prune
    // the wrapping container BEFORE the giant array is ever serialised.
    let node: unknown = { items: Array.from({ length: 1000 }, (_, i) => ({ k: i, v: `x${i}` })) }
    for (let i = 0; i < 8; i++) node = { depth: i, inner: node }
    const raw = JSON.stringify(node)
    const res = crushJson(raw)!

    expect(res.crushed).toBe(true)
    expect(res.text).toContain('beyond depth budget')
    // pruned hard — the 1000-item payload never materialised
    expect(res.text.length).toBeLessThan(2000)
    expect(res.text.length).toBeLessThan(raw.length)
    expect(() => JSON.parse(res.text)).not.toThrow()
  })

  it('holds the compacted output within the rule char budget (cap backstop)', () => {
    // Many-keyed rows: crushJson collapses the ARRAY, but the kept head items are
    // still large enough that the char-cap backstop after the crush must clamp it.
    const arr = Array.from({ length: 100 }, (_, i) => {
      const o: Record<string, string> = { id: String(i) }
      for (let k = 0; k < 60; k++) o[`field_${k}`] = `v${i}_${k}`
      return o
    })
    const raw = JSON.stringify(arr)
    const c = compactToolOutput({ toolName: 'read', stdout: raw, stderr: '', exitCode: 0 })
    expect(c.stats.reducedChars).toBeLessThan(c.stats.rawChars)
    // generic/bash success cap is 4000; allow slack for the cap note + footer.
    expect(c.inlineText.length).toBeLessThan(4000 + 500)
  })
})

describe('crushJson — non-JSON / malformed fall back to the old path', () => {
  it('returns null for non-JSON text so the caller keeps head/tail (byte-identical)', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join('\n')
    // null return === the exact same code path (and bytes) as before the crusher
    expect(crushJson(raw)).toBeNull()

    const c = compactToolOutput({ toolName: 'Bash', stdout: raw, stderr: '', exitCode: 0 })
    expect(c.inlineText).not.toContain('similar items crushed')
    // took the blind head/tail slice
    expect(c.inlineText).toContain('omitted')
  })

  it('falls back when the JSON is malformed', () => {
    const raw =
      '{\n  "items": [\n' +
      Array.from({ length: 500 }, (_, i) => `    {"id": ${i}},`).join('\n') +
      '\n  // truncated — no closing brackets'
    expect(raw.length).toBeGreaterThan(4000)
    expect(crushJson(raw)).toBeNull()

    const c = compactToolOutput({ toolName: 'read', stdout: raw, stderr: '', exitCode: 0 })
    expect(c.inlineText).not.toContain('similar items crushed')
  })

  it('does not crush a tiny valid JSON (nothing to reduce)', () => {
    const res = crushJson('{"a":1,"b":[1,2,3]}')
    expect(res).not.toBeNull()
    expect(res!.crushed).toBe(false)
  })
})

describe('expand_compacted original-retention is untouched by the crusher', () => {
  it('CompactedStore still returns the full original byte-for-byte after crushing', () => {
    const original = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item ${i}`, blob: 'y'.repeat(400) })),
    )
    const store = new CompactedStore()
    const id = store.save(original)

    // Exercise the crusher on the same payload (the in-flight compaction path).
    const c = compactToolOutput({ toolName: 'read', stdout: original, stderr: '', exitCode: 0 })
    expect(c.inlineText).not.toBe(original) // the in-flight copy WAS reduced
    expect(c.inlineText).toContain('similar items crushed')

    // …but the retained original is byte-identical, so expand_compacted recovers all of it.
    expect(store.get(id)).toBe(original)
    expect(queryCompacted(store, id)).toBe(original)
  })
})
