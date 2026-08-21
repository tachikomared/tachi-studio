// apps/desktop/electron/services/util/path-containment.ts
//
// Platform-correct path-containment primitives. The MCP workspace sandbox
// must answer "is this target path inside this parent directory?" without
// being fooled by:
//   - Windows extended-length paths (\\?\C:\... and \\?\UNC\server\share\...)
//     which a string-prefix check on the non-prefixed root would let escape.
//   - sibling directories that share the parent as a string prefix
//     (C:\work-evil "startsWith" C:\work).
//
// Ported from ccpocket packages/bridge/src/path-utils.ts (extended-prefix
// stripping + relative()-based containment), adapted to this repo with
// win32 case-insensitivity and an explicit `platform` arg so the logic is
// unit-testable on any host.

import { posix, win32 } from 'node:path'

function pathApiFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

const EXT_PREFIX = '\\\\?\\'
const UNC_PREFIX = '\\\\?\\UNC\\'

/**
 * Strip a Windows extended-length path prefix so the remainder is a normal
 * win32 path that path.win32 understands:
 *   \\?\C:\dir\f          -> C:\dir\f
 *   \\?\UNC\server\share  -> \\server\share
 * A \\?\ device path with no drive letter (e.g. \\?\Volume{guid}\) is returned
 * untouched — stripping it would corrupt a path we cannot reason about, so we
 * keep it verbatim and let containment fail closed.
 */
export function stripWindowsExtendedPathPrefix(input: string): string {
  if (!input.startsWith(EXT_PREFIX)) return input

  if (input.startsWith(UNC_PREFIX)) {
    return `\\\\${input.slice(UNC_PREFIX.length)}`
  }

  const trimmed = input.slice(EXT_PREFIX.length)
  return /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed : input
}

/**
 * Normalize a path with the platform-correct path module. On win32 the
 * extended-length prefix is stripped first (the backslashes are separators);
 * on posix the input is left as-is (backslashes are valid filename chars).
 */
export function normalizePlatformPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApiFor(platform)
  const value = platform === 'win32' ? stripWindowsExtendedPathPrefix(input) : input
  return api.normalize(value)
}

function resolvePlatformPath(
  input: string,
  platform: NodeJS.Platform,
): string {
  const api = pathApiFor(platform)
  return api.resolve(normalizePlatformPath(input, platform))
}

/**
 * True iff `target` is `parent` itself or a descendant of it. Both paths are
 * extended-prefix-stripped, resolved to absolute, and compared via relative():
 * a relative path that is empty (==), or that does not start with '..' and is
 * not itself absolute, means containment. win32 comparison is case-insensitive
 * (the filesystem is); posix is case-sensitive.
 */
export function isPathWithin(
  parent: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApiFor(platform)
  let resolvedParent = resolvePlatformPath(parent, platform)
  let resolvedTarget = resolvePlatformPath(target, platform)

  if (platform === 'win32') {
    resolvedParent = resolvedParent.toLowerCase()
    resolvedTarget = resolvedTarget.toLowerCase()
  }

  if (resolvedTarget === resolvedParent) return true

  const rel = api.relative(resolvedParent, resolvedTarget)
  return rel !== '' && !rel.startsWith('..') && !api.isAbsolute(rel)
}
