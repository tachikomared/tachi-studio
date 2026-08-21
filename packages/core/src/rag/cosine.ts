// packages/core/src/rag/cosine.ts
//
// Cosine similarity over plain number[] vectors. Fails SAFE: a length mismatch
// or a zero-norm vector returns 0 rather than NaN/throw, so a malformed or
// empty embedding never poisons a ranked result list.

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
