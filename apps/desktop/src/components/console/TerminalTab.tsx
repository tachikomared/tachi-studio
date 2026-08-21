import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const TERM_ID = 'main-terminal'

export function TerminalTab() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let offData = () => {}
    let offExit = () => {}

    // Open the terminal only once the container ACTUALLY has a size. xterm's
    // Viewport.syncScrollArea (deferred via setTimeout after open()) reads the
    // render-service dimensions; on a 0x0 container — e.g. the console dock is
    // mounted but the Terminal tab isn't visible yet — that read throws
    // "Cannot read properties of undefined (reading 'dimensions')" repeatedly.
    // Deferring open() until the first non-zero layout avoids the crash and the
    // exception loop that came with it.
    const initIfSized = () => {
      if (initializedRef.current) return
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return
      initializedRef.current = true

      const term = new Terminal({
        theme: { background: '#0a0000', foreground: '#ffe0e0', cursor: '#ff2222' },
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        fontSize: 13,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      try { fit.fit() } catch { /* transient 0-size; the ResizeObserver refits */ }
      termRef.current = term
      fitRef.current = fit

      window.tachi.terminal.create(TERM_ID).catch((err: Error) => {
        term.write(`\r\nFailed to start terminal: ${err.message}\r\n`)
      })

      offData = window.tachi.terminal.onData((id, data) => {
        if (id === TERM_ID) term.write(data)
      })
      offExit = window.tachi.terminal.onExit((id) => {
        if (id === TERM_ID) term.write('\r\n[Process exited]\r\n')
      })

      term.onData(data => window.tachi.terminal.write(TERM_ID, data))
      term.onResize(({ cols, rows }) => window.tachi.terminal.resize(TERM_ID, cols, rows))
    }

    // The ResizeObserver both drives the deferred first init (when the tab
    // becomes visible) and refits on later size changes.
    const ro = new ResizeObserver(() => {
      if (!initializedRef.current) { initIfSized(); return }
      if (fitRef.current && container.offsetWidth > 0 && container.offsetHeight > 0) {
        try { fitRef.current.fit() } catch { /* ignore transient 0-size */ }
      }
    })
    ro.observe(container)

    // Attempt immediately in case the container is already laid out.
    initIfSized()

    return () => {
      ro.disconnect()
      offData(); offExit()
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      window.tachi.terminal.kill(TERM_ID)
      initializedRef.current = false
    }
  }, [])

  return <div ref={containerRef} style={{ width: '100%', height: '100%', padding: 4 }} />
}
