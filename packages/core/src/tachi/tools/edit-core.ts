// packages/core/src/tachi/tools/edit-core.ts
//
// The edit cascade — the heart of TACHI's edit reliability. `applyEdit` takes a
// file's content and an (oldString -> newString) replacement and tries a fixed
// ordered list of matching STRATEGIES, from the most literal to the most
// forgiving, stopping at the first that locates EXACTLY ONE plausible region.
// The model rarely reproduces whitespace/indentation/escaping perfectly, so the
// fuzzy strategies recover the intended edit without silently editing the wrong
// place: a strategy's candidate is only accepted when it is unique in the file,
// and a "disproportionate" guard rejects a fuzzy hit whose span is wildly larger
// than what the model asked to replace.
//
// The algorithm is ported from the MIT-licensed opencode edit tool
// (packages/opencode/src/tool/edit.ts), itself derived from cline & gemini-cli
// diff-apply heuristics. This is a pure, dependency-free reimplementation: no
// fs, no node, no formatting/LSP side effects — just (content, old, new) -> a
// new string or a typed failure. Line endings are normalised to LF for matching
// and the file's dominant ending is restored on the way out.

import type { EditResult, EditStrategy, EditFailureReason } from '../contract.js'

// ── Line-ending helpers ────────────────────────────────────────────────────────

function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function restoreLineEnding(text: string, ending: '\n' | '\r\n'): string {
  if (ending === '\n') return text
  // text is LF-only at this point; lift every LF back to CRLF.
  return text.replaceAll('\n', '\r\n')
}

// ── Levenshtein distance + ratio (for block-anchor similarity) ──────────────────

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  // Two-row DP — O(min) memory, plenty fast for single trimmed lines.
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[b.length]
}

/** Similarity in [0,1]: 1 - editDistance/maxLen. Two empty strings count as 1. */
function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

const SIMILARITY_THRESHOLD = 0.65

// ── Disproportionate guard (TACHI spec) ─────────────────────────────────────────
// Reject a FUZZY (non-exact) candidate whose matched span is implausibly larger
// than the oldString the model intended to replace: roughly >= 2x its line count
// OR >= 4x its character length. Exact matches are exempt (the span *is* old).
//
// Both rules carry a small absolute floor so that legitimate small expansions —
// e.g. escape-normalized turning a literal "\n" (1 line) into a real newline
// (2 lines), or whitespace-normalized adding a couple of chars — are NOT
// penalised; the guard only fires on a genuinely runaway span. (This floor
// mirrors the upstream opencode heuristic and is why the multiplier alone is
// not used.)
const DISPROPORTIONATE_LINE_FLOOR = 3 // tolerate up to +3 lines before 2x kicks in
const DISPROPORTIONATE_CHAR_FLOOR = 500 // tolerate up to +500 chars before 4x kicks in

function isDisproportionate(matched: string, oldString: string): boolean {
  const matchedLines = matched.split('\n').length
  const oldLines = oldString.split('\n').length
  if (matchedLines >= Math.max(oldLines + DISPROPORTIONATE_LINE_FLOOR, oldLines * 2)) return true
  const oldChars = oldString.trim().length
  const matchedChars = matched.trim().length
  if (matchedChars >= Math.max(oldChars + DISPROPORTIONATE_CHAR_FLOOR, oldChars * 4)) return true
  return false
}

// ── Replacers ───────────────────────────────────────────────────────────────────
// Each is a generator yielding candidate substrings of `content` (verbatim
// slices) that *could* be the region the model meant. The driver checks each
// candidate for uniqueness via indexOf/lastIndexOf. All operate on LF-normalised
// strings.

type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// 1. exact — yield the search string itself; indexOf locates it, uniqueness via
//    lastIndexOf === indexOf is enforced by the driver.
const exactReplacer: Replacer = function* (_content, find) {
  yield find
}

// 2. line-trimmed — match a run of lines where each line is equal after
//    trimming leading/trailing whitespace. Yields the original (untrimmed) span.
const lineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()
  if (searchLines.length === 0) return

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue

    let matchStartIndex = 0
    for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k].length
      if (k < searchLines.length - 1) matchEndIndex += 1 // newline between lines
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

