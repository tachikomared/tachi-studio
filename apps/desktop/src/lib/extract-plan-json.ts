// apps/desktop/src/lib/extract-plan-json.ts
//
// Sprint F2: Utility for extracting structured plan JSON from agent responses.

import type { SlashCommandResult } from '../types/slash-commands'

/**
 * Regex that matches a <tachi-plan type="..."> ... </tachi-plan> wrapper.
 *
 * Permissiveness profile (Sprint F2 Wave 1 review):
 * - Tolerates leading prose before the tag.
 * - Tolerates trailing prose after the closing tag.
 * - Captures the type attribute (group 1) and inner content (group 2).
 * - Multiline / dotall via `[\s\S]*?` so newlines inside the JSON are matched.
 * - Case-insensitive (`/i`) so `<Tachi-Plan>`, `<TACHI-PLAN>`, etc. all work.
 * - Tolerates extra whitespace inside the opening tag:
 *     - Around the attribute (`<tachi-plan  type="plan">`)
 *     - Around the `=` sign (`<tachi-plan type = "plan">`)
 *     - Before the closing `>` (`<tachi-plan type="plan" >`)
 * - Single OR double quotes around the type value (`type='plan'` or `type="plan"`).
 *
 * Inner whitespace / BOM tolerance is handled at parse-time by `rawJson.trim()`.
 * A leading BOM (U+FEFF) or other Unicode whitespace anywhere in `text` does
 * NOT block the match because the regex isn't anchored — it finds the tag
 * wherever it appears in the body.
 */
const TACHI_PLAN_RE = /<tachi-plan\s+type\s*=\s*["'](troubleshoot|refactor|review|plan)["']\s*>([\s\S]*?)<\/tachi-plan>/i

/**
 * Scan agent text for a `<tachi-plan type="..."> ... </tachi-plan>` wrapper
 * and parse the inner JSON into a {@link SlashCommandResult}.
 *
 * Permissive: tolerates leading prose before the tag, tolerates whitespace
 * inside the tag, tolerates trailing prose after the closing tag.
 * Returns `null` on no match or malformed JSON.
 *
 * Also validates that the parsed JSON has a `command` field whose value
 * matches the tag's `type` attribute. A mismatch returns `null`.
 *
 * @param text - Raw agent response text (may include prose before/after the tag).
 * @returns Parsed {@link SlashCommandResult} or `null` on any failure.
 *
 * @example
 * // Valid — returns a TroubleshootPlan
 * const result = extractPlanJson(
 *   'Here is my analysis:\n' +
 *   '<tachi-plan type="troubleshoot">{"command":"troubleshoot",...}</tachi-plan>'
 * )
 *
 * @example
 * // Returns null — command field mismatches type attribute
 * extractPlanJson('<tachi-plan type="review">{"command":"refactor",...}</tachi-plan>')
 * // => null
 */
export function extractPlanJson(text: string): SlashCommandResult | null {
  const match = TACHI_PLAN_RE.exec(text)
  if (!match) return null

  const capturedType = match[1]
  const rawJson      = match[2]

  if (!capturedType || rawJson == null) return null

  // Strip a leading BOM (U+FEFF) or stray Unicode space chars before parsing.
  // Modern V8 `.trim()` already covers U+FEFF, but we strip explicitly so a
  // future engine change can't silently regress this code path.
  const cleaned = rawJson.replace(/^[﻿\s]+|[﻿\s]+$/g, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  // Basic structural guard: must be an object with a string `command` field.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('command' in parsed) ||
    typeof (parsed as Record<string, unknown>).command !== 'string'
  ) {
    return null
  }

  const cmd = (parsed as Record<string, unknown>).command as string

  // The command field must match the type attribute in the tag.
  if (cmd !== capturedType) return null

  // All four command values are valid SlashCommandResult discriminants.
  // We trust the agent to emit the correct shape; full runtime validation
  // is deferred to the card renderer which can tolerate missing optional fields.
  return parsed as SlashCommandResult
}
