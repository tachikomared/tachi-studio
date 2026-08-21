// apps/desktop/test/unit/waitingIndicatorTiming.test.ts
//
// LANE K — the ANTI-BLINK timing behind the transcript's "waiting" dots.
//
// THE BUG (live driver run, 178.5s): the waiting condition is a pure function
// of the transcript tail (components/waitingState.ts), so it flips on every
// micro-transition of a run — the dots went OFF for 1.4s and came back on,
// one visible blink per run. The derivation is correct; what was missing is
// hysteresis around it.
//
// Two timers, both owned by the component (waitingState.ts stays pure):
//   SHOW DELAY 250ms      — a wait shorter than a blink never renders at all.
//   HIDE HYSTERESIS 500ms — once shown, the dots survive a sub-second gap
//                           between a tool result and the next token.
// Plus a module-level EPISODE stamp, because both transcripts mount/unmount the
// component (`{waiting && <WaitingIndicator/>}`): a remount inside the window
// is a continuation — no second delay, and no second aria-live announcement.
//
// The state machine is framework-free on purpose, so every millisecond of it is
// asserted here without a DOM (the repo has no component-test harness).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  createWaitingVisibility,
  waitingEpisodeContinues,
  resetWaitingEpisode,
  WAITING_SHOW_DELAY_MS,
  WAITING_HIDE_HYSTERESIS_MS,
} from '../../src/components/WaitingIndicator'

beforeEach(() => {
  vi.useFakeTimers()
  resetWaitingEpisode()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Controller + the flips it reported, in order. */
function harness(initialVisible = false) {
  const flips: boolean[] = []
  const ctl = createWaitingVisibility(v => flips.push(v), { initialVisible })
  return { ctl, flips }
}

describe('timing constants', () => {
  it('are the agreed 250ms / 500ms', () => {
    expect(WAITING_SHOW_DELAY_MS).toBe(250)
    expect(WAITING_HIDE_HYSTERESIS_MS).toBe(500)
  })
})

describe('show delay', () => {
  it('renders nothing before the delay has elapsed', () => {
    const { ctl, flips } = harness()
    ctl.set(true)
    expect(ctl.visible()).toBe(false)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS - 1)
    expect(ctl.visible()).toBe(false)
    expect(flips).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ctl.visible()).toBe(true)
    expect(flips).toEqual([true])
  })

  it('a wait shorter than the delay never renders at all', () => {
    const { ctl, flips } = harness()
    ctl.set(true)
    vi.advanceTimersByTime(120)
    ctl.set(false)
    vi.advanceTimersByTime(5_000)
    expect(ctl.visible()).toBe(false)
    expect(flips).toEqual([])
  })

  it('does not restart the delay when the condition re-asserts itself', () => {
    const { ctl, flips } = harness()
    ctl.set(true)
    vi.advanceTimersByTime(200)
    ctl.set(true)               // a re-render, not a new wait
    vi.advanceTimersByTime(50)
    expect(flips).toEqual([true])
  })
})

describe('hide hysteresis', () => {
  const shown = () => {
    const h = harness()
    h.ctl.set(true)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    h.flips.length = 0
    return h
  }

  it('keeps rendering for the hysteresis window after the condition drops', () => {
    const { ctl, flips } = shown()
    ctl.set(false)
    vi.advanceTimersByTime(WAITING_HIDE_HYSTERESIS_MS - 1)
    expect(ctl.visible()).toBe(true)
    expect(flips).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ctl.visible()).toBe(false)
    expect(flips).toEqual([false])
  })

  it('a sub-second tool gap does not blink the dots (the reported defect)', () => {
    const { ctl, flips } = shown()
    ctl.set(false)              // tool result landed
    vi.advanceTimersByTime(300)
    ctl.set(true)               // next model text is still not here
    vi.advanceTimersByTime(5_000)
    expect(ctl.visible()).toBe(true)
    expect(flips).toEqual([])   // never flipped ⇒ nothing to see blink
  })

  it('re-arming cancels the pending hide even at the last millisecond', () => {
    const { ctl, flips } = shown()
    ctl.set(false)
    vi.advanceTimersByTime(WAITING_HIDE_HYSTERESIS_MS - 1)
    ctl.set(true)
    vi.advanceTimersByTime(WAITING_HIDE_HYSTERESIS_MS * 2)
    expect(ctl.visible()).toBe(true)
    expect(flips).toEqual([])
  })

  it('a gap longer than the window does hide — the run really went quiet', () => {
    const { ctl, flips } = shown()
    ctl.set(false)
    vi.advanceTimersByTime(1_400)   // the 1.4s gap the driver measured
    expect(flips).toEqual([false])
    ctl.set(true)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    expect(flips).toEqual([false, true])
  })
})

