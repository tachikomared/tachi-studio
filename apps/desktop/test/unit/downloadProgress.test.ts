// apps/desktop/test/unit/downloadProgress.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DownloadProgressTracker, trackerFromSdFiles } from '../../electron/services/util/download-progress'

afterEach(() => { vi.useRealTimers() })

describe('DownloadProgressTracker', () => {
  it('aggregates received/total across files and computes percent', () => {
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 100 }, { id: 'b', totalBytes: 100 }])
    expect(t.snapshot()).toMatchObject({ receivedBytes: 0, totalBytes: 200, percent: 0 })
    t.tick('a', 50, 100)
    expect(t.snapshot()).toMatchObject({ receivedBytes: 50, totalBytes: 200, percent: 25 })
    t.tick('b', 100, 100)
    t.tick('a', 100, 100)
    expect(t.snapshot()).toMatchObject({ receivedBytes: 200, totalBytes: 200, percent: 100 })
  })

  it('reports percent -1 while ANY file total is unknown, then resolves it', () => {
    const t = new DownloadProgressTracker([{ id: 'a' }, { id: 'b', totalBytes: 100 }])
    // 'a' has no known total -> combined total unknown -> percent -1
    expect(t.snapshot().percent).toBe(-1)
    expect(t.snapshot().totalBytes).toBe(0)
    // a late Content-Length fills it in
    t.tick('a', 10, 50)
    const snap = t.snapshot()
    expect(snap.totalBytes).toBe(150)
    expect(snap.receivedBytes).toBe(10)
    expect(snap.percent).toBe(6) // floor(10/150*100)
  })

  it('only raises a stored total, never lowers it', () => {
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 100 }])
    t.tick('a', 10, 50)            // 50 < 100 -> keep 100
    expect(t.snapshot().totalBytes).toBe(100)
    t.tick('a', 10, 120)           // 120 > 100 -> raise to 120
    expect(t.snapshot().totalBytes).toBe(120)
  })

  it('ignores ticks for unknown ids (post-discard race safety)', () => {
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 100 }])
    t.tick('ghost', 999, 999)
    expect(t.snapshot().receivedBytes).toBe(0)
  })

  it('reset() zeroes a file; upsert() adds/raises totals', () => {
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 100 }])
    t.tick('a', 80, 100)
    t.reset('a')
    expect(t.snapshot().receivedBytes).toBe(0)
    t.upsert({ id: 'b', totalBytes: 200 })
    expect(t.fileCount).toBe(2)
    expect(t.snapshot().totalBytes).toBe(300)
  })

  it('computes speed and ETA from the rolling window (fake timers)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 1000 }])
    t.tick('a', 0, 1000)        // sample @ t=0, cumulative 0
    vi.setSystemTime(1000)
    t.tick('a', 500, 1000)      // sample @ t=1000, cumulative 500 -> 500 B/s
    const snap = t.snapshot()
    expect(snap.speedBytesPerSec).toBe(500)
    expect(snap.etaSec).toBe(1) // remaining 500 / 500 B/s
  })

  it('speed is 0 with fewer than two samples', () => {
    const t = new DownloadProgressTracker([{ id: 'a', totalBytes: 100 }])
    t.tick('a', 10, 100)
    expect(t.snapshot().speedBytesPerSec).toBe(0)
  })
})

describe('trackerFromSdFiles', () => {
  it('seeds per-component totals from sizeMb (MiB)', () => {
    const t = trackerFromSdFiles([{ role: 'diffusion', sizeMb: 1 }, { role: 'vae', sizeMb: 2 }])
    expect(t.fileCount).toBe(2)
    expect(t.snapshot().totalBytes).toBe(Math.round(1 * 1048576) + Math.round(2 * 1048576))
  })
})
