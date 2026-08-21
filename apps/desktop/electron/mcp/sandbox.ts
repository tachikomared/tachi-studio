// apps/desktop/electron/mcp/sandbox.ts
//
// Path-sandbox helper. The MCP server scopes file/git/diff operations to the
// caller-provided workspaceRoot. Any traversal attempt ('..', absolute path
// outside root, symlink-escape) is refused at the boundary with a JSON-RPC
// error rather than reaching the underlying fs/git syscalls.
//
// Callers pass an externally-supplied 'path' (string, treated as POSIX-style
// even on Windows for the MCP wire format). resolveInside() resolves it
// against workspaceRoot, normalises, and asserts the final absolute path is
// inside workspaceRoot. Returns the absolute path on success or throws an
// Error whose message becomes the JSON-RPC error message.

import { resolve, isAbsolute, normalize } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'
import { isPathWithin } from '../services/util/path-containment'

export class SandboxViolation extends Error {
  constructor(msg: string) { super(msg); this.name = 'SandboxViolation' }
}

/**
 * Resolve `userPath` relative to `workspaceRoot`. Refuses:
 *   - absolute paths that don't start with workspaceRoot
 *   - any path containing `..` segments that escape workspaceRoot
 *   - symlink targets outside workspaceRoot (when the path exists)
 */
export function resolveInside(workspaceRoot: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new SandboxViolation('path is required')
  }
  // Disallow embedded NUL bytes (would truncate on syscall path)
  if (userPath.includes('\0')) {
    throw new SandboxViolation('path contains NUL byte')
  }

  const root = normalize(workspaceRoot)
  const candidate = isAbsolute(userPath)
    ? normalize(userPath)
    : normalize(resolve(root, userPath))

  // Containment via path-correct resolution + relative() rather than a raw
  // string prefix. This closes two gaps in the old prefix compare: a Windows
  // extended-length path (\\?\C:\..., \\?\UNC\...) no longer bypasses or
  // false-fails the check, and a sibling that merely shares the root as a
  // string prefix (C:\work-evil under C:\work) is correctly rejected. win32
  // case-insensitivity is handled inside isPathWithin.
  if (!isPathWithin(root, candidate)) {
    throw new SandboxViolation(`path escapes workspaceRoot: ${userPath}`)
  }

  // If the path exists, also assert the symlink-resolved target is still inside.
  if (existsSync(candidate)) {
    try {
      const real = realpathSync(candidate)
      if (!isPathWithin(root, real)) {
        throw new SandboxViolation(`symlink target escapes workspaceRoot: ${userPath}`)
      }
    } catch (e) {
      if (e instanceof SandboxViolation) throw e
      // realpath can fail for valid reasons (permission, race) — fall through.
    }
  }

  return candidate
}
