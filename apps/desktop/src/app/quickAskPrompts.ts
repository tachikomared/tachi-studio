// apps/desktop/src/app/quickAskPrompts.ts
//
// QUICK-PROMPT CHIPS for the quick-ask bar — the pure half (no React, no
// electron), so the node-env unit tests can drive it directly.
//
// Two sources feed the chip row:
//   • BUILT-INS  — translate / summarize / explain / fix. TRANSLATE targets the
//     app UI language, and falls back to English when the text already IS in
//     that language (otherwise "translate into Russian" on Russian text is a
//     no-op the user paid a round-trip for).
//   • THE CHAT PROMPT LIBRARY — the SAME store the chat InputBar picker uses
//     (src/store/prompts.store). There is deliberately no second library here.
//     The bar has no {{variable}} form, so only templates it can run in ONE
//     click surface: no user slots at all, or only CONTENT slots ({{text}},
//     {{code}}, …) which the armed clipboard/selection context fills.
//
// composeQuickAsk() is the single place that decides how a chip template, the
// armed context and whatever the user typed become ONE user turn.

import { extractUserVariables, type PromptTemplate } from '@tachi/core/src/prompts/template'

/** A one-click chip: a template plus the label/tooltip shown in the bar. */
export type QuickPrompt = {
  id: string
  label: string
  template: string
  builtin: boolean
}

/** How many saved library prompts the bar shows (newest first). */
export const QUICKASK_LIBRARY_CHIPS_MAX = 6

/**
 * Slots the bar can fill by itself from the armed context. Everything else
 * ({{bullets}}, {{language}}, {{topic}}…) needs the chat picker's form, so
 * those templates stay out of the chip row instead of being sent half-filled.
 */
export const QUICKASK_CONTENT_SLOTS = new Set([
  'text', 'code', 'content', 'input', 'selection', 'article', 'document', 'snippet',
])

/** Mirrors VAR_RE in @tachi/core/src/prompts/template (kept local: it is a /g
 *  regex and reusing a shared instance across calls carries lastIndex state). */
const slotRe = () => /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g

/** English names for the shipped locales — the prompt itself is English, so the
 *  target language is named in English rather than natively. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Portuguese',
  it: 'Italian',
  pl: 'Polish',
  uk: 'Ukrainian',
  tr: 'Turkish',
  nl: 'Dutch',
}

/** 'ru-RU' / 'ru_RU' / 'ru' → 'Russian'. Unknown tags fall back to English. */
export function uiLanguageName(lng: string | undefined | null): string {
  const base = String(lng ?? '').toLowerCase().split(/[-_]/)[0]
  return LANGUAGE_NAMES[base] ?? 'English'
}

/** The four always-present chips. `uiLang` is the active i18n language tag. */
export function builtinQuickPrompts(uiLang: string | undefined | null): QuickPrompt[] {
  const lang = uiLanguageName(uiLang)
  const other = lang === 'English' ? 'the original language' : 'English'
  return [
    {
      id: 'qp-translate',
      label: 'translate',
      builtin: true,
      template:
        `Translate the text into ${lang}. If the text is already in ${lang}, translate it into ${other} instead. ` +
        'Keep the tone, names, numbers and line breaks. Output only the translation, no commentary.',
    },
    {
      id: 'qp-summarize',
      label: 'summarize',
      builtin: true,
      template:
        'Summarize the text as a tight bullet list — at most 5 bullets, one line each. ' +
        'Keep concrete numbers, names and dates. No preamble, no closing sentence.',
    },
    {
      id: 'qp-explain',
      label: 'explain',
      builtin: true,
      template:
        'Explain the text in plain language for someone smart but new to the topic. ' +
        'Define any jargon inline, use one concrete example, keep it to a few short paragraphs.',
    },
    {
      id: 'qp-fix',
      label: 'fix',
      builtin: true,
      template:
        'Fix grammar, spelling, punctuation and clumsy phrasing in the text. ' +
        'Preserve the meaning, the tone and the original language. Output only the corrected text.',
    },
  ]
}

/** True when every user slot in the body is one the bar can fill itself. */
export function isOneClickTemplate(body: string): boolean {
  return extractUserVariables(String(body ?? '')).every(v => QUICKASK_CONTENT_SLOTS.has(v))
}

/** Saved chat-library templates, newest first, capped — one-click ones only. */
export function libraryQuickPrompts(
  templates: PromptTemplate[] | undefined | null,
  max: number = QUICKASK_LIBRARY_CHIPS_MAX,
): QuickPrompt[] {
  const list = Array.isArray(templates) ? templates : []
  return list
    .filter(tpl => !!tpl && typeof tpl.body === 'string' && tpl.body.trim().length > 0)
    .filter(tpl => isOneClickTemplate(tpl.body))
    .slice()
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, Math.max(0, max))
    .map(tpl => ({
      id: tpl.id,
      label: tpl.title?.trim() || 'untitled',
      template: tpl.body,
      builtin: false,
    }))
}

/**
 * ONE user turn out of (chip template, armed context, typed input).
 *
 * The context is substituted into a CONTENT slot when the template has one;
 * otherwise it is appended as a fenced block so the model can tell instruction
 * from payload. Anything the user typed rides along as an extra instruction.
 */
export function composeQuickAsk(template: string, context: string, typed: string): string {
  const ctx = String(context ?? '').trim()
  const extra = String(typed ?? '').trim()
  let head = String(template ?? '').trim()

  let ctxUsed = false
  if (head && ctx) {
    head = head.replace(slotRe(), (whole, name: string) => {
      if (!QUICKASK_CONTENT_SLOTS.has(name)) return whole
      ctxUsed = true
      return ctx
    })
  }

  const parts: string[] = []
  if (head) parts.push(head)
  if (extra) parts.push(extra)
  let out = parts.join('\n\n')
  if (ctx && !ctxUsed) out = out ? `${out}\n\n---\n${ctx}` : ctx
  return out.trim()
}

/** Display-only shortening for a user turn that carries a big context block —
 *  the bar is 640px wide, the model still gets the full text. */
export function previewTurnText(content: string, max = 320): string {
  const s = String(content ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max).trimEnd()}… (+${s.length - max} chars)`
}
