// packages/core/src/memory/facts.ts
//
// Structured persistent-memory FACTS — the pure, dependency-free core of the
// memory fact manager (USER-PAINS T16: "amnesia / stop re-explaining the
// project"). Lives in @tachi/core so ALL THREE consumers share ONE source of
// truth:
//   - Electron main   (memory-facts-service.ts) — persistence + injection.
//   - Renderer settings (MemorySection.tsx)     — the fact manager UI + preview.
//   - Renderer chat    (auto-capture)           — the "Remember this?" heuristic.
//
// Nothing here imports Node or Electron, so the renderer can import it via the
// `@tachi/core/src/memory/facts` subpath (bypassing the Node-only barrel) and
// vitest can drive every function directly.

/** One durable memory fact. Persisted as a row in userData/memory-facts.json. */
export interface MemoryFact {
  /** Stable unique id (never reused). */
  id: string
  /** The fact text injected into chat as a system-prompt line. */
  text: string
  /** How the fact was created: typed by the user, or proposed by auto-capture. */
  source: 'user' | 'auto'
  /** ISO-8601 creation timestamp. */
  createdAt: string
  /** When false the fact is kept but NOT injected (soft-disable, not delete). */
  enabled: boolean
}

/**
 * Soft character budget for the injected memory block. The old blob was capped
 * at 4000; facts get a tighter 2500 so the joined block stays cheap in every
 * request. This is a WARNING threshold (the UI flags over-budget), not a hard
 * truncation — parity with the old textarea's soft char-count behaviour.
 */
export const FACT_BUDGET_CHARS = 2500

export interface FactGenOptions {
  /** Clock injection (tests pass a fixed clock). Defaults to Date.now-based ISO. */
  now?: () => string
  /** Id generator injection (tests pass a deterministic counter). */
  idGen?: () => string
}

// Leading list markers stripped when migrating a free-form blob into facts so
// "- always use tabs" and "1. prefer pnpm" become clean fact text.
const BULLET_PREFIX = /^\s*(?:[-*•‣▪]|\d+[.)])\s+/

/**
 * Split a free-form memory blob into distinct fact texts: one per non-empty
 * line, list-marker-stripped, trimmed, de-duplicated case-insensitively while
 * preserving first-seen order.
 */
export function splitBlobToFactTexts(blob: string): string[] {
  if (!blob) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const rawLine of blob.split(/\r?\n/)) {
    const line = rawLine.replace(BULLET_PREFIX, '').trim()
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

let _idCounter = 0
function defaultIdGen(): string {
  _idCounter += 1
  return `f_${Date.now().toString(36)}_${_idCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Migrate a free-form userMemory blob into fact rows (all source='user',
 * enabled). Pure: the clock + id generator are injectable so the migration is
 * deterministic under test. Idempotency is NOT enforced here — it is the
 * store's job (migrate exactly once, guarded by file existence).
 */
export function migrateBlobToFacts(blob: string, opts: FactGenOptions = {}): MemoryFact[] {
  const now = opts.now ?? (() => new Date().toISOString())
  const idGen = opts.idGen ?? defaultIdGen
  return splitBlobToFactTexts(blob).map((text): MemoryFact => ({
    id: idGen(),
    text,
    source: 'user',
    createdAt: now(),
    enabled: true,
  }))
}

/**
 * Join the ENABLED facts into the exact text injected into chat (and shown in
 * the "what the model sees" preview). Disabled or blank facts are dropped;
 * first-seen order is preserved.
 */
export function joinEnabledFacts(facts: readonly MemoryFact[]): string {
  return facts
    .filter(f => f.enabled && f.text.trim())
    .map(f => f.text.trim())
    .join('\n')
}

export interface FactsBudget {
  /** Character length of the joined enabled-facts block. */
  chars: number
  /** The soft limit compared against. */
  limit: number
  /** True when `chars` exceeds `limit` (UI shows an over-budget warning). */
  overBudget: boolean
}

/** Measure the enabled-facts block against the soft budget. */
export function factsBudget(facts: readonly MemoryFact[], limit = FACT_BUDGET_CHARS): FactsBudget {
  const chars = joinEnabledFacts(facts).length
  return { chars, limit, overBudget: chars > limit }
}

// ── Auto-capture heuristic (v1: zero-LLM, conservative) ───────────────────────
//
// Scans a USER chat message for a DURABLE preference / identity statement and,
// if found, proposes the sentence as a candidate fact. This NEVER saves on its
// own — the caller shows a "Remember this?" chip and only stores on the click.
// The bias is precision over recall: it is far better to miss a preference than
// to nag on ordinary messages, so questions, code, slash-commands, and
// out-of-range lengths are rejected up front and only a small, high-signal cue
// set fires.

const MIN_CAPTURE_LEN = 8
const MAX_CAPTURE_LEN = 240

// English durable-preference / identity cues (word-boundary anchored so they
// don't fire inside larger words).
const EN_CUES: readonly RegExp[] = [
  /\bmy name is\b/i,
  /\bcall me\b/i,
  /\bi (?:prefer|always|usually|generally|never|only ever)\b/i,
  /\bi (?:like|want|need|'d like) you to\b/i,
  /\bplease (?:always|never)\b/i,
  /\bremember (?:that|to|:)\b/i,
]
// Imperative preference at the very start ("Always use tabs", "Never force-push").
const EN_LEADING = /^(?:always|never)\b/i

// Russian cues — matched as distinctive multi-char phrases (ASCII \b is
// unreliable around Cyrillic, so no word boundaries here).
const RU_CUES: readonly RegExp[] = [
  /меня зовут/i,
  /зови меня/i,
  /называй меня/i,
  /я предпочитаю/i,
  /я (?:всегда|обычно|никогда)/i,
  /запомни/i,
]

// Obvious non-preferences that share a cue word — rejected to protect precision
// ("Never mind", "always been", "always was").
const STOP_PHRASES = /^(?:never ?mind|always been|always was)\b/i

/**
 * Reduce a captured message to the single proposed fact: first line, first
 * sentence, capped at 200 chars — so a preference buried in a longer message
 * doesn't drag the whole paragraph into memory.
 */
function firstSentence(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? '').trim()
  const m = line.match(/^(.{8,}?[.!])(?:\s|$)/)
  const candidate = (m ? m[1]! : line).trim()
  return candidate.slice(0, 200).trim()
}

/**
 * Inspect a user message and return a proposed durable fact, or null when the
 * message is not a clear preference/identity statement.
 *
 * Conservative by design (v1): questions, slash-commands, code fences, and
 * too-short / too-long messages are rejected before any cue is tested.
 */
export function detectCaptureCandidate(message: string): string | null {
  const trimmed = (message ?? '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/')) return null          // slash-command, not prose
  if (trimmed.startsWith('```')) return null         // code block
  if (trimmed.endsWith('?')) return null             // a question, not a preference
  if (trimmed.length < MIN_CAPTURE_LEN) return null
  if (trimmed.length > MAX_CAPTURE_LEN) return null
  if (STOP_PHRASES.test(trimmed)) return null

  const hit =
    EN_LEADING.test(trimmed) ||
    EN_CUES.some(r => r.test(trimmed)) ||
    RU_CUES.some(r => r.test(trimmed))
  if (!hit) return null

  const candidate = firstSentence(trimmed)
  return candidate.length >= MIN_CAPTURE_LEN ? candidate : null
}
