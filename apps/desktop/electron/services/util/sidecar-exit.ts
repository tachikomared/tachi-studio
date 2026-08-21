// apps/desktop/electron/services/util/sidecar-exit.ts
//
// Turn a dead sidecar into a sentence the user can act on.
//
// WHY THIS FILE EXISTS. On 2026-08-02 a first run in the CODE tab printed:
//
//     Installing OpenClaude (first run, ~1 min)…
//     process exited with code 1
//
// …while the child process had already written the entire diagnosis to its own
// stderr, which the spawn handler piped to a log file and then discarded:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk'
//     imported from …\node_modules\@gitlawb\openclaude\dist\sdk.mjs
//
// An exit code is not a diagnosis. Everything this module emits is DERIVED from
// what the child actually printed — it never guesses a cause — and it always
// names the log file so the untruncated output is one step away.
//
// Pure TypeScript: no imports, no side effects, vitest-importable.

/** Longest excerpt of a child's own error line we inline into the message. */
const MAX_LINE = 300

/**
 * Build the user-facing message for a sidecar that exited.
 *
 * @param code    exit code as reported by the 'exit' event (null when killed).
 * @param tail    last few KB of the child's combined stdout+stderr.
 * @param logPath absolute path of the rolling log holding the full output.
 * @param name    display name of the sidecar, e.g. 'OpenClaude'.
 */
export function explainSidecarExit(
  code: number | null,
  tail: string,
  logPath: string,
  name = 'The sidecar',
): string {
  const lines = tail.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const head = `${name} exited with code ${code ?? 'null'}`
  const where = `Full output: ${logPath}`

  // An unresolvable module kills the process at ESM link time, before a line of
  // our wrapper runs. That is an INCOMPLETE INSTALL, not a bad configuration,
  // and the remedy is a reinstall — so say so instead of leaking a stack trace.
  const missing = tail.match(/Cannot find (?:package|module) '([^']+)'/)
  if (missing) {
    return `${head}: its install is incomplete — it could not load "${missing[1]}". `
      + 'Tachi will reinstall it on the next run; if this repeats, delete the sidecar\'s '
      + `folder under the app data directory and try again. ${where}`
  }

  // Port problems are distinctive, self-inflicted, and nothing to do with the
  // package tree — a reinstall would be the wrong advice.
  const listen = lines.find(l => /listen (EADDRINUSE|EACCES)/.test(l))
  if (listen) {
    return `${head}: it could not open its local port — ${listen.slice(0, MAX_LINE)}. `
      + `Another process may be holding it; retry, or restart the app. ${where}`
  }

  // Otherwise quote the child. Prefer the first line that reads as a thrown
  // error; fall back to the last thing it managed to print before dying.
  const errLine = lines.find(l => /^[A-Za-z]*(Error|Exception)(:| \[)/.test(l))
    ?? lines[lines.length - 1]
  return errLine
    ? `${head}: ${errLine.slice(0, MAX_LINE)}. ${where}`
    : `${head} without printing a reason. ${where}`
}
