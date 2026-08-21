import { describe, it, expect } from 'vitest'
import { FusionBreakerRegistry } from '../../electron/services/util/fusion-breaker'

// Injectable clock so every transition is deterministic — no real timers.
function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('FusionBreakerRegistry (desktop Fusion breaker wiring)', () => {
  it('does not skip a healthy / unknown model id', () => {
    const reg = new FusionBreakerRegistry(makeClock().now)
    expect(reg.shouldSkip('m-a')).toBe(false)
    reg.record('m-a', true)
    expect(reg.shouldSkip('m-a')).toBe(false)
  })

  it('skips a model id after repeated failures, then recovers (half-open) once the backoff elapses', () => {
    const clk = makeClock()
    const reg = new FusionBreakerRegistry(clk.now)
    // default failureThreshold is 2 → two failures trip it open
    reg.record('m-bad', false)
    expect(reg.shouldSkip('m-bad')).toBe(false) // still closed after 1 failure
    reg.record('m-bad', false)
    // now open → skipped on the next Fusion call
    expect(reg.shouldSkip('m-bad')).toBe(true)
    // still skipped before the backoff window elapses
    clk.advance(1000)
    expect(reg.shouldSkip('m-bad')).toBe(true)
    // after the backoff window, one probe is granted (half-open) → NOT skipped
    clk.advance(60_000)
    expect(reg.shouldSkip('m-bad')).toBe(false)
    // a successful probe closes it → stays attemptable
    reg.record('m-bad', true)
    expect(reg.shouldSkip('m-bad')).toBe(false)
  })

  it('a failed half-open probe re-opens the breaker (keeps skipping)', () => {
    const clk = makeClock()
    const reg = new FusionBreakerRegistry(clk.now)
    reg.record('m-bad', false)
    reg.record('m-bad', false)
    expect(reg.shouldSkip('m-bad')).toBe(true)
    clk.advance(60_000)
    expect(reg.shouldSkip('m-bad')).toBe(false) // half-open probe granted
    reg.record('m-bad', false)                  // probe failed → re-open
    expect(reg.shouldSkip('m-bad')).toBe(true)
  })

  it('keys breakers independently per model id', () => {
    const reg = new FusionBreakerRegistry(makeClock().now)
    reg.record('m-bad', false)
    reg.record('m-bad', false)
    expect(reg.shouldSkip('m-bad')).toBe(true)
    expect(reg.shouldSkip('m-good')).toBe(false) // unaffected
  })

  it('mirrors how runFusion drives it: skipMember reads shouldSkip, onMemberResult feeds record', () => {
    const clk = makeClock()
    const reg = new FusionBreakerRegistry(clk.now)
    const panel = ['m-a', 'm-b']
    // first call: nothing skipped, m-b errors
    expect(panel.filter(id => !reg.shouldSkip(id))).toEqual(['m-a', 'm-b'])
    reg.record('m-a', true)
    reg.record('m-b', false)
    // second call: still all attemptable (1 failure < threshold), m-b errors again
    expect(panel.filter(id => !reg.shouldSkip(id))).toEqual(['m-a', 'm-b'])
    reg.record('m-a', true)
    reg.record('m-b', false)
    // third call: m-b now tripped open → filtered out of the active panel
    expect(panel.filter(id => !reg.shouldSkip(id))).toEqual(['m-a'])
  })
})
