// apps/desktop/electron/services/protected-paths.ts
//
// Determines whether a filesystem path is "protected" — i.e. should always
// require explicit user permission before an agent tool is allowed to mutate it.
//
// Protected criteria (evaluated in order):
//   1. Anything that resolves outside the active workingDir (e.g. ".." traversal).
//   2. Any .git/ directory or file inside .git/.
//   3. Files matching secret patterns: .env*, *.key, *.pem, *.p12, *.pfx,
//      *.crt, *.cer, id_rsa, id_ed25519, known_hosts, .netrc, .npmrc (with token).
//   4. Anything under HOME that is not inside workingDir.

import { resolve, relative, normalize } from 'path'
import { homedir } from 'os'

const SECRET_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i,         // .env, .env.local, .env.production, …
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^known_hosts$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,            // may contain auth tokens
]

/**
 * Returns true when the given path should require explicit permission before
 * an agent tool is allowed to mutate it.
 *
 * @param path       - Absolute or relative path as passed in the tool input.
 * @param workingDir - The active agent workspace root (absolute).
 */
export function isPathProtected(path: string, workingDir: string): boolean {
  const abs = resolve(workingDir, path)
  const normalWork = normalize(workingDir)

  // 1. Outside workingDir — always protected.
  const rel = relative(normalWork, abs)
  if (rel.startsWith('..')) return true

  // 2. Anything inside .git/
  const segments = abs.replace(/\\/g, '/').split('/')
  if (segments.includes('.git')) return true

  // 3. Matches a secret-file pattern — check the basename only.
  const basename = segments[segments.length - 1] ?? ''
  if (SECRET_PATTERNS.some(re => re.test(basename))) return true

  // 4. Under HOME but not under workingDir.
  const home = homedir()
  if (home) {
    const relFromHome = relative(normalize(home), abs)
    const relFromWork = relative(normalWork, abs)
    if (!relFromHome.startsWith('..') && relFromWork.startsWith('..')) return true
  }

  return false
}
