// apps/desktop/electron/services/util/env-filter.ts
//
// Allowlist-by-prefix environment filtering for spawning UNTRUSTED child
// processes (STEAL 2026-07-08, apple/container pattern). User-configured MCP
// servers are arbitrary third-party binaries; handing them the full parent
// process.env leaks whatever secrets happen to live there (API keys a user
// exported into their shell, CI tokens, cloud creds) to a process we don't
// control. This filter passes only the OS essentials a program needs to run
// plus our own TACHI_* namespace and any env the server config sets
// explicitly — never the ambient parent secrets.

/**
 * Base env names every process legitimately needs. Case varies by OS; we match
 * case-insensitively. Deliberately minimal — extend only with a clear need.
 */
const BASE_ALLOW = new Set([
  // POSIX + cross-platform essentials
  'path', 'home', 'lang', 'lc_all', 'tz', 'tmpdir', 'tmp', 'temp', 'shell', 'user', 'logname', 'pwd', 'term',
  // Windows essentials (a program that can't find these often won't launch)
  'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive', 'homedrive', 'homepath',
  'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'commonprogramfiles',
  'username', 'userprofile', 'computername', 'number_of_processors', 'processor_architecture', 'os',
])

/** Prefixes whose env vars are OURS to pass through (namespaced, non-secret). */
const ALLOW_PREFIXES = ['tachi_']

/**
 * Build a filtered env for an untrusted child: OS essentials + TACHI_* +
 * explicit `extra` (from the server config). Ambient parent secrets are
 * dropped. `extra` always wins on a name collision (the config is intentional).
 */
export function filterEnv(
  parent: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    const lower = k.toLowerCase()
    if (BASE_ALLOW.has(lower) || ALLOW_PREFIXES.some(p => lower.startsWith(p))) {
      out[k] = v
    }
  }
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v
  return out
}
