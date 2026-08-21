// apps/desktop/test/unit/pathContainment.test.ts
//
// Cross-platform path-containment primitives used by the MCP workspace
// sandbox. The functions take an explicit `platform` so both win32 and posix
// semantics are exercised deterministically on any host (the sandbox itself
// uses process.platform).

import { describe, it, expect } from 'vitest'
import {
  stripWindowsExtendedPathPrefix,
  normalizePlatformPath,
  isPathWithin,
} from '../../electron/services/util/path-containment'

describe('stripWindowsExtendedPathPrefix', () => {
  it('strips the \\\\?\\ drive-letter prefix', () => {
    expect(stripWindowsExtendedPathPrefix('\\\\?\\C:\\work\\file.txt')).toBe('C:\\work\\file.txt')
  })

  it('rewrites the \\\\?\\UNC\\ prefix back to a normal UNC path', () => {
    expect(stripWindowsExtendedPathPrefix('\\\\?\\UNC\\server\\share\\file')).toBe('\\\\server\\share\\file')
  })

  it('leaves a non-drive \\\\?\\ device path untouched (cannot safely strip)', () => {
    // \\?\Volume{guid}\ has no drive letter — stripping would corrupt it.
    const dev = '\\\\?\\Volume{abcd}\\x'
    expect(stripWindowsExtendedPathPrefix(dev)).toBe(dev)
  })

  it('returns ordinary paths unchanged', () => {
    expect(stripWindowsExtendedPathPrefix('C:\\work\\file.txt')).toBe('C:\\work\\file.txt')
    expect(stripWindowsExtendedPathPrefix('relative\\path')).toBe('relative\\path')
    expect(stripWindowsExtendedPathPrefix('/posix/path')).toBe('/posix/path')
  })
})

describe('normalizePlatformPath', () => {
  it('strips the extended prefix and normalizes on win32', () => {
    expect(normalizePlatformPath('\\\\?\\C:\\work\\..\\work\\f', 'win32')).toBe('C:\\work\\f')
  })

  it('does not strip the extended prefix on posix (it is a literal name there)', () => {
    // On posix the backslashes are valid filename characters, not separators.
    const p = normalizePlatformPath('\\\\?\\C:\\work', 'linux')
    expect(p).toBe('\\\\?\\C:\\work')
  })
})

describe('isPathWithin', () => {
  it('treats an identical path as contained (target == parent)', () => {
    expect(isPathWithin('C:\\work', 'C:\\work', 'win32')).toBe(true)
    expect(isPathWithin('/srv/work', '/srv/work', 'linux')).toBe(true)
  })

  it('accepts a child path', () => {
    expect(isPathWithin('C:\\work', 'C:\\work\\sub\\f.txt', 'win32')).toBe(true)
    expect(isPathWithin('/srv/work', '/srv/work/sub/f.txt', 'linux')).toBe(true)
  })

  it('rejects a parent-traversal escape', () => {
    expect(isPathWithin('C:\\work', 'C:\\work\\..\\secret', 'win32')).toBe(false)
    expect(isPathWithin('/srv/work', '/srv/work/../secret', 'linux')).toBe(false)
  })

  it('rejects a sibling whose name shares the parent as a string prefix', () => {
    // The classic prefix-confusion bug: "C:\work-evil" startsWith "C:\work".
    expect(isPathWithin('C:\\work', 'C:\\work-evil\\f', 'win32')).toBe(false)
    expect(isPathWithin('/srv/work', '/srv/work-evil/f', 'linux')).toBe(false)
  })

  it('rejects an unrelated absolute path', () => {
    expect(isPathWithin('C:\\work', 'D:\\other\\f', 'win32')).toBe(false)
    expect(isPathWithin('/srv/work', '/etc/passwd', 'linux')).toBe(false)
  })

  it('contains a \\\\?\\-prefixed target inside an ordinary parent on win32', () => {
    // Windows extended-length paths must NOT bypass nor false-fail containment.
    expect(isPathWithin('C:\\work', '\\\\?\\C:\\work\\sub\\f', 'win32')).toBe(true)
    expect(isPathWithin('\\\\?\\C:\\work', 'C:\\work\\sub\\f', 'win32')).toBe(true)
  })

  it('blocks a \\\\?\\-prefixed traversal escape on win32', () => {
    expect(isPathWithin('C:\\work', '\\\\?\\C:\\work\\..\\secret', 'win32')).toBe(false)
  })

  it('matches case-insensitively on win32', () => {
    expect(isPathWithin('C:\\Work', 'c:\\work\\SUB\\f', 'win32')).toBe(true)
  })

  it('is case-sensitive on posix', () => {
    expect(isPathWithin('/srv/Work', '/srv/work/f', 'linux')).toBe(false)
  })

  it('contains a UNC child under a UNC parent on win32', () => {
    expect(isPathWithin('\\\\server\\share', '\\\\server\\share\\dir\\f', 'win32')).toBe(true)
    expect(isPathWithin('\\\\server\\share', '\\\\server\\other\\f', 'win32')).toBe(false)
  })
})
