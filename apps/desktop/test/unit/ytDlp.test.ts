// apps/desktop/test/unit/ytDlp.test.ts
//
// Pure cores for media URL-import (STEAL 2026-06-21 #8, reclip/yt-dlp): a
// progress-line parser (mirrors sd-progress-parser) and a best-per-resolution
// format picker. These have no electron/network/binary deps, so they're the
// TDD'd foundation under the yt-dlp sidecar + service.

import { describe, it, expect } from 'vitest'
import { parseYtDlpLine, YtDlpProgressParser } from '../../electron/services/util/yt-dlp-progress'
import { pickBestFormats, type YtDlpFormat } from '../../electron/services/util/media-format'

describe('parseYtDlpLine', () => {
  it('parses a mid-download progress line (percent + total + speed + eta)', () => {
    const p = parseYtDlpLine('[download]  42.3% of  123.45MiB at  1.23MiB/s ETA 00:42')
    expect(p).not.toBeNull()
    expect(p!.percent).toBe(42)
    expect(p!.total).toBe('123.45MiB')
    expect(p!.speed).toBe('1.23MiB/s')
    expect(p!.eta).toBe('00:42')
  })

  it('parses a completed line (100% ... in <dur>) with no speed/eta', () => {
    const p = parseYtDlpLine('[download] 100% of 10.00MiB in 00:03')
    expect(p!.percent).toBe(100)
    expect(p!.total).toBe('10.00MiB')
    expect(p!.speed).toBeUndefined()
    expect(p!.eta).toBeUndefined()
  })

  it('handles the early "Unknown" speed/eta gracefully', () => {
    const p = parseYtDlpLine('[download]   0.0% of ~123.45MiB at  Unknown B/s ETA Unknown')
    expect(p!.percent).toBe(0)
    expect(p!.total).toBe('123.45MiB')      // ~ approximate marker stripped
    expect(p!.speed).toBeUndefined()
    expect(p!.eta).toBeUndefined()
  })

  it('captures the destination path', () => {
    const p = parseYtDlpLine('[download] Destination: C:\\videos\\clip.mp4')
    expect(p!.destination).toBe('C:\\videos\\clip.mp4')
  })

  it('strips ANSI and returns null for non-progress lines', () => {
    expect(parseYtDlpLine('\x1b[0;94m[info] some log\x1b[0m')).toBeNull()
    expect(parseYtDlpLine('')).toBeNull()
  })
})

describe('YtDlpProgressParser.feed', () => {
  it('returns the latest progress across a multi-line chunk and remembers the destination', () => {
    const parser = new YtDlpProgressParser()
    parser.feed('[download] Destination: out.mp4\n[download]  10.0% of 5MiB at 1MiB/s ETA 00:05\n')
    const p = parser.feed('[download]  90.0% of 5MiB at 1MiB/s ETA 00:01\n')
    expect(p).not.toBeNull()
    expect(p!.percent).toBe(90)
    expect(parser.destination).toBe('out.mp4')
  })

  it('buffers a partial line until its newline arrives', () => {
    const parser = new YtDlpProgressParser()
    expect(parser.feed('[download]  50.0% of ')).toBeNull()           // incomplete line
    const p = parser.feed('5MiB at 1MiB/s ETA 00:03\n')
    expect(p!.percent).toBe(50)
  })
})

describe('pickBestFormats', () => {
  const f = (over: Partial<YtDlpFormat>): YtDlpFormat => ({ format_id: 'x', vcodec: 'avc1', acodec: 'none', height: 720, ext: 'mp4', tbr: 1000, ...over })

  it('keeps the highest-bitrate format per resolution, sorted high→low', () => {
    const out = pickBestFormats([
      f({ format_id: '720-lo', height: 720, tbr: 800 }),
      f({ format_id: '720-hi', height: 720, tbr: 1500 }),
      f({ format_id: '1080', height: 1080, tbr: 3000 }),
      f({ format_id: '360', height: 360, tbr: 400 }),
    ])
    expect(out.map(o => o.height)).toEqual([1080, 720, 360])
    expect(out.find(o => o.height === 720)!.id).toBe('720-hi')
  })

  it('drops audio-only and height-less formats', () => {
    const out = pickBestFormats([
      f({ format_id: 'audio', vcodec: 'none', height: null }),
      f({ format_id: 'novh', height: 0 }),
      f({ format_id: 'vid', height: 480 }),
    ])
    expect(out.map(o => o.id)).toEqual(['vid'])
  })

  it('builds a human label with resolution and ext', () => {
    const out = pickBestFormats([f({ format_id: 'v', height: 1080, ext: 'webm' })])
    expect(out[0]!.label).toContain('1080p')
    expect(out[0]!.label).toContain('webm')
  })

  it('returns [] for no usable formats', () => {
    expect(pickBestFormats([])).toEqual([])
    expect(pickBestFormats([f({ vcodec: 'none', height: null })])).toEqual([])
  })
})
