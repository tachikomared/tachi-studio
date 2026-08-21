// apps/desktop/src/components/WaitingIndicator.tsx
//
// The animated "the model is thinking" tail marker, shared by the CODE-tab and
// CHAT-tab transcripts. Three brutalist squares breathing in sequence next to a
// mono label — the app's terminal vibe, not a rounded chat bubble.
//
// CONTAINING-BLOCK LAW: the animation lives on the dot spans, which are LEAF
// elements with no children. A filled (`both`/`forwards`) transform keyframe on
// a wrapper leaves a permanent computed transform, which per spec makes that
// wrapper the containing block for every position:fixed descendant — the trap
// that once shoved the app's portalled menus off-screen. Leaves cannot hold a
// fixed descendant, so this indicator can never reintroduce it.
//
// ── ANTI-BLINK (driver run, batch22-23) ──────────────────────────────────────
// The waiting condition (components/waitingState.ts) is a pure function of the
// transcript tail, so it flips on every micro-transition of a run: a 178.5s run
// showed one visible BLINK — the dots dropped for 1.4s and came back. Two
// timers, both owned here so waitingState.ts stays pure and framework-free:
//
//   SHOW DELAY (250ms)      — a wait shorter than a blink never renders at all.
//   HIDE HYSTERESIS (500ms) — once shown, the dots keep rendering after the
//                             condition drops, so a sub-second gap between a
//                             tool result and the next token does not blink
//                             them off and on. Re-arming cancels the hide.
//
// Both timers are cleared on unmount. The a11y contract is "one announcement
// per continuous waiting EPISODE": the transcripts mount/unmount this component
// (`{waiting && <WaitingIndicator/>}`), so a module-level episode stamp lets a
// remount inside the hysteresis window skip both the show delay and the
// aria-live announcement — a continuation, not a new event.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Grace before an appearing indicator is rendered (ms). */
export const WAITING_SHOW_DELAY_MS = 250
/** Grace an already-visible indicator keeps rendering after `waiting` drops (ms). */
export const WAITING_HIDE_HYSTERESIS_MS = 500

// ── Episode stamp (module-level, survives mount/unmount) ──────────────────────

/** Timestamp (ms) at which the dots last stopped being rendered. */
let lastHiddenAt = 0

/**
 * True when the dots were on screen less than `windowMs` ago — the same waiting
 * EPISODE, seen through an unmount/remount. Callers use it to skip the show
 * delay (the dots were already there) and to suppress a duplicate aria-live
 * announcement.
 */
export function waitingEpisodeContinues(
  now: number = Date.now(),
  windowMs: number = WAITING_HIDE_HYSTERESIS_MS,
): boolean {
  return lastHiddenAt > 0 && now - lastHiddenAt <= windowMs
}

/** Test seam — clears the module-level episode stamp between cases. */
export function resetWaitingEpisode(): void {
  lastHiddenAt = 0
}

// ── The timing state machine (framework-free, unit-tested with fake timers) ───

export interface WaitingVisibilityOptions {
  /** Start already visible (a remount that continues an episode). */
  initialVisible?:   boolean
  showDelayMs?:      number
  hideHysteresisMs?: number
  /** Clock seam; defaults to Date.now (mocked by vi.useFakeTimers). */
  now?:              () => number
}

export interface WaitingVisibility {
  /** Feed the raw waiting condition; `onChange` fires only on real flips. */
  set(waiting: boolean): void
  /** Current rendered state. */
  visible(): boolean
  /** Clear both timers; stamps the episode if it was still visible. */
  dispose(): void
}

/**
 * Debounce-on-show / hold-on-hide around a boolean. Deliberately not a hook so
 * the exact millisecond behaviour can be asserted in a node-environment test.
 */
export function createWaitingVisibility(
  onChange: (visible: boolean) => void,
  options: WaitingVisibilityOptions = {},
): WaitingVisibility {
  const showDelayMs      = options.showDelayMs      ?? WAITING_SHOW_DELAY_MS
  const hideHysteresisMs = options.hideHysteresisMs ?? WAITING_HIDE_HYSTERESIS_MS
  const now              = options.now              ?? (() => Date.now())

  let visible = options.initialVisible ?? false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** What the pending timer would do — so a repeat `set` of the SAME condition
   *  (a plain re-render) never restarts the clock and starves the flip. */
  let pending: 'show' | 'hide' | null = null

  const clearTimer = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    pending = null
  }
  const apply = (next: boolean) => {
    if (visible === next) return
    visible = next
    if (!next) lastHiddenAt = now()
    onChange(next)
  }

  return {
    set(waiting: boolean) {
      if (waiting) {
        if (pending === 'show') return   // already counting down; do not restart
        // A pending hide is cancelled outright — that is the whole point of the
        // hysteresis: the dots never left, so nothing flips.
        clearTimer()
        if (visible) return
        if (waitingEpisodeContinues(now(), hideHysteresisMs)) { apply(true); return }
        pending = 'show'
        timer = setTimeout(() => { timer = null; pending = null; apply(true) }, showDelayMs)
      } else {
        if (pending === 'hide') return   // already counting down; do not extend
        // Not visible yet ⇒ a pending show is simply dropped: a wait shorter
        // than the delay never renders, so there is nothing to blink.
        clearTimer()
        if (!visible) return
        pending = 'hide'
        timer = setTimeout(() => { timer = null; pending = null; apply(false) }, hideHysteresisMs)
      }
    },
    visible: () => visible,
    dispose() {
      clearTimer()
      if (visible) { visible = false; lastHiddenAt = now() }
    },
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface WaitingIndicatorProps {
  /** Localized text next to the dots, e.g. "Waiting for response…". */
  label: string
  /** Optional hover title. */
  title?: string
  /**
   * The raw waiting condition. Callers that already gate with
   * `{waiting && <WaitingIndicator/>}` leave it at the default (mounted ⇒
   * waiting); passing it explicitly keeps the component mounted across the
   * hysteresis window, which is what makes the HIDE half of the anti-blink
   * visible rather than just the SHOW half.
   */
  waiting?: boolean
}

const DOT_DELAYS = ['0ms', '160ms', '320ms']

const DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  background: 'var(--accent)',
}

export function WaitingIndicator({ label, title, waiting = true }: WaitingIndicatorProps) {
  // A remount inside the hysteresis window is the SAME episode: paint the dots
  // immediately (no second delay) and stay silent for screen readers.
  const [continues] = useState(() => waiting && waitingEpisodeContinues())
  const [visible, setVisible] = useState(continues)
  const ctlRef = useRef<WaitingVisibility | null>(null)

  // Layout effect: the controller may flip `visible` synchronously (episode
  // continuation), and doing that before paint avoids a one-frame blank.
  useLayoutEffect(() => {
    const ctl = createWaitingVisibility(setVisible, { initialVisible: continues })
    ctlRef.current = ctl
    return () => { ctl.dispose(); ctlRef.current = null }
    // `continues` is frozen at mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { ctlRef.current?.set(waiting) }, [waiting])

  if (!visible) return null

  return (
    <div
      role="status"
      // Announce once per continuous episode: a remount that merely continues
      // the previous one must not re-read the label out loud.
      aria-live={continues ? 'off' : 'polite'}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 2px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 4 }} aria-hidden="true">
        {DOT_DELAYS.map(delay => (
          <span
            key={delay}
            className="tachi-typing-dot"
            style={{ ...DOT_STYLE, animationDelay: delay }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  )
}
