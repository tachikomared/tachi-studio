// apps/desktop/electron/services/util/exec-failure.ts
//
// Silent (exit-0) execution-failure detection. Ported from agenticSeek's
// BashInterpreter.execution_failure_check (sources/tools/BashInterpreter.py),
// which scans tool output against ~23 lowercase regexes to catch a process that
// prints an error then exits 0 — e.g. a Go/Rust runtime panic written to stderr
// and merged into stdout via 2>&1, an npm crash, or a binary that segfaults
// after a wrapper script swallows the code.
//
// We deliberately KEEP A CONSERVATIVE SUBSET. agenticSeek also matches weak
// words ("error", "failed", "invalid", "missing", "expected", "exception", ...)
// that appear constantly in healthy output ("0 errors", "error handling",
// "tests passed: error case"), so porting it verbatim would flip successful
// runs to failures. Here we only match STRONG, unambiguous crash signals; a
// false negative (missing a weird failure) is far cheaper than a false positive
// (telling the model a good run failed).
//
// Pure TypeScript — no imports, no side effects (vitest-importable; no electron
// dependency). The bash tool calls detectExecFailure only on the exit-0,
// not-killed branch as a belt-and-suspenders check.

// Strong failure signals, lowercase. Each is a literal substring (not a regex):
// matching is a case-insensitive includes() so callers don't pay regex-escape
// surprises. Order matters only for which key we report on a multi-hit line;
// the more catastrophic signals come first.
const FAILURE_SIGNALS: readonly string[] = [
  'segmentation fault',
  'core dumped',
  'traceback (most recent call last)',
  'panic:',
  'fatal error:',
  'cannot execute binary file',
  'killed by signal',
  'aborted (core dumped)',
  // NOTE: 'command not found' and 'no such file or directory' were deliberately
  // REMOVED from the exit-0 path. They are genuinely ambiguous when the process
  // still exited 0: `grep -r`/`find` print "<prog>: <path>: No such file or
  // directory" to stderr for one inaccessible entry while succeeding overall,
  // and prose/test output ("handles command not found") trips a substring match.
  // A genuine missing command exits 127 and a genuine missing target almost
  // always exits non-zero — both already caught by toolBash's exit-code branch —
  // so dropping them here removes the false-positive vector at no real cost.
] as const

export interface ExecFailureResult {
  /** True when the output carries a strong failure signal despite a 0 exit. */
  failed: boolean
  /** The signal that matched (lowercase), present only when failed is true. */
  matched?: string
}

/**
 * Scan combined stdout+stderr for a strong execution-failure signal. Returns
 * the first matching signal (in FAILURE_SIGNALS order) or { failed: false }.
 * Conservative by design — see file header.
 */
export function detectExecFailure(output: string): ExecFailureResult {
  if (!output) return { failed: false }
  const hay = output.toLowerCase()
  for (const signal of FAILURE_SIGNALS) {
    if (hay.includes(signal)) return { failed: true, matched: signal }
  }
  return { failed: false }
}
