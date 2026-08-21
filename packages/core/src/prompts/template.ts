// packages/core/src/prompts/template.ts
//
// Prompt-library primitives (Phase 2 #3). A template is plain text with
// {{variable}} slots. Pure + renderer-safe: the store/UI live in the app,
// these helpers own the syntax so chat and the Nodes Prompt node render
// identically.

export interface PromptTemplate {
  id: string
  title: string
  body: string
  /** Optional grouping tag shown in the picker. */
  tag?: string
  createdAt: number
  updatedAt: number
}

// {{ name }} — identifier-ish names only, so JSON braces / code snippets in a
// template body don't get mistaken for variables.
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g

/**
 * Auto-variables resolved at SEND time from context — the user never fills
 * these (a top request across LM Studio/Jan: users hand-edit the date daily,
 * lms#1744). The picker excludes them from its input list; the caller merges
 * buildAutoVariableValues() UNDER the user's explicit values before rendering.
 */
export const AUTO_VARIABLES = new Set(['date', 'time', 'datetime', 'os', 'model'])

/** All unique variable names in order of first appearance (incl. auto-vars). */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of body.matchAll(VAR_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]) }
  }
  return out
}

/** Variables the USER must supply — extractVariables minus the auto-vars. */
export function extractUserVariables(body: string): string[] {
  return extractVariables(body).filter(v => !AUTO_VARIABLES.has(v))
}

/**
 * Compute auto-variable values from context. Pure: the caller passes `now`
 * (ms), the current OS label, and the active model id, so it stays testable
 * and free of Date.now()/navigator. Only the keys present in the template
 * actually get used (renderTemplate ignores extras).
 */
export function buildAutoVariableValues(ctx: { now: number; os?: string; model?: string; locale?: string }): Record<string, string> {
  const d = new Date(ctx.now)
  const loc = ctx.locale || undefined
  return {
    date: d.toLocaleDateString(loc),
    time: d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }),
    datetime: d.toLocaleString(loc),
    os: ctx.os ?? '',
    model: ctx.model ?? '',
  }
}

/**
 * Fill {{slots}} from `values`. Missing values keep the literal slot so the
 * user sees what still needs attention (never silently drops content).
 */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(VAR_RE, (whole, name: string) => {
    const v = values[name]
    return typeof v === 'string' && v.length > 0 ? v : whole
  })
}

// ── Fill-in-the-blanks (batch36) ─────────────────────────────────────────────
//
// The composer paints an UNFILLED variable as a chip. The whole design rests on
// one invariant: **the chip IS the literal `{{name}}` still present in the
// text**. There is no parallel document model, no chip id, no hidden state that
// can drift out of sync with the textarea — a blank is filled exactly when its
// braces stop existing, which is what typing over the selected range already
// does. That is why this feature needs no rich-text editor (see the batch36
// report: @tiptap + prosemirror measured 134 KB gzip to render a few spans).
//
// Note the deliberate difference from extractVariables(): that one de-dupes,
// because the picker shows ONE input per name. These return EVERY OCCURRENCE,
// because two `{{text}}` in a body are two separate blanks on screen.

/** One literal `{{name}}` occurrence, located in the source text. */
export interface VarSlot {
  /** Variable name between the braces. */
  name: string
  /** Index of the opening brace. */
  start: number
  /** Index one PAST the closing brace, so text.slice(start, end) is the slot. */
  end: number
  /** True for the auto-vars. They can survive a render (buildAutoVariableValues
   *  yields '' for an unknown os/model and renderTemplate keeps empties literal),
   *  so they are real blanks too — the flag is informational, not an exclusion. */
  auto: boolean
}

/** Every `{{name}}` occurrence, in source order. Duplicates are kept. */
export function findSlots(text: string): VarSlot[] {
  const out: VarSlot[] = []
  for (const m of text.matchAll(VAR_RE)) {
    const start = m.index ?? 0
    out.push({ name: m[1], start, end: start + m[0].length, auto: AUTO_VARIABLES.has(m[1]) })
  }
  return out
}

/**
 * The slot a Tab should jump to from `caret`, wrapping at the ends.
 *
 * Forward uses `start > caret` (not `>=`) on purpose: selecting a slot puts the
 * caret at its own `start`, so `>=` would re-select the slot you are standing
 * on and Tab would never advance. Backward is the mirror (`end <= caret`).
 */
export function nextSlot(slots: VarSlot[], caret: number, dir: 1 | -1 = 1): VarSlot | null {
  if (slots.length === 0) return null
  if (dir === 1) return slots.find(s => s.start > caret) ?? slots[0]
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i].end <= caret) return slots[i]
  return slots[slots.length - 1]
}

/**
 * Split `text` into paint runs for the highlight layer: plain stretches carry
 * `slot: null`, blanks carry their slot. Concatenating every `.text` MUST
 * reproduce the input exactly — the layer sits under a transparent textarea and
 * any dropped or added character would shift every glyph after it.
 */
export function segmentBySlots(text: string): Array<{ text: string; slot: VarSlot | null }> {
  const out: Array<{ text: string; slot: VarSlot | null }> = []
  let at = 0
  for (const s of findSlots(text)) {
    if (s.start > at) out.push({ text: text.slice(at, s.start), slot: null })
    out.push({ text: text.slice(s.start, s.end), slot: s })
    at = s.end
  }
  if (at < text.length) out.push({ text: text.slice(at), slot: null })
  return out
}

/** Starter library — seeded once when the store is empty. */
export function starterTemplates(now: number = Date.now()): PromptTemplate[] {
  const mk = (id: string, title: string, body: string, tag: string): PromptTemplate =>
    ({ id, title, body, tag, createdAt: now, updatedAt: now })
  return [
    mk('starter-summarize', 'Summarize', 'Summarize the following in {{bullets}} bullet points, keeping concrete numbers and names:\n\n{{text}}', 'writing'),
    mk('starter-translate', 'Translate', 'Translate the following into {{language}}. Keep tone and formatting; do not explain:\n\n{{text}}', 'writing'),
    mk('starter-review', 'Code review', 'Review this code for bugs, edge cases and unclear naming. Point at exact lines, suggest minimal fixes:\n\n{{code}}', 'code'),
    mk('starter-explain', 'Explain simply', 'Explain {{topic}} like I am smart but new to the field. Use one concrete analogy. End with the three most important takeaways.', 'learn'),
    mk('starter-rewrite', 'Rewrite tighter', 'Rewrite the following to be half as long without losing meaning. Keep the author’s voice:\n\n{{text}}', 'writing'),
  ]
}
