// apps/desktop/src/hooks/usePtySession.ts
//
// Renderer-side convenience for hooking a React component into the
// per-task PTY surface exposed by parallel-agents.ipc.ts. Encapsulates:
//
//   - lazy spawn (the first mount triggers `window.tachi.parallel.pty.spawn`)
//   - subscription bookkeeping (one subscribe per hook instance; cleanup
//     on unmount tears down the IPC listener)
//   - a throttled resize wrapper so React effects firing on every render
//     don't hammer the main-process IPC
//
// The hook does NOT manage xterm.js — the consumer (PtyTerminalView) wires
// the data callback through to whichever rendering strategy it picked.
// We also expose a `write` and `resize` passthrough for the consumer to
// forward keystrokes and viewport changes.

import { useEffect, useRef, useCallback } from 'react'
import type { ParallelPtyExitInfo } from '../types/electron'

interface UsePtySessionOpts {
  /** Task id whose worktree shell we want to attach to. */
  taskId: string
  /** Whether the consumer is actively rendering — when false, the hook is dormant. */
  active: boolean
  /** Initial cols/rows for the spawn handshake. Renderer can later call `resize`. */
  initialCols?: number
  initialRows?: number
  /**
   * Called for every base64-encoded frame from the PTY. The hook DOES NOT
   * decode for you — node-pty's output may contain ANSI escapes / cursor
   * positioning that the consumer needs to handle deliberately (e.g.
   * feed to xterm). Use atob() or Buffer.from(b64, 'base64') depending
   * on environment.
   */
  onData: (base64Data: string) => void
  /** Optional final-frame callback. Fires when the underlying shell exits. */
  onExit?: (info: ParallelPtyExitInfo) => void
}

/** What the hook returns — passthrough helpers for the consumer. */
interface PtySessionHandle {
  write:  (data: string) => void
  resize: (cols: number, rows: number) => void
  kill:   () => void
}

// Resize throttle: 50ms matches the main-process pty-service internal
// throttle. We add this on the renderer too so a fast ResizeObserver
// burst doesn't queue dozens of IPC roundtrips.
const RESIZE_THROTTLE_MS = 50

export function usePtySession(opts: UsePtySessionOpts): PtySessionHandle {
  // Latest callbacks pinned in refs so the subscribe effect doesn't have
  // to re-run every time the parent re-renders (and we don't have to ask
  // consumers to memoize their callbacks just to keep the PTY stable).
  const onDataRef = useRef(opts.onData)
  const onExitRef = useRef(opts.onExit)
  onDataRef.current = opts.onData
  onExitRef.current = opts.onExit

  // Stash the unsubscribe fn returned by the preload bridge so the
  // unmount path can call it. We use a ref (not state) because changing
  // it shouldn't trigger a re-render.
  const unsubRef = useRef<(() => void) | null>(null)

  // Resize throttle state. The pending* values are queued by `resize`
  // and applied on the timer tick.
  const resizeTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResizeRef  = useRef<{ cols: number; rows: number } | null>(null)

  useEffect(() => {
    if (!opts.active) return
    let cancelled = false

    // Fire-and-forget the spawn — the manager treats it as idempotent so
    // a second hook instance for the same task will just attach to the
    // already-running shell.
    void window.tachi.parallel.pty.spawn(opts.taskId, opts.initialCols, opts.initialRows)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          // The spawn failed (probably unknown taskId — task was deleted
          // mid-mount). Don't subscribe; the UI will just show "no output".
          console.warn(`[usePtySession] spawn failed for task ${opts.taskId}:`, result.error)
        }
      })
      .catch((err: unknown) => {
        console.warn(`[usePtySession] spawn threw for task ${opts.taskId}:`, err)
      })

    // Attach the subscription. We do this independently of the spawn
    // promise above — if the PTY already existed (toggling back), the
    // spawn is a no-op anyway and we want output as soon as possible.
    void window.tachi.parallel.pty.subscribe(
      opts.taskId,
      (data) => onDataRef.current(data),
      (info) => onExitRef.current?.(info),
    ).then((unsub) => {
      if (cancelled) {
        // Hook unmounted before the subscribe handshake finished —
        // immediately tear down to avoid a leak.
        try { unsub() } catch { /* ignore */ }
        return
      }
      unsubRef.current = unsub
    })

    return () => {
      cancelled = true
      if (unsubRef.current) {
        try { unsubRef.current() } catch { /* ignore */ }
        unsubRef.current = null
      }
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      pendingResizeRef.current = null
      // We deliberately DO NOT call pty.kill() on unmount — the PTY is
      // shared with EVENTS↔PTY toggles and other subscribers. The
      // manager kills it on task deletion.
    }
    // Only re-run when the *binding* changes (taskId or active flag);
    // initial cols/rows are captured on first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.taskId, opts.active])

  const write = useCallback((data: string) => {
    // Fire-and-forget — the renderer doesn't care about the ack on each
    // keystroke. If the PTY is dead the manager returns ok:false and we
    // silently drop the input.
    void window.tachi.parallel.pty.write(opts.taskId, data)
  }, [opts.taskId])

  const resize = useCallback((cols: number, rows: number) => {
    pendingResizeRef.current = { cols, rows }
    if (resizeTimerRef.current) return
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null
      const next = pendingResizeRef.current
      pendingResizeRef.current = null
      if (next) {
        void window.tachi.parallel.pty.resize(opts.taskId, next.cols, next.rows)
      }
    }, RESIZE_THROTTLE_MS)
  }, [opts.taskId])

  const kill = useCallback(() => {
    void window.tachi.parallel.pty.kill(opts.taskId)
  }, [opts.taskId])

  return { write, resize, kill }
}
