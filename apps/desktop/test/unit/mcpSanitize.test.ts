// apps/desktop/test/unit/mcpSanitize.test.ts
//
// Untrusted-string sanitizer for the in-process MCP server (STEAL 2026-06-12
// cluster B, code-review-graph _sanitize_name): filenames, branch names, and
// commit subjects are attacker-influenced (anything that can write to the repo
// chooses them) and leave the server inside tool results.

import { describe, it, expect } from 'vitest'
import { stripControl, sanitizeName } from '../../electron/mcp/sanitize'

describe('stripControl', () => {
  it('removes C0 control chars and DEL', () => {
    expect(stripControl('a\x00b\x07c\x1fd\x7fe')).toBe('abcde')
  })
  it('kills ANSI escape sequences introducers', () => {
    expect(stripControl('\x1b[31mred\x1b[0m')).toBe('[31mred[0m')
  })
  it('removes newlines and tabs (fake-row injection)', () => {
    expect(stripControl('file.ts\n? evil.ts\tx')).toBe('file.ts? evil.tsx')
  })
  it('keeps unicode intact', () => {
    expect(stripControl('файл-θ-🎯.ts')).toBe('файл-θ-🎯.ts')
  })
})

describe('sanitizeName', () => {
  it('caps length with an ellipsis', () => {
    const long = 'x'.repeat(300)
    const out = sanitizeName(long)
    expect(out.length).toBe(256)
    expect(out.endsWith('…')).toBe(true)
  })
  it('accepts a custom cap', () => {
    expect(sanitizeName('abcdef', 4)).toBe('abc…')
  })
  it('is a no-op on clean short strings', () => {
    expect(sanitizeName('src/index.ts')).toBe('src/index.ts')
  })
})
