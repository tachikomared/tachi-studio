// apps/desktop/src/pages/chat/fitPillSize.ts
//
// Pure size-resolution for the local-model FIT pill (no react, no electron —
// unit-tested in test/unit/fitPillSize.test.ts).
//
// The curated GGUF registry carries an approximate sizeMb per model, but GGUFs
// pulled via HF search (hf_<owner>_<file> ids) are not in the registry, so the
// chat picker used to render NO pill for them at all. The catalog's installed
// list (catalog:installed IPC) reports the REAL on-disk byte size per
// downloaded GGUF; this helper picks the best available source per model:
// the curated registry estimate first (it matches what the Catalog cards
// show), the measured file size otherwise.

export interface ResolvedGgufSize {
  sizeBytes: number
  /** True when the size came from the file on disk rather than the curated
   *  registry — the pill tooltip discloses this. */
  fromDisk: boolean
}

const MB = 1024 * 1024

/**
 * Resolve the byte size to feed estimateFit for a downloaded GGUF.
 * Returns null when no source knows the size (the pill silently doesn't render).
 */
export function resolveGgufSizeBytes(
  curatedSizeMb: number | undefined,
  diskSizeBytes: number | undefined,
): ResolvedGgufSize | null {
  if (typeof curatedSizeMb === 'number' && Number.isFinite(curatedSizeMb) && curatedSizeMb > 0) {
    return { sizeBytes: curatedSizeMb * MB, fromDisk: false }
  }
  if (typeof diskSizeBytes === 'number' && Number.isFinite(diskSizeBytes) && diskSizeBytes > 0) {
    return { sizeBytes: diskSizeBytes, fromDisk: true }
  }
  return null
}

/**
 * Fold catalog:installed rows into a ref → on-disk sizeBytes map for llama.cpp
 * models. Rows for other runtimes (ollama) and rows without a positive size
 * are dropped — absence means "size unknown", never 0.
 */
export function diskSizesFromInstalled(
  models: ReadonlyArray<{ runtime: string; ref: string; sizeBytes: number }> | undefined | null,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of models ?? []) {
    if (m.runtime === 'llamacpp' && typeof m.sizeBytes === 'number' && m.sizeBytes > 0) {
      out[m.ref] = m.sizeBytes
    }
  }
  return out
}
