// apps/desktop/test/unit/sdProgressParser.test.ts
import { describe, it, expect } from 'vitest'
import { SdProgressParser } from '../../electron/services/util/sd-progress-parser'

describe('SdProgressParser.feed', () => {
  it('parses "step N / TOTAL" into step/total/percent', () => {
    const p = new SdProgressParser().feed('step 3 / 20\n')
    expect(p).toMatchObject({ step: 3, total: 20, percent: 15, heartbeat: false })
  })

  it('parses a labelled progress bar line', () => {
    const p = new SdProgressParser().feed('generating image: [===>   ]  3/20\n')
    expect(p).toMatchObject({ step: 3, total: 20, percent: 15 })
  })

  it('strips ANSI escape codes before parsing', () => {
    const p = new SdProgressParser().feed('\x1b[32mstep 5 / 10\x1b[0m\n')
    expect(p).toMatchObject({ step: 5, total: 10, percent: 50 })
  })

  it('parses a bare percentage line', () => {
    const p = new SdProgressParser().feed('  75%\n')
    expect(p?.percent).toBe(75)
  })

  it('dedupes identical in-place rewrite lines (returns null on repeat)', () => {
    const parser = new SdProgressParser()
    expect(parser.feed('step 1 / 4\n')).not.toBeNull()
    expect(parser.feed('step 1 / 4\n')).toBeNull()
  })

  it('buffers a partial line until the newline arrives', () => {
    const parser = new SdProgressParser()
    expect(parser.feed('step 2 /')).toBeNull()      // incomplete
    const p = parser.feed(' 8\nnoise\n')
    expect(p).toMatchObject({ step: 2, total: 8, percent: 25 })
  })

  it('emits a Starting... heartbeat before any real step', () => {
    const parser = new SdProgressParser(60_000) // wide window so the test is time-independent
    const p = parser.feed('loading model weights\n')  // progress-ish, no step numbers
    expect(p).toMatchObject({ heartbeat: true, step: null, percent: -1, message: 'Starting...' })
  })
})

describe('SdProgressParser.finish', () => {
  it('reports 100% when the final step equals the total', () => {
    const parser = new SdProgressParser()
    parser.feed('step 10 / 10\n')
    const f = parser.finish()
    expect(f).toMatchObject({ step: 10, total: 10, percent: 100, heartbeat: false })
  })
})
