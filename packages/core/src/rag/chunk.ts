// packages/core/src/rag/chunk.ts
//
// Sliding line-window chunker for RAG indexing. Overlap keeps a symbol that
// straddles a window boundary retrievable from both sides. Embedders cap input
// tokens (jina-embeddings-v2-base-code = 8192), so windows stay well under that.
// Blank windows are skipped; degenerate options can't loop forever.

import type { RagChunk } from './types.js'

export interface ChunkOptions {
  /** Max lines per window (default 60). */
  maxLines?: number
  /** Lines shared between consecutive windows (default 10; clamped < maxLines). */
  overlap?: number
}

export function chunkText(text: string, path: string, opts: ChunkOptions = {}): RagChunk[] {
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? 60))
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlap ?? 10), maxLines - 1))
  const stride = Math.max(1, maxLines - overlap)

  const lines = text.split('\n')
  const total = lines.length
  const out: RagChunk[] = []

  for (let start = 1; start <= total; start += stride) {
    const end = Math.min(start + maxLines - 1, total)
    const body = lines.slice(start - 1, end).join('\n')
    if (body.trim().length > 0) {
      out.push({ id: `${path}:${start}`, text: body, path, startLine: start, endLine: end })
    }
    if (end >= total) break // last window already reached EOF — no redundant tail
  }
  return out
}
