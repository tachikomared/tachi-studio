/**
 * Slash-command grammar parser for TachiDesk agent input bar.
 *
 * Recognises the four structured commands (/troubleshoot, /refactor, /review,
 * /plan) and the optional --fix flag. Everything else is returned as null so
 * the caller can fall back to free-prose behaviour unchanged.
 *
 * Type definitions live in `@tachi/core` (packages/core/src/agent/types.ts)
 * — this module re-exports them so renderer callers can keep a single import
 * site without crossing the package boundary by hand.
 *
 * @module slash-parser
 */

import type { ParsedSlashCommand, SlashCommand } from '@tachi/core'

// Re-export for renderer callers (kept as type-only to satisfy isolatedModules).
export type { ParsedSlashCommand, SlashCommand }

const COMMANDS: readonly SlashCommand[] = ['troubleshoot', 'refactor', 'review', 'plan'] as const

/**
 * Parse a leading slash command from user input.
 *
 * ## Returns `null` when
 * - Input is empty / whitespace-only.
 * - Input is just `/` with nothing after (commandToken is the empty string).
 * - Input does not start with `/` (after optional leading whitespace).
 * - The command token after `/` is not one of the four recognised commands
 *   (case-sensitive — see "Case sensitivity" below).
 * - The slash token is not followed by a space-separated command (e.g.
 *   `/troubleshoot--fix` is invalid — a space is required before flags).
 *
 * ## Case sensitivity
 * Lowercase ONLY. `/troubleshoot` parses; `/Troubleshoot`, `/TROUBLESHOOT`,
 * `/Plan` all return `null`. This matches the documented grammar in the
 * sprint design doc and keeps the command surface predictable for users
 * coming from CLI shells where case matters.
 *
 * ## Whitespace handling
 * - Leading whitespace before the slash is tolerated (`trimStart` is applied).
 * - Tabs, multi-space runs, and mixed whitespace between tokens all collapse
 *   to single separators (`\s+` split).
 *
 * ## --fix flag rules (flag-anywhere strip)
 * - `--fix` may appear at any position after the command token. Every
 *   occurrence is stripped from the final `rawArgs`. The flag must match
 *   exactly — `--fixed`, `--fix=true`, `-fix` etc. are treated as ordinary
 *   args and pass through to `rawArgs`.
 * - Duplicates are tolerated. `/plan --fix --fix x` → `flags.fix = true`,
 *   `rawArgs = 'x'`.
 *
 * @example
 * parseSlashCommand('/troubleshoot foo bar')
 * // → { command: 'troubleshoot', flags: { fix: false }, rawArgs: 'foo bar' }
 *
 * @example
 * parseSlashCommand('/refactor --fix abc')
 * // → { command: 'refactor', flags: { fix: true }, rawArgs: 'abc' }
 *
 * @example
 * parseSlashCommand('/plan abc --fix def')
 * // → { command: 'plan', flags: { fix: true }, rawArgs: 'abc def' }
 * // (flag-anywhere: --fix is stripped no matter where it lives)
 *
 * @example
 * parseSlashCommand('/UNKNOWN foo')      // → null
 * parseSlashCommand('/Troubleshoot foo') // → null  (uppercase rejected)
 * parseSlashCommand('/')                 // → null  (no command token)
 * parseSlashCommand('')                  // → null
 * parseSlashCommand('   ')               // → null
 * parseSlashCommand('hello /plan foo')   // → null  (not at start)
 *
 * @example
 * parseSlashCommand('/troubleshoot')
 * // → { command: 'troubleshoot', flags: { fix: false }, rawArgs: '' }
 *
 * @example
 * parseSlashCommand('  /troubleshoot\tfoo')
 * // → { command: 'troubleshoot', flags: { fix: false }, rawArgs: 'foo' }
 * // (tabs are valid token separators)
 *
 * @example
 * parseSlashCommand('/troubleshoot --fixed')
 * // → { command: 'troubleshoot', flags: { fix: false }, rawArgs: '--fixed' }
 * // (--fixed is NOT --fix; only the exact token is matched)
 *
 * @example
 * parseSlashCommand('/troubleshoot --fix --fix x')
 * // → { command: 'troubleshoot', flags: { fix: true }, rawArgs: 'x' }
 * // (duplicate --fix is tolerated; both tokens are stripped)
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  // Guard: null / undefined / non-string inputs (defensive JS boundary callers).
  if (!input || typeof input !== 'string') return null

  const trimmed = input.trimStart()

  // Must start with a slash.
  if (!trimmed.startsWith('/')) return null

  // Tokenise on any whitespace (spaces, tabs, mixed runs).
  const tokens = trimmed.split(/\s+/)

  // First token is the command word, e.g. "/troubleshoot". Strip the leading /.
  // Case-SENSITIVE — uppercase or mixed case will fall through to the membership
  // check below and return null. This is intentional; see docstring.
  const commandToken = tokens[0].slice(1)

  // Empty token (input was just `/` or `/ ` with nothing after) — bail.
  if (commandToken.length === 0) return null

  // Must be one of the four recognised commands (exact, lowercase).
  if (!(COMMANDS as readonly string[]).includes(commandToken)) return null

  const command = commandToken as SlashCommand

  // Walk remaining tokens: collect --fix flags and gather rawArgs tokens.
  // Flag-anywhere strip: every exact `--fix` token sets the flag and is
  // removed from rawArgs, regardless of position. Non-matching variants
  // (--fixed, --fix=foo, -fix) flow through as ordinary args.
  let fix = false
  const argTokens: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--fix') {
      fix = true
      // Strip — do not push to argTokens. Duplicates are silently tolerated.
    } else {
      argTokens.push(tok)
    }
  }

  return {
    command,
    flags:   { fix },
    rawArgs: argTokens.join(' '),
  }
}
