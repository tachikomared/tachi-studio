// packages/core/src/tachi/loop/guards.ts
//
// Pure agent-loop guardrails (no SDK, no electron) — unit-tested, consumed by the
// TACHI loop in apps/desktop:
//  - repairToolName: map a model's slightly-wrong tool name back to a real one
//    (exact -> case/punctuation -> alias table -> closest unambiguous edit match),
//    or null when there's no confident match.
//  - validateCompletionSummary: reject lazy/placeholder "done" summaries so the
//    agent's `complete` tool forces an honest account of what changed + how verified.

/** Normalise a tool name for matching: lowercase, strip non-alphanumerics. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Levenshtein edit distance (small strings; rolling-row DP). */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let cur = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev; prev = cur; cur = tmp
  }
  return prev[n]
}

// Common names other agents/models reach for, mapped to OUR tool names.
const ALIASES: Record<string, string> = {
  readfile: 'read', cat: 'read', open: 'read', viewfile: 'read',
  writefile: 'write', createfile: 'write', create: 'write', savefile: 'write',
  editfile: 'edit', replace: 'edit', strreplace: 'edit', applypatch: 'edit', patch: 'edit',
  shell: 'bash', sh: 'bash', run: 'bash', exec: 'bash', terminal: 'bash', runcommand: 'bash',
  search: 'grep', ripgrep: 'grep', rg: 'grep', findtext: 'grep', searchtext: 'grep',
  find: 'glob', findfiles: 'glob', listfiles: 'glob', ls: 'glob',
}

/**
 * Map a possibly-wrong tool name to one of `valid`. Order: exact, then
 * case/punctuation-insensitive, then an alias table, then the closest name by
 * normalised edit distance IF it is unambiguous and close (<= ~1/3 of the length,
 * min 1). Returns null when there is no confident match — the caller should then
 * let the original error surface so the model can self-correct.
 */
export function repairToolName(bad: string | undefined | null, valid: string[]): string | null {
  if (!bad) return null
  if (valid.includes(bad)) return bad
  const nb = norm(bad)
  if (!nb) return null
  const byNorm = valid.find((v) => norm(v) === nb)
  if (byNorm) return byNorm
  if (ALIASES[nb] && valid.includes(ALIASES[nb])) return ALIASES[nb]
  let best: string | null = null
  let bestD = Infinity
  let tie = false
  for (const v of valid) {
    const d = editDistance(nb, norm(v))
    if (d < bestD) { bestD = d; best = v; tie = false }
    else if (d === bestD) tie = true
  }
  if (best && !tie && bestD <= Math.max(1, Math.floor(nb.length / 3))) return best
  return null
}

const PLACEHOLDER = new Set([
  'done', 'ok', 'okay', 'complete', 'completed', 'finished', 'fin', 'success',
  'succeeded', 'lgtm', 'looksgood', 'good', 'yes', 'y', 'na', 'tbd', 'wip', 'allgood', 'donethanks',
])

export interface CompletionSummaryVerdict { ok: boolean; reason?: string }

/**
 * Reject lazy completion summaries. A good summary is substantive prose: >= 4
 * words, >= 24 alphanumeric chars, and not just filler/placeholder words.
 */
export function validateCompletionSummary(summary: string | undefined | null): CompletionSummaryVerdict {
  const s = (summary ?? '').trim()
  if (!s) return { ok: false, reason: 'summary is empty.' }
  const collapsed = s.replace(/\s+/g, ' ')
  const words = collapsed.split(' ').filter(Boolean)
  if (words.length < 4) return { ok: false, reason: 'summary is too short — say what you changed and how you verified it.' }
  if (collapsed.replace(/[^a-z0-9]/gi, '').length < 24) return { ok: false, reason: 'summary is too short to be meaningful.' }
  if (PLACEHOLDER.has(norm(collapsed))) return { ok: false, reason: 'placeholder summaries ("done"/"ok"/…) are not accepted.' }
  if (words.every((w) => PLACEHOLDER.has(norm(w)))) return { ok: false, reason: 'summary is only filler words.' }
  return { ok: true }
}
