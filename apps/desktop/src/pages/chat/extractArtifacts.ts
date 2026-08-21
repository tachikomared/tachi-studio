// apps/desktop/src/pages/chat/extractArtifacts.ts
//
// Pure function: scans assistant message text and returns candidate artifacts.
// Does NOT call the store — callers are responsible for deduplication.
//
// Extraction rules:
//   1. Fenced ```html / ```svg / ```mermaid blocks of any size
//      → kind='html' / kind='svg' / kind='mermaid'
//   2. Fenced code blocks with 8+ lines OR 200+ chars   → kind='code'
//   3. Standalone <svg>...</svg> in plain text           → kind='svg'
//
// Title derivation (in order):
//   a. First single-line comment (// … or # …) inside the block
//   b. First markdown heading (# Heading) inside an html block
//   c. "{language} block #{n}"

import type { ArtifactKind, Artifact } from '../../store/artifacts.store'

type ArtifactCandidate = Omit<Artifact, 'id' | 'createdAt'>

// ── helpers ──────────────────────────────────────────────────────────────────

function deriveTitle(content: string, language: string | undefined, index: number): string {
  // Try single-line comment: // text  or  # text  or  /* text */  or  <!-- text -->
  // or mermaid's %% text (but not %%{init}%% directives)
  const commentMatch =
    content.match(/^\s*(?:\/\/|#|<!--|%%(?!\{))\s*(.+?)(?:\s*-->)?\s*$/m) ??
    content.match(/^\s*\/\*\s*(.+?)\s*\*\/\s*$/m)
  if (commentMatch) {
    const title = commentMatch[1].trim()
    if (title.length > 0 && title.length <= 120) return title
  }

  // Try first markdown heading inside html content
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) {
    const title = headingMatch[1].trim()
    if (title.length > 0 && title.length <= 120) return title
  }

  // Try <title> inside html
  const titleTagMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleTagMatch) {
    const title = titleTagMatch[1].trim()
    if (title.length > 0 && title.length <= 120) return title
  }

  const lang = language ?? 'code'
  return `${lang} block #${index + 1}`
}

// ── main export ──────────────────────────────────────────────────────────────

export function extractArtifacts(
  text: string,
  messageId: string,
): ArtifactCandidate[] {
  const results: ArtifactCandidate[] = []

  // ── 1. Fenced code blocks ────────────────────────────────────────────────
  // Matches: ```lang\ncontent\n``` (triple backtick, optional language tag)
  const fenceRe = /^```([\w-]*)\n([\s\S]*?)^```\s*$/gm
  const fenceMatches: Array<{ lang: string; content: string; start: number; end: number }> = []

  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = fenceRe.exec(text)) !== null) {
    fenceMatches.push({
      lang: m[1].trim().toLowerCase(),
      content: m[2],
      start: m.index,
      end: m.index + m[0].length,
    })
  }

  // Track SVG ranges already captured from fences so we don't double-extract
  const capturedRanges: Array<{ start: number; end: number }> = []

  for (const fm of fenceMatches) {
    const { lang, content } = fm
    const trimmed = content.trimEnd()

    let kind: ArtifactKind | null = null
    let language: string | undefined

    if (lang === 'html') {
      kind = 'html'
      language = 'html'
    } else if (lang === 'svg') {
      kind = 'svg'
      language = 'svg'
    } else if (lang === 'mermaid') {
      // Any size — even a 2-line flowchart is a renderable diagram.
      kind = 'mermaid'
      language = 'mermaid'
    } else {
      // Generic code: only extract if sufficiently long
      const lineCount = trimmed.split('\n').length
      if (lineCount >= 8 || trimmed.length >= 200) {
        kind = 'code'
        language = lang || undefined
      }
    }

    if (kind !== null) {
      const index = results.length
      results.push({
        messageId,
        title: deriveTitle(trimmed, language, index),
        kind,
        language,
        content: trimmed,
      })
      capturedRanges.push({ start: fm.start, end: fm.end })
    }
  }

  // ── 2. Standalone <svg>…</svg> in plain text ─────────────────────────────
  const svgRe = /<svg[\s\S]*?<\/svg>/gi
  let sm: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((sm = svgRe.exec(text)) !== null) {
    const start = sm.index
    const end = sm.index + sm[0].length
    // Skip if this range overlaps a fenced block we already captured
    const overlaps = capturedRanges.some(r => start >= r.start && end <= r.end)
    if (overlaps) continue

    const svgContent = sm[0]
    const index = results.length
    results.push({
      messageId,
      title: deriveTitle(svgContent, 'svg', index),
      kind: 'svg',
      language: 'svg',
      content: svgContent,
    })
  }

  return results
}
