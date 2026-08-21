// packages/core/src/chat/scrub.ts
//
// On-device secret/PII scrubber — a pre-flight for outbound cloud requests so
// pasted secrets and personal data never leave the machine in cleartext (steal:
// osaurus). Pure + dependency-free, so it unit-tests in isolation and runs in the
// main process before any HTTP write.
//
// Design choices for LOW false positives (this rewrites user text, so a false
// positive is worse than a miss):
//  - Every detector is ANCHORED (provider prefixes like AKIA/ghp_/sk-, PEM blocks,
//    JWT eyJ.., SSN / credit-card FORMAT). No generic "high-entropy string" rule.
//  - Credit cards must pass the Luhn checksum, so order ids / 16-digit numbers slip
//    through rather than being mangled.
//  - Replacements are STABLE per RedactionMap: the same value always maps to the
//    same placeholder ([REDACTED_EMAIL_1]), so the model still sees coreference.

export type SecretCategory =
  | 'EMAIL'
  | 'AWS_KEY'
  | 'GITHUB_TOKEN'
  | 'API_KEY'
  | 'SLACK_TOKEN'
  | 'PRIVATE_KEY'
  | 'JWT'
  | 'SSN'
  | 'CREDIT_CARD'
  | 'IBAN'

interface Detector { category: SecretCategory; re: RegExp; validate?: (m: string) => boolean }

const luhnOk = (digits: string): boolean => {
  const d = digits.replace(/[^0-9]/g, '')
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// Order matters: structural/long blocks first so they win the greedy overlap pass.
const DETECTORS: Detector[] = [
  { category: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { category: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { category: 'GITHUB_TOKEN', re: /\b(?:gh[posu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { category: 'AWS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'API_KEY', re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { category: 'SLACK_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { category: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, validate: (m) => /\d/.test(m.slice(4)) },
  { category: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { category: 'CREDIT_CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhnOk },
]

export interface RedactionMap {
  /** original value -> stable placeholder */
  placeholders: Record<string, string>
  /** per-category counter for placeholder numbering */
  counts: Partial<Record<SecretCategory, number>>
}

export function newRedactionMap(): RedactionMap {
  return { placeholders: {}, counts: {} }
}

interface Hit { start: number; end: number; value: string; category: SecretCategory }

function findHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (const det of DETECTORS) {
    det.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = det.re.exec(text)) !== null) {
      const value = m[0]
      if (det.validate && !det.validate(value)) continue
      hits.push({ start: m.index, end: m.index + value.length, value, category: det.category })
      if (m.index === det.re.lastIndex) det.re.lastIndex++ // guard zero-width
    }
  }
  // Greedy non-overlap: earliest start wins, then longest. DETECTORS order breaks
  // exact ties (structural blocks first).
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const kept: Hit[] = []
  let cursor = -1
  for (const h of hits) {
    if (h.start >= cursor) { kept.push(h); cursor = h.end }
  }
  return kept
}

/** True if `text` contains any detectable secret/PII (the fail-closed re-scan). */
export function hasSecrets(text: string): boolean {
  return findHits(text).length > 0
}

function placeholderFor(value: string, category: SecretCategory, map: RedactionMap): string {
  const existing = map.placeholders[value]
  if (existing) return existing
  const n = (map.counts[category] ?? 0) + 1
  map.counts[category] = n
  const ph = `[REDACTED_${category}_${n}]`
  map.placeholders[value] = ph
  return ph
}

export interface ScrubResult {
  text: string
  map: RedactionMap
  /** number of values replaced (counts repeats of the same value once per occurrence). */
  redactions: number
}

/**
 * Replace every detected secret/PII value in `text` with a stable placeholder.
 * Pass the same `map` across a conversation so repeated values keep one placeholder.
 */
export function scrubSecrets(text: string, map: RedactionMap = newRedactionMap()): ScrubResult {
  const hits = findHits(text)
  if (hits.length === 0) return { text, map, redactions: 0 }
  let out = ''
  let last = 0
  for (const h of hits) {
    out += text.slice(last, h.start) + placeholderFor(h.value, h.category, map)
    last = h.end
  }
  out += text.slice(last)
  return { text: out, map, redactions: hits.length }
}
