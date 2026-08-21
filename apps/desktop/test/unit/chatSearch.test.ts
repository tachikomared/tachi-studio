// apps/desktop/test/unit/chatSearch.test.ts
//
// FTS5 chat search: pure query hardening (sanitizer / CJK detection / LIKE
// escaping / snippet) + a REAL end-to-end index over temp JSON conversation
// files — possible in vitest precisely because the engine is wasm (no
// native ABI split between node and electron).
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeFts5Query, containsCjk, escapeLike, buildLikeSnippet } from '../../electron/services/util/fts-query'
import { createChatIndex } from '../../electron/services/chat-search-service'

describe('sanitizeFts5Query', () => {
  it('quote-wraps every token so FTS5 operators become plain terms', () => {
    expect(sanitizeFts5Query('c++ -flag OR NEAR')).toBe('"c++" "-flag" "OR" "NEAR"')
  })
  it('strips embedded double quotes that would close the phrase', () => {
    expect(sanitizeFts5Query('say "hello"')).toBe('"say" "hello"')
  })
  it('drops empty tokens', () => {
    expect(sanitizeFts5Query('  a   b  ')).toBe('"a" "b"')
  })
})

describe('containsCjk', () => {
  it('detects Han / kana / hangul, not latin or cyrillic', () => {
    expect(containsCjk('中文')).toBe(true)
    expect(containsCjk('ひらがな')).toBe(true)
    expect(containsCjk('한국어')).toBe(true)
    expect(containsCjk('hello')).toBe(false)
    expect(containsCjk('привет')).toBe(false)
  })
})

describe('escapeLike', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })
})

describe('buildLikeSnippet', () => {
  it('centers on the earliest hit with ellipses', () => {
    const text = 'x'.repeat(200) + ' TARGET ' + 'y'.repeat(200)
    const s = buildLikeSnippet(text, 'target')
    expect(s).toContain('TARGET')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
  it('falls back to the head when nothing matches', () => {
    expect(buildLikeSnippet('short text', 'zzz')).toBe('short text')
  })
})

// ── Real index over temp files ────────────────────────────────────────────────

const convDir = mkdtempSync(join(tmpdir(), 'tachi-conv-'))
const idxDir  = mkdtempSync(join(tmpdir(), 'tachi-idx-'))

function writeConv(id: string, title: string, texts: string[], updatedAt = '2026-07-07T00:00:00Z') {
  writeFileSync(join(convDir, `${id}.json`), JSON.stringify({
    id, title, updatedAt,
    messages: texts.map((t, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: t })),
  }))
}

const index = createChatIndex({ conversationsDir: convDir, indexDir: idxDir })

afterAll(() => {
  index.close()
  rmSync(convDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(idxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('createChatIndex (integration, wasm SQLite)', () => {
  it('indexes conversations and finds messages via FTS5 with snippets', () => {
    writeConv('conv-a', 'Sky question', ['why is the sky blue?', 'Rayleigh scattering makes the sky look blue.'])
    writeConv('conv-b', 'Cooking', ['how do I cook pasta', 'boil water, add salt'])
    const s = index.sync()
    expect(s.indexed).toBe(2)

    const { hits, mode } = index.search('rayleigh scattering')
    expect(mode).toBe('fts')
    expect(hits.length).toBe(1)
    expect(hits[0].convId).toBe('conv-a')
    expect(hits[0].title).toBe('Sky question')
    expect(hits[0].snippet).toContain('«Rayleigh»')
  })

  it('FTS5 operator characters in the query do not error (sanitizer)', () => {
    const { hits } = index.search('pasta OR -x "unbalanced')
    expect(Array.isArray(hits)).toBe(true) // no throw is the assertion
  })

  it('CJK queries use the LIKE fallback and still find content', () => {
    writeConv('conv-c', '中文对话', ['请解释一下中文全文搜索的问题', '好的，这里是解释'])
    const { hits, mode } = index.search('中文全文搜索')
    expect(mode).toBe('like')
    expect(hits.length).toBe(1)
    expect(hits[0].convId).toBe('conv-c')
    expect(hits[0].snippet).toContain('中文全文搜索')
  })

  it('re-syncs changed files and drops deleted ones (mtime+size scan)', () => {
    // change content (different size → picked up even with coarse mtime)
    writeConv('conv-b', 'Cooking', ['how do I cook pasta', 'boil water, add salt, then add the QUINOA instead'])
    utimesSync(join(convDir, 'conv-b.json'), new Date(), new Date(Date.now() + 5000))
    let s = index.sync()
    expect(s.indexed).toBe(1)
    expect(index.search('quinoa').hits.length).toBe(1)

    rmSync(join(convDir, 'conv-c.json'))
    s = index.sync()
    expect(s.removed).toBe(1)
    expect(index.search('中文全文搜索').hits.length).toBe(0)
  })

  it('unchanged files are not re-indexed', () => {
    const s = index.sync()
    expect(s.indexed).toBe(0)
    expect(s.total).toBe(2)
  })

  it('status reports counts', () => {
    const st = index.status()
    expect(st.conversations).toBe(2)
    expect(st.messages).toBe(4)
  })
})
