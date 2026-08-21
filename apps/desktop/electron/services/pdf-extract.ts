// apps/desktop/electron/services/pdf-extract.ts
//
// Local text-layer extraction from PDFs via pdfjs-dist (Apache-2.0), 100%
// offline. Fixes a verified gap (STEAL 2026-07-08, MinerU/Stirling): before
// this, a PDF attachment was base64-decoded straight into binary garbage on
// every provider path, and rag-service skipped .pdf entirely. Now a PDF
// becomes real text usable by ANY provider and indexable for RAG.
//
// Text-layer only: born-digital PDFs extract fully; a purely SCANNED PDF has no
// text layer and yields ~empty output (callers surface a "scanned PDF — no text
// layer" note rather than silently returning nothing). Vision-model OCR
// fallback is a separate follow-up (Wave B tail).
//
// pdfjs runs on the main thread here (no separate worker): text extraction
// needs no canvas/DOM, and disabling the worker avoids bundling worker asset
// paths through electron-vite. The legacy build is the Node-friendly entry.

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfjsPromise.catch(() => { pdfjsPromise = null })
  }
  return pdfjsPromise
}

export interface PdfExtractResult {
  ok: boolean
  text: string
  pages: number
  /** True when the PDF parsed but has effectively no text layer (likely scanned). */
  scanned?: boolean
  error?: string
}

/** Rough per-document cap so a 500-page PDF can't blow the model context / RAM. */
const MAX_CHARS = 800_000

/**
 * Extract the text layer from a PDF buffer, page by page, joined with form-feed
 * page separators. Never throws — returns { ok:false, error } on a corrupt file.
 */
export async function extractPdfText(data: Uint8Array): Promise<PdfExtractResult> {
  let pdfjs
  try { pdfjs = await getPdfjs() } catch (e) {
    return { ok: false, text: '', pages: 0, error: `pdfjs failed to load: ${(e as Error).message}` }
  }
  try {
    // pdfjs 6: isEvalSupported was removed from DocumentInitParameters (eval
    // paths are gone upstream); keep the loading task so we can destroy it —
    // PDFDocumentProxy.destroy() no longer exists, teardown moved to the task.
    const loadingTask = pdfjs.getDocument({
      data,
      // Headless: no external font/cmap fetches, main-thread parse.
      useSystemFonts: false,
      disableFontFace: true,
    })
    const doc = await loadingTask.promise

    const parts: string[] = []
    let chars = 0
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      // Reassemble reading order: pdfjs items carry hasEOL for line breaks.
      let pageText = ''
      for (const item of content.items) {
        const it = item as { str?: string; hasEOL?: boolean }
        if (typeof it.str === 'string') pageText += it.str + (it.hasEOL ? '\n' : ' ')
      }
      pageText = pageText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (pageText) { parts.push(pageText); chars += pageText.length }
      page.cleanup()
      if (chars >= MAX_CHARS) break
    }
    try { await loadingTask.destroy() } catch { /* ignore */ }

    const text = parts.join('\n\n\f\n\n').slice(0, MAX_CHARS)
    const scanned = text.trim().length < 20 && doc.numPages > 0
    return { ok: true, text, pages: doc.numPages, scanned }
  } catch (e) {
    return { ok: false, text: '', pages: 0, error: `PDF parse failed: ${(e as Error).message}` }
  }
}

/** True for a filename/mime that looks like a PDF. */
export function isPdf(filename: string, mimeType?: string): boolean {
  return /\.pdf$/i.test(filename) || mimeType === 'application/pdf'
}
