// test/unit/diskPreflight.test.ts — download hardening helpers in
// installer-kit: disk-space preflight math/messages and the live statfs probe.
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import {
  requiredDiskBytes,
  formatGb,
  diskShortfallMessage,
  freeDiskBytes,
  DISK_MARGIN_BYTES,
  isTransientNetworkError,
} from '../../electron/services/util/installer-kit'

const GB = 1024 ** 3

describe('requiredDiskBytes', () => {
  it('adds the OS margin to the remaining bytes', () => {
    expect(requiredDiskBytes(10 * GB, 0)).toBe(10 * GB + DISK_MARGIN_BYTES)
  })
  it('accounts for already-downloaded bytes on resume', () => {
    expect(requiredDiskBytes(10 * GB, 4 * GB)).toBe(6 * GB + DISK_MARGIN_BYTES)
  })
  it('never goes below the margin (resume past EOF)', () => {
    expect(requiredDiskBytes(1 * GB, 2 * GB)).toBe(DISK_MARGIN_BYTES)
  })
})

describe('diskShortfallMessage', () => {
  it('is actionable: names both sizes, the directory, and the resume path', () => {
    const msg = diskShortfallMessage(2.5 * GB, 41 * GB, 'D:/models')
    expect(msg).toContain('41.0 GB')
    expect(msg).toContain('2.5 GB')
    expect(msg).toContain('D:/models')
    expect(msg.toLowerCase()).toContain('resume')
  })
})

describe('formatGb', () => {
  it('renders one decimal', () => {
    expect(formatGb(1.55 * GB)).toBe('1.6 GB')
    expect(formatGb(0)).toBe('0.0 GB')
  })
})

describe('freeDiskBytes', () => {
  it('reports a positive number for a real directory', async () => {
    const free = await freeDiskBytes(tmpdir())
    expect(free).not.toBeNull()
    expect(free!).toBeGreaterThan(0)
  })
  it('resolves null (not a rejection) for a bogus path', async () => {
    await expect(freeDiskBytes('Z:/definitely/not/a/real/dir/xyz')).resolves.toBeNull()
  })
})

describe('failure classification', () => {
  it('DISK_FULL is NOT transient — the retry loop must not burn attempts on a full disk', () => {
    expect(isTransientNetworkError(Object.assign(new Error('disk'), { code: 'DISK_FULL' }))).toBe(false)
  })
  it('short-body truncation IS transient — resumableDownload resumes from bytes on disk', () => {
    expect(isTransientNetworkError(Object.assign(
      new Error('short body: got 100 of 200 bytes — resuming'),
      { code: 'ERR_STREAM_PREMATURE_CLOSE' },
    ))).toBe(true)
  })
})
