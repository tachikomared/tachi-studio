// apps/desktop/test/unit/installLock.test.ts
//
// Single-instance install guard. fs + electron are mocked so no lockfile is
// ever written (existsSync -> false means "no foreign lock"); the test exercises
// the in-process Promise-dedup layer, which is the primary guard.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tachi-test' } }))
vi.mock('fs', () => ({
  existsSync: () => false,
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { withInstallLock } from '../../electron/services/util/install-lock'

describe('withInstallLock', () => {
  it('dedupes concurrent same-name calls: fn runs once, same promise returned', async () => {
    let release!: () => void
    const fn = vi.fn(() => new Promise<void>(r => { release = r }))
    const p1 = withInstallLock('k1', fn)
    const p2 = withInstallLock('k1', fn)
    expect(p2).toBe(p1)               // 2nd call reuses the in-flight promise
    expect(fn).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([p1, p2])
  })

  it('runs different names independently', async () => {
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {})
    await Promise.all([withInstallLock('na', a), withInstallLock('nb', b)])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh run after the previous one settled', async () => {
    const fn = vi.fn(async () => {})
    await withInstallLock('k2', fn)
    await withInstallLock('k2', fn)   // in-flight cleared on settle -> runs again
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('releases the guard even when fn rejects', async () => {
    const failing = vi.fn(async () => { throw new Error('install failed') })
    await expect(withInstallLock('k3', failing)).rejects.toThrow('install failed')
    const after = vi.fn(async () => {})
    await withInstallLock('k3', after)  // guard released -> still runnable
    expect(after).toHaveBeenCalledTimes(1)
  })
})