// 3. block-anchor — for >= 3 line blocks: lock the first & last lines as anchors
//    and accept a candidate block whose MIDDLE lines are similar enough
//    (Levenshtein ratio averaged over middle lines >= 0.65).
const blockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()
  if (searchLines.length < 3) return

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // only the first matching last-line after this anchor
      }
    }
  }
  if (candidates.length === 0) return

  const sliceOf = (startLine: number, endLine: number): string => {
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) matchEndIndex += 1
    }
    return content.substring(matchStartIndex, matchEndIndex)
  }

  const middleSimilarity = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck <= 0) return 1 // anchors only; nothing to compare
    let acc = 0
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      acc += similarityRatio(originalLines[startLine + j].trim(), searchLines[j].trim())
    }
    return acc / linesToCheck
  }

  // Yield the best candidate(s) above threshold. We yield every qualifying
  // candidate so the driver can detect ambiguity (>1 unique match).
  const scored = candidates
    .map((c) => ({ c, sim: middleSimilarity(c.startLine, c.endLine) }))
    .filter((s) => s.sim >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)
  for (const { c } of scored) yield sliceOf(c.startLine, c.endLine)
}

// 4. whitespace-normalized — collapse all whitespace runs to a single space for
//    comparison. Handles single-line and multi-line blocks.
const whitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  const normalizedFind = norm(find)
  if (normalizedFind === '') return
  const lines = content.split('\n')

  // Single-line whole-line matches.
  for (const line of lines) {
    if (norm(line) === normalizedFind) yield line
  }

  // Multi-line block matches.
  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n')
      if (norm(block) === normalizedFind) yield block
    }
  }
}

// 5. indentation-flexible — strip the common minimum leading indentation from
//    both sides and compare; recovers a block pasted at a different base indent.
const indentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string): string => {
    const lines = text.split('\n')
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(
      ...nonEmpty.map((l) => {
        const m = l.match(/^(\s*)/)
        return m ? m[1].length : 0
      }),
    )
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join('\n')
  }
  const normalizedFind = removeIndentation(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndentation(block) === normalizedFind) yield block
  }
}

// 6. escape-normalized — unescape common sequences (\n, \t, \r, quotes, \\, \$)
//    in the search string (and in candidate blocks) before comparing, so a model
//    that emitted literal "\n" still matches a real newline.
const escapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, ch) => {
      switch (ch) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case "'":
          return "'"
        case '"':
          return '"'
        case '`':
          return '`'
        case '\\':
          return '\\'
        case '\n':
          return '\n'
        case '$':
          return '$'
        default:
          return match
      }
    })

  const unescapedFind = unescape(find)
  // Direct: the unescaped search appears verbatim in content.
  if (unescapedFind !== find && content.includes(unescapedFind)) yield unescapedFind

  // Block: a content block that, once unescaped, equals the unescaped search.
  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (block !== unescapedFind && unescape(block) === unescapedFind) yield block
  }
}

// 7. trimmed-boundary — trim the WHOLE oldString block's outer whitespace
//    (including stray leading/trailing blank lines) and locate that.
const trimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return // nothing to gain; exact already tried
  if (trimmedFind === '') return
  if (content.includes(trimmedFind)) yield trimmedFind

  const lines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (block.trim() === trimmedFind) yield block
  }
}

// 8. context-aware — like block-anchor but accept on a simple majority of
//    middle lines matching exactly when trimmed (>= 50% of non-empty middles),
//    requiring the candidate block to have the same line count as the search.
const contextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === '') findLines.pop()
  if (findLines.length < 3) return

  const contentLines = content.split('\n')
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) continue
      const blockLines = contentLines.slice(i, j + 1)
      if (blockLines.length === findLines.length) {
        let matching = 0
        let totalNonEmpty = 0
        for (let k = 1; k < blockLines.length - 1; k++) {
          const bl = blockLines[k].trim()
          const fl = findLines[k].trim()
          if (bl.length > 0 || fl.length > 0) {
            totalNonEmpty++
            if (bl === fl) matching++
          }
        }
        if (totalNonEmpty === 0 || matching / totalNonEmpty >= 0.5) {
          yield blockLines.join('\n')
          break
        }
      }
      break
    }
  }
}

