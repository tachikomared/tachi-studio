// packages/core/src/rag/vector-store.ts
//
// In-process flat-cosine vector store (RAG decision 2026-06-22). No native dep:
// a codebase index is a few hundred–few thousand chunks, where a flat cosine
// scan is sub-10ms. `replacePath` makes re-indexing a single changed file cheap.
// `serialize`/`deserialize` persist the index per-workspace under userData.
// Upgrade to sqlite-vec/hnsw only if a real workspace makes the flat scan slow.

import { cosineSimilarity } from './cosine.js'
import type { StoredVector, ScoredChunk } from './types.js'

const SERIAL_VERSION = 1

export class VectorStore {
  private items: StoredVector[]

  constructor(items: StoredVector[] = []) {
    this.items = items
  }

  /** Append vectors (e.g. a freshly indexed file). */
  add(vectors: StoredVector[]): void {
    this.items.push(...vectors)
  }

  /** Drop every vector for `path` and insert the new ones — incremental re-index. */
  replacePath(path: string, vectors: StoredVector[]): void {
    this.items = this.items.filter(v => v.chunk.path !== path).concat(vectors)
  }

  /** Top-k chunks by cosine similarity to `vector`, highest first. */
  query(vector: number[], k: number): ScoredChunk[] {
    const scored: ScoredChunk[] = this.items.map(it => ({
      chunk: it.chunk,
      score: cosineSimilarity(vector, it.vector),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(0, k))
  }

  get size(): number {
    return this.items.length
  }

  serialize(): string {
    return JSON.stringify({ v: SERIAL_VERSION, items: this.items })
  }

  static deserialize(json: string): VectorStore {
    try {
      const parsed = JSON.parse(json) as { items?: unknown }
      return new VectorStore(Array.isArray(parsed.items) ? (parsed.items as StoredVector[]) : [])
    } catch {
      return new VectorStore()
    }
  }
}
