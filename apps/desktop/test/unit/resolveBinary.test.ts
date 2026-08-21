// apps/desktop/test/unit/resolveBinary.test.ts
//
// Binary-resolver cascade (env-var override -> bundled paths -> PATH). fs,
// electron and child_process are mocked so the resolution PRIORITY is tested
// deterministically without touching the real filesystem or PATH.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('child_process', () => ({ execFileSync: vi.fn(() => { throw new Error('not on PATH') }) }))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  accessSync: vi.fn(),                 // no throw => executable
  constants: { X_OK: 1, R_OK: 4 },
}))

import { resolveBinary } from '../../electron/services/util/resolve-binary'
import { existsSync, accessSync } from 'fs'

afterEach(() => {
  delete process.env.TEST_BIN_PATH
  vi.mocked(existsSync).mockReset()
  vi.mocked(accessSync).mockReset()
})

describe('resolveBinary', () => {
  it('returns the env-var override when it exists and is executable (highest priority)', () => {
    process.env.TEST_BIN_PATH = '/override/sd-cli'
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(accessSync).mockReturnValue(undefined as never)
    expect(resolveBinary('sd-cli', { envVar: 'TEST_BIN_PATH', bundledCandidates: [] }))
      .toBe('/override/sd-cli')
  })

  it('ignores the env override when the path does not exist', () => {
    process.env.TEST_BIN_PATH = '/override/missing'
    vi.mocked(existsSync).mockReturnValue(false)
    expect(resolveBinary('sd-cli', { envVar: 'TEST_BIN_PATH', bundledCandidates: [] }))
      .toBeNull()
  })

  it('returns null when nothing resolves (no env, no bundled file, not on PATH)', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(resolveBinary('nope', { bundledCandidates: ['bin/nope'] })).toBeNull()
  })

  it('falls back to a bundled candidate that exists', () => {
    // env unset; a bundled path exists+executable -> returned before PATH lookup.
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(accessSync).mockReturnValue(undefined as never)
    const got = resolveBinary('piper', { bundledCandidates: ['bin/piper'] })
    expect(got).toBeTruthy()
    expect(got).toContain('piper')
  })

  // Regression: piper/sd-cpp/yt-dlp/whisper pass ABSOLUTE candidates (their
  // installs live under userData). join(root, absolute) mangles the path on
  // Windows, so every user-installed sidecar binary was silently invisible
  // (piper TTS, local image/video, yt-dlp import, whisper STT dead at runtime).
  it('checks an ABSOLUTE candidate as-is instead of joining it under bundled roots', () => {
    const abs = process.platform === 'win32' ? 'C:\\ud\\piper\\bin\\piper' : '/ud/piper/bin/piper'
    const absExt = process.platform === 'win32' ? `${abs}.exe` : abs
    vi.mocked(existsSync).mockImplementation(p => p === absExt)
    vi.mocked(accessSync).mockReturnValue(undefined as never)
    expect(resolveBinary('piper', { bundledCandidates: [abs] })).toBe(absExt)
    // and it must NOT have probed any mangled root-joined variant
    for (const call of vi.mocked(existsSync).mock.calls) {
      expect(String(call[0])).not.toMatch(/[\\/](app|resources)[\\/].*(C:\\|[\\/]ud[\\/])/)
    }
  })
})
