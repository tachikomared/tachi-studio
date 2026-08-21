// apps/desktop/src/pages/agent/PtyTerminalView.tsx
//
// xterm.js-backed terminal pane for a parallel task. Mounts the PTY via
// `usePtySession`, hands frames to a fresh xterm instance, and wires
// keystrokes + resize back to main. Brutalist styling: no border-radius,
// 2px borders, monospace.
//
// xterm.js is already a workspace dep (apps/desktop/package.json:
// "@xterm/xterm": "^5.5.0", "@xterm/addon-fit": "^0.10.0") — see
// TerminalTab.tsx for the existing usage pattern we mirror here.
//
// Lifecycle notes:
//   - PTY survives this component unmounting (the hook only tears down
//     its subscription, not the underlying shell). Toggle back to PTY
//     and you get a fresh xterm instance attached to the same shell;
//     scrollback for *new* output resumes, but xterm's prior buffer is
//     not replayed (xterm doesn't persist a buffer across instances).
//     This is an accepted limitation — see report in caller.
//   - Resize fires from a ResizeObserver on the container; the fit
//     addon computes new cols/rows and `hook.resize` debounces the
//     IPC at 50ms.

import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usePtySession } from '../../hooks/usePtySession'

interface PtyTerminalViewProps {
  taskId: string
  /**
   * When false, the component renders an empty wrapper and DOES NOT mount
   * xterm or attach to the PTY. This lets the parent keep the component
   * tree stable while EVENTS is the active display (avoiding mount churn
   * on toggle).
   */
  active: boolean
}

/**
 * Decode a base64-encoded PTY frame to a UTF-8 string that xterm.write()
 * accepts. The main process produces base64 in pty-service so cursor
 * positioning + ANSI escapes (binary-ish bytes) survive the IPC wire
 * cleanly. atob is available in the renderer (chromium); for the bytes
 * that follow we go through TextDecoder to preserve multibyte UTF-8.
 */
function decodeBase64ToString(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function PtyTerminalView({ taskId, active }: PtyTerminalViewProps) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const termRef         = useRef<Terminal | null>(null)
  const fitRef          = useRef<FitAddon | null>(null)
  // Stash the latest write fn so the PTY data callback can flush into
  // xterm even if we haven't received the term instance yet (rare, but
  // possible during the very first mount tick).
  const pendingWritesRef = useRef<string[]>([])

  // Hook owns subscribe/spawn/resize/write to main. We feed PTY frames
  // into xterm via `onData`.
  const session = usePtySession({
    taskId,
    active,
    initialCols: 120,
    initialRows: 30,
    onData: (b64) => {
      const text = decodeBase64ToString(b64)
      if (termRef.current) {
        termRef.current.write(text)
      } else {
        pendingWritesRef.current.push(text)
      }
    },
    onExit: (info) => {
      // Show a final marker so users see the shell died. The PTY is now
      // gone in main; if they want it back, switch display modes (which
      // calls spawn again via the hook re-entering the effect).
      if (termRef.current) {
        const exitLine = `\r\n[ PTY EXITED — exit_code=${info.exit_code ?? '?'} signal=${info.signal ?? '?'} ]\r\n`
        termRef.current.write(exitLine)
      }
    },
  })

  // Mount xterm once when `active` flips true. We don't tie this to taskId
  // changes because the parent re-keys this component by taskId already
  // (each tile mounts its own instance).
  useEffect(() => {
    if (!active) return
    if (!containerRef.current) return
    if (termRef.current) return

    const term = new Terminal({
      // Brutalist palette — match the rest of the app: deep base, bright
      // accent. No border-radius (xterm doesn't add any) and JetBrains
      // Mono for parity with the rest of the agent UI.
      theme: {
        background: '#0f0f0f',
        foreground: '#e5e5e5',
        cursor:     '#4ade80',
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize:   11,
      // Convert \n into \r\n on output for cmd.exe / powershell quirks.
      convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    try { fit.fit() } catch { /* layout not ready yet */ }

    termRef.current = term
    fitRef.current  = fit

    // Drain any frames that arrived before xterm was ready.
    if (pendingWritesRef.current.length > 0) {
      for (const chunk of pendingWritesRef.current) term.write(chunk)
      pendingWritesRef.current = []
    }

    // Wire keystrokes → main. xterm hands us already-encoded input
    // (including escape sequences for arrow keys etc.), so we pass it
    // through verbatim.
    const writeDisposable = term.onData((data) => session.write(data))

    // Initial resize push so the main-side PTY adopts our viewport.
    try {
      const { cols, rows } = term
      session.resize(cols, rows)
    } catch { /* ignore */ }

    // Observe the container — fit addon recomputes cols/rows from the
    // pixel size; we then push the new dims to main.
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return
      try {
        fitRef.current.fit()
        const { cols, rows } = termRef.current
        session.resize(cols, rows)
      } catch { /* ignore — happens during teardown */ }
    })
    ro.observe(containerRef.current)

    return () => {
      writeDisposable.dispose()
      ro.disconnect()
      try { term.dispose() } catch { /* ignore */ }
      termRef.current = null
      fitRef.current  = null
      pendingWritesRef.current = []
    }
    // We deliberately depend only on `active` — taskId is fixed for the
    // lifetime of this component (parent re-keys on taskId change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  if (!active) {
    // Render nothing when dormant — the EVENTS view is the visible one.
    // We keep the DOM node so a parent transition isn't visually jarring
    // but xterm itself is not mounted.
    return null
  }

  return (
    <div
      style={{
        flex:        1,
        minHeight:   100,
        display:     'flex',
        flexDirection: 'column',
        background:  '#0f0f0f',
        // Inner padding so xterm's cursor doesn't kiss the tile border.
        padding:     4,
        overflow:    'hidden',
      }}
    >
      <div
        ref={containerRef}
        style={{
          flex:     1,
          minHeight: 80,
          overflow: 'hidden',
        }}
      />
    </div>
  )
}
