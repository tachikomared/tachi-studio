// apps/desktop/src/components/toolCallRow.format.ts
//
// Pure formatting helpers behind <ToolCallRow>. Framework-free (no React, no
// DOM, no CSS import) so they are unit-testable in isolation — see
// test/unit/toolCallRow.test.ts. Kept in a sibling module (mirrors the
// SwarmHistory.tsx / runHistory.ts split) so the node-env vitest never has to
// load React.

/** Lifecycle of a single tool invocation as the row understands it. */
export type ToolCallStatus = 'running' | 'ok' | 'error'

/**
 * Human duration for a tool call. Matches the format the agent transcript
 * already used ("820ms", "1.2s") so refactoring existing call sites does not
 * shift a single character. Sub-second → integer ms; otherwise seconds to one
 * decimal. Non-finite / negative input → "" (render nothing).
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * One-line preview of a tool's arguments for the collapsed row. Accepts the
 * raw value the harness emitted:
 *   - a string is used as-is (already-stringified args / a command / a path),
 *   - anything else is JSON-stringified (falling back to String() if that
 *     throws, e.g. a circular object),
 *   - null / undefined → "".
 * Whitespace (including newlines) is collapsed to single spaces so a multi-line
 * blob still renders as one scannable line, then truncated to `maxLen` with an
 * ellipsis. Pure.
 */
export function formatArgsPreview(input: unknown, maxLen = 60): string {
  if (input == null) return ''
  let s: string
  if (typeof input === 'string') {
    s = input
  } else {
    try {
      s = JSON.stringify(input)
    } catch {
      s = String(input)
    }
    if (s === undefined) s = String(input)
  }
  s = s.replace(/\s+/g, ' ').trim()
  if (maxLen > 0 && s.length > maxLen) return s.slice(0, maxLen) + '…'
  return s
}

/**
 * Compact token count ("512", "1.2k", "3.4M"). Non-finite / negative → "".
 * Distinct from the observability rollup's formatter on purpose — this one is
 * for the terse trailing chip on a single row.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** CSS-var color for a status. Brutalist theme tokens (with a hard fallback). */
export function toolCallStatusColor(status: ToolCallStatus): string {
  switch (status) {
    case 'running': return 'var(--accent)'
    case 'error':   return 'var(--danger, #ff5252)'
    case 'ok':
    default:        return 'var(--success)'
  }
}
