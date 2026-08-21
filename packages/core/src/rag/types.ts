// packages/core/src/rag/types.ts
//
// Shared types for the local RAG core (STEAL 2026-06-21 #7; decision doc
// notes/RAG-EMBEDDER-DECISION-2026-06-22.md). The Embedder is an INTERFACE so
// the pure core (chunker + vector store + retrieval) is fully unit-testable with
// a deterministic fake, and the real in-process embedder (Transformers.js /
// jina-embeddings-v2-base-code) is wired behind it later in the Electron main.

/** A unit of indexed text with a file:line citation. */
export interface RagChunk {
  /** Stable id, `${path}:${startLine}`. */
  id: string
  text: string
  /** Workspace-relative path. */
  path: string
  startLine: number
  endLine: number
}

/** A chunk plus its embedding, as held by the vector store. */
export interface StoredVector {
  id: string
  vector: number[]
  chunk: RagChunk
}

/** A retrieval hit. */
export interface ScoredChunk {
  chunk: RagChunk
  score: number
}

/**
 * Embeds text into vectors. Implementations must return L2-normalised vectors
 * (so a dot product equals cosine similarity) and one vector per input, in order.
 */
export interface Embedder {
  /** Stable model id — bump invalidates a persisted index built by another model. */
  readonly id: string
  /** Output vector dimension. */
  readonly dim: number
  /** Embed a batch of texts → one vector per text, same order. */
  embed(texts: string[]): Promise<number[][]>
}