// Ordered cascade. The fuzzy flag drives the disproportionate guard (exact is
// exempt) and is reported as the winning EditStrategy.
const CASCADE: Array<{ name: EditStrategy; replacer: Replacer; fuzzy: boolean }> = [
  { name: 'exact', replacer: exactReplacer, fuzzy: false },
  { name: 'line-trimmed', replacer: lineTrimmedReplacer, fuzzy: true },
  { name: 'block-anchor', replacer: blockAnchorReplacer, fuzzy: true },
  { name: 'whitespace-normalized', replacer: whitespaceNormalizedReplacer, fuzzy: true },
  { name: 'indentation-flexible', replacer: indentationFlexibleReplacer, fuzzy: true },
  { name: 'escape-normalized', replacer: escapeNormalizedReplacer, fuzzy: true },
  { name: 'trimmed-boundary', replacer: trimmedBoundaryReplacer, fuzzy: true },
  { name: 'context-aware', replacer: contextAwareReplacer, fuzzy: true },
]

function fail(reason: EditFailureReason, detail: string): EditResult {
  return { ok: false, reason, detail }
}

/**
 * Apply a single (oldString -> newString) replacement to `content`, trying the
 * strategy cascade until one yields a unique, plausibly-sized match.
 *
 * Returns a typed EditResult:
 *  - { ok: true, content, strategy } with the file's dominant line ending kept
 *    and everything outside the matched region preserved.
 *  - { ok: false, reason, detail } for empty-old-string / not-found /
 *    multiple-matches / disproportionate.
 */
export function applyEdit(content: string, oldString: string, newString: string): EditResult {
  const ending = detectLineEnding(content)

  // Empty oldString: only valid to CREATE brand-new content into empty content.
  if (oldString === '') {
    if (content.length > 0) {
      return fail(
        'empty-old-string',
        'oldString cannot be empty when editing existing, non-empty content. Provide the exact text to replace, or use write for a full-file replacement.',
      )
    }
    // Create: emit newString with the (trivially detected) ending of the new
    // text preserved as-is. content is "" so dominant ending of the *new* text
    // governs; we leave newString byte-for-byte.
    return { ok: true, content: newString, strategy: 'exact' }
  }

  // Normalise everything to LF for matching; we apply on the LF view and restore
  // the dominant ending at the end. This lets an LF oldString match a CRLF file
  // and vice-versa.
  const normContent = normalizeLineEndings(content)
  const normOld = normalizeLineEndings(oldString)
  const normNew = normalizeLineEndings(newString)

  let foundAny = false
  let disproportionateSeen = false

  for (const { name, replacer, fuzzy } of CASCADE) {
    for (const candidate of replacer(normContent, normOld)) {
      const index = normContent.indexOf(candidate)
      if (index === -1) continue
      foundAny = true

      const unique = normContent.lastIndexOf(candidate) === index
      if (!unique) {
        // This strategy located the region but ambiguously. Don't accept it;
        // keep scanning later strategies (they may pin a unique span), but
        // remember that *something* matched so we don't report not-found.
        continue
      }

      // Disproportionate guard applies to fuzzy strategies only.
      if (fuzzy && isDisproportionate(candidate, normOld)) {
        disproportionateSeen = true
        continue
      }

      const replaced =
        normContent.substring(0, index) + normNew + normContent.substring(index + candidate.length)
      return { ok: true, content: restoreLineEnding(replaced, ending), strategy: name }
    }
  }

  // No strategy produced an accepted unique match. Disambiguate the failure:
  if (!foundAny) {
    return fail(
      'not-found',
      'Could not find oldString in the content under any strategy. It must match closely — including whitespace, indentation, and line endings.',
    )
  }
  if (disproportionateSeen) {
    // We DID localize a region but it was implausibly larger than oldString.
    // Prefer this signal over multiple-matches: it tells the model to supply
    // the full exact oldString rather than just "more context". (When only
    // ambiguous matches exist, disproportionateSeen stays false and we fall
    // through to multiple-matches below.) Reached when at least one
    // plausible-but-oversized region exists.
    return fail(
      'disproportionate',
      'Refusing replacement: the matched span is much larger than oldString. Provide the full exact oldString for the intended region.',
    )
  }
  // foundAny but never unique -> the region appears in more than one place.
  return fail(
    'multiple-matches',
    'Found multiple places matching oldString. Provide more surrounding context to make the match unique.',
  )
}
