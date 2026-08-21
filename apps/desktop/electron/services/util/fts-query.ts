// apps/desktop/electron/services/util/fts-query.ts
//
// Pure helpers for SQLite FTS5 chat search (STEAL 2026-07-07, lossless-claw
// src/store/fts5-sanitize.ts + full-text-fallback.ts):
//
// - sanitizeFts5Query: FTS5 treats - + * : ^ OR NEAR as syntax; a user typing
//   `c++ -flag` would error or misfire. Quote-wrapping every token turns the
//   whole query into plain phrase terms (implicit AND between them).
// - containsCjk + LIKE fallback: the unicode61 tokenizer does NOT segment
//   CJK text (verified: MATCH '中文' finds nothing in indexed Chinese), so CJK
//   queries must run as LIKE scans instead — critical for our zh/ja locales.
// - buildLikeSnippet: FTS5's snippet() only exists on the MATCH path; the LIKE
//   path builds its own window centered on the earliest hit.
//
// Dependency-free so it unit-tests in isolation.

/** Quote-wrap every whitespace-separated token so FTS5 operators can't misfire. */
export function sanitizeFts5Query(query: string): string {
  return query
    .split(/\s+/)
    .map(t => t.replace(/"/g, '')) // embedded quotes would close our phrase
    .filter(t => t.length > 0)
    .map(t => `"${t}"`)
    .join(' ')
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

/** True when the query contains Han/Hiragana/Katakana/Hangul — FTS5 unicode61 can't tokenize these. */
export function containsCjk(query: string): boolean {
  return CJK_RE.test(query)
}

/** Escape %, _ and the escape char itself for a LIKE … ESCAPE '\' pattern. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, ch => `\\${ch}`)
}

/**
 * A snippet window centered on the earliest case-insensitive occurrence of any
 * query token; falls back to the head of the text when nothing matches.
 */
export function buildLikeSnippet(text: string, query: string, radius = 60): string {
  const lower = text.toLowerCase()
  const tokens = query.split(/\s+/).filter(t => t.length > 0)
  let earliest = -1
  let hitLen = 0
  for (const t of tokens) {
    const idx = lower.indexOf(t.toLowerCase())
    if (idx !== -1 && (earliest === -1 || idx < earliest)) { earliest = idx; hitLen = t.length }
  }
  if (earliest === -1) {
    const head = text.slice(0, radius * 2)
    return head.length < text.length ? `${head}…` : head
  }
  const start = Math.max(0, earliest - radius)
  const end = Math.min(text.length, earliest + hitLen + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
