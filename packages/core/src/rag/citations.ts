// packages/core/src/rag/citations.ts
//
// RAG SOURCE CITATIONS (USER-PAINS T20 / top-10 #6 — "silent, black-box RAG").
//
// Pure metadata layer over an already-computed retrieval result: it takes the
// hits the folder index produced and turns them into the provenance records
// that ride along with the assistant message (file + line range + score + the
// exact retrieved text). It NEVER retrieves, embeds or re-ranks anything —
// retrieval/embedding logic lives untouched in the Electron main's rag-service.
//
// Kept in core (not the main process) so the shape is shared by main (produces),
// the renderer store (persists) and the message component (renders), and so the
// mapping — dedupe, cap, truncation, path joining, traversal rejection — is
// unit-testable without Electron.

/**
 * A retrieval hit as produced by the folder index. Structural on purpose: the
 * desktop's `RagSearchHit` satisfies it without importing anything from the app.
 */
export interface RagRetrievalHit {
  /** Folder-relative path with FORWARD slashes (the indexer's normal form). */
  path: string
  startLine: number
  endLine: number
  /** Cosine similarity in 0..1. */
  score: number
  /** The retrieved chunk text. */
  text: string
}

/**
 * One clickable source under an assistant message. Persisted verbatim on the
 * chat message, so keep it small and JSON-plain.
 */
export interface RagCitation {
  /** Folder-relative path, forward slashes — what the chip label is built from. */
  path: string
  /** Absolute on-disk path for the "open file" affordance. Empty if unresolvable. */
  absPath: string
  startLine: number
  endLine: number
  /** Cosine similarity, 0..1, rounded to 3 decimals. */
  score: number
  /** The exact retrieved chunk text, truncated for storage. */
  text: string
}

/** Max characters of chunk text stored per citation (transcripts stay small). */
export const CITATION_SNIPPET_CHARS = 700
/** Max citations attached to one message. */
export const MAX_CITATIONS = 6

/**
 * Join a folder-relative RAG path onto its root, using the separator the root
 * already uses (so a Windows root yields a Windows path and a POSIX root a
 * POSIX one) — no `node:path` import, core stays platform-free.
 * Returns '' for a path that tries to escape the root.
 */
export function joinUnderRoot(root: string, rel: string): string {
  if (!root || !rel) return ''
  if (!isSafeRelPath(rel)) return ''
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const body = rel.replace(/^[\\/]+/, '').split(/[\\/]+/).join(sep)
  return `${trimmedRoot}${sep}${body}`
}

/**
 * Reject absolute paths, drive letters, UNC prefixes and any `..` segment — a
 * poisoned index entry must not become a click-to-open outside the folder.
 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.trim() === '') return false
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(rel)) return false
  return !rel.split(/[\\/]+/).some(seg => seg === '..')
}

/** Bare file name for a chip label ("src/deep/notes.md" → "notes.md"). */
export function citationFileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

/** Compact chip label: "notes.md:12-48" (single-line chunks collapse to "notes.md:12"). */
export function citationLabel(c: Pick<RagCitation, 'path' | 'startLine' | 'endLine'>): string {
  const name = citationFileName(c.path)
  return c.endLine > c.startLine ? `${name}:${c.startLine}-${c.endLine}` : `${name}:${c.startLine}`
}

export interface ToCitationsOptions {
  /** Max citations kept (default MAX_CITATIONS). */
  max?: number
  /** Max stored snippet characters (default CITATION_SNIPPET_CHARS). */
  snippetChars?: number
}

/**
 * Map retrieval hits → persisted citations.
 *
 * - keeps input order (the retriever already ranks by score)
 * - de-duplicates by `path:startLine`, keeping the best-scoring occurrence
 * - drops hits whose relative path escapes the root
 * - clamps + rounds the score, truncates the snippet, caps the count
 */
export function toCitations(
  root: string,
  hits: readonly RagRetrievalHit[] | undefined | null,
  opts: ToCitationsOptions = {},
): RagCitation[] {
  if (!Array.isArray(hits) || hits.length === 0) return []
  const max = Math.max(1, Math.floor(opts.max ?? MAX_CITATIONS))
  const snippetChars = Math.max(1, Math.floor(opts.snippetChars ?? CITATION_SNIPPET_CHARS))

  const byKey = new Map<string, RagCitation>()
  for (const h of hits) {
    if (!h || typeof h.path !== 'string' || !isSafeRelPath(h.path)) continue
    const startLine = Number.isFinite(h.startLine) ? Math.max(1, Math.floor(h.startLine)) : 1
    const endLine = Number.isFinite(h.endLine) ? Math.max(startLine, Math.floor(h.endLine)) : startLine
    const rawScore = Number.isFinite(h.score) ? h.score : 0
    const score = Math.round(Math.min(1, Math.max(0, rawScore)) * 1000) / 1000
    const raw = typeof h.text === 'string' ? h.text : ''
    const text = raw.length > snippetChars ? `${raw.slice(0, snippetChars)}…` : raw

    const key = `${h.path}:${startLine}`
    const existing = byKey.get(key)
    if (existing && existing.score >= score) continue
    byKey.set(key, {
      path: h.path,
      absPath: joinUnderRoot(root, h.path),
      startLine,
      endLine,
      score,
      text,
    })
  }
  return [...byKey.values()].slice(0, max)
}
