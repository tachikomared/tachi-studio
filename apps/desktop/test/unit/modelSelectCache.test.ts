// apps/desktop/test/unit/modelSelectCache.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  cachedFetch, invalidateCache, invalidateCachePrefix, cacheAge,
} from '../../src/pages/catalog/modelSelectCache'

// Flush microtasks + the fire-and-forget background refetch (real timers here).
const flush = () => new Promise(r => setTimeout(r, 0))

describe('cachedFetch', () => {
  it('cold miss awaits the fetcher; a fresh hit reuses it', async () => {
    const f = vi.fn(async () => 'v1')
    expect(await cachedFetch('cm', f)).toBe('v1')
    expect(await cachedFetch('cm', f)).toBe('v1')
    expect(f).toHaveBeenCalledTimes(1) // 2nd call served from cache
  })

  it('propagates a cold-miss error and does not cache it', async () => {
    const bad = vi.fn(async () => { throw new Error('net') })
    await expect(cachedFetch('err', bad)).rejects.toThrow('net')
    const ok = vi.fn(async () => 'ok')
    expect(await cachedFetch('err', ok)).toBe('ok') // still a cold miss -> runs
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('returns the stale value immediately on expiry, then updates in the background', async () => {
    await cachedFetch('stale', async () => 'old')
    const fresh = vi.fn(async () => 'new')
    // ttlMs:-1 forces the expired branch deterministically (no time travel).
    expect(await cachedFetch('stale', fresh, { ttlMs: -1 })).toBe('old')
    await flush()
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(await cachedFetch('stale', async () => 'unused')).toBe('new')
  })

  it('keeps the stale value when the background refetch fails, and retries next time', async () => {
    await cachedFetch('sf', async () => 'keep')
    const failing = vi.fn(async () => { throw new Error('boom') })
    expect(await cachedFetch('sf', failing, { ttlMs: -1 })).toBe('keep')
    await flush()
    // refreshing flag was cleared on failure -> a later expired call retries
    const recover = vi.fn(async () => 'recovered')
    expect(await cachedFetch('sf', recover, { ttlMs: -1 })).toBe('keep') // still stale this call
    await flush()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(await cachedFetch('sf', async () => 'unused')).toBe('recovered')
  })
})

describe('invalidate + cacheAge', () => {
  it('invalidateCache forces the next call to be a cold miss', async () => {
    const f = vi.fn(async () => 'x')
    await cachedFetch('inv', f)
    invalidateCache('inv')
    await cachedFetch('inv', f)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('invalidateCachePrefix clears every matching key', async () => {
    await cachedFetch('hf:a', async () => 1)
    await cachedFetch('hf:b', async () => 2)
    invalidateCachePrefix('hf:')
    expect(cacheAge('hf:a')).toBeNull()
    expect(cacheAge('hf:b')).toBeNull()
  })

  it('cacheAge is null when absent and a small number right after a store', async () => {
    expect(cacheAge('age-none')).toBeNull()
    await cachedFetch('age-x', async () => 1)
    const a = cacheAge('age-x')
    expect(a).not.toBeNull()
    expect(a!).toBeGreaterThanOrEqual(0)
    expect(a!).toBeLessThan(2000)
  })
})