describe('timer cleanup', () => {
  it('dispose kills a pending show', () => {
    const { ctl, flips } = harness()
    ctl.set(true)
    ctl.dispose()
    vi.advanceTimersByTime(10_000)
    expect(flips).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose kills a pending hide and leaves no timer behind', () => {
    const { ctl } = harness()
    ctl.set(true)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    ctl.set(false)
    ctl.dispose()
    vi.advanceTimersByTime(10_000)
    expect(ctl.visible()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('episode continuity across mount/unmount', () => {
  it('a remount inside the window skips the show delay', () => {
    const first = harness()
    first.ctl.set(true)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    first.ctl.dispose()                       // transcript unmounted the dots

    vi.advanceTimersByTime(200)               // < 500ms later, waiting again
    expect(waitingEpisodeContinues()).toBe(true)
    const second = harness()
    second.ctl.set(true)
    expect(second.ctl.visible()).toBe(true)   // instant — same episode
    expect(second.flips).toEqual([true])
  })

  it('a remount after the window is a NEW episode and pays the delay again', () => {
    const first = harness()
    first.ctl.set(true)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    first.ctl.dispose()

    vi.advanceTimersByTime(WAITING_HIDE_HYSTERESIS_MS + 1)
    expect(waitingEpisodeContinues()).toBe(false)
    const second = harness()
    second.ctl.set(true)
    expect(second.ctl.visible()).toBe(false)
    vi.advanceTimersByTime(WAITING_SHOW_DELAY_MS)
    expect(second.ctl.visible()).toBe(true)
  })

  it('an unmount that never became visible does not open an episode', () => {
    const first = harness()
    first.ctl.set(true)
    vi.advanceTimersByTime(100)               // still inside the show delay
    first.ctl.dispose()
    expect(waitingEpisodeContinues()).toBe(false)
  })

  it('starts closed — the very first indicator of a session is announced', () => {
    expect(waitingEpisodeContinues()).toBe(false)
  })
})

// ── Source guards ─────────────────────────────────────────────────────────────
//
// No component-test harness in this repo (vitest runs `environment: 'node'`),
// so the JSX-side contract is pinned by reading the source.

const SRC_DIR = path.join(__dirname, '..', '..', 'src')
const indicatorSrc = fs.readFileSync(path.join(SRC_DIR, 'components', 'WaitingIndicator.tsx'), 'utf8')

describe('WaitingIndicator source guards', () => {
  it('renders nothing at all while not visible (no reserved blank row)', () => {
    expect(indicatorSrc).toMatch(/if \(!visible\) return null/)
  })

  it('disposes the controller on unmount (timers never outlive the transcript)', () => {
    expect(indicatorSrc).toMatch(/return \(\) => \{ ctl\.dispose\(\)/)
  })

  it('announces once per episode: a continuation switches aria-live off', () => {
    expect(indicatorSrc).toMatch(/aria-live=\{continues \? 'off' : 'polite'\}/)
    expect(indicatorSrc).toContain('role="status"')
  })

  it('keeps the animation on LEAF dot spans (containing-block law)', () => {
    // A filled transform keyframe on a wrapper would make it the containing
    // block for every position:fixed descendant — the portalled-menu trap.
    expect(indicatorSrc).toMatch(/className="tachi-typing-dot"/)
  })
})

describe('waitingState stays pure', () => {
  it('holds no timers — the hysteresis lives in the component', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'components', 'waitingState.ts'), 'utf8')
    expect(src).not.toMatch(/setTimeout|setInterval|Date\.now|useState/)
  })
})

describe('SettingsPage custom-theme card label', () => {
  it('gives the label room next to the STRUCTURE badge instead of truncating it', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'pages', 'settings', 'SettingsPage.tsx'), 'utf8')
    // Two-line clamp + full name on hover + a badge group that cannot steal
    // the label's width.
    expect(src).toMatch(/WebkitLineClamp: 2/)
    expect(src).toMatch(/title=\{ct\.label\}/)
    expect(src).toMatch(/flex: '1 1 auto', minWidth: 0/)
    expect(src).toMatch(/alignItems: 'center', flexShrink: 0 \}\}>/)
  })
})
