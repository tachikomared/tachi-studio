import React, { useState, useRef, useLayoutEffect } from 'react'
import { TerminalTab } from './TerminalTab'
import { AgentCommandsTab } from './AgentCommandsTab'
import { LogsTab } from './LogsTab'
import { TraceTab } from './TraceTab'
import { ObservabilityTab } from './ObservabilityTab'
import { CodexTab } from './CodexTab'

const TABS = ['Terminal', 'Agent Commands', 'Codex', 'Logs', 'Trace', 'Observability'] as const
type Tab = typeof TABS[number]

export function ConsoleTabs() {
  const [active, setActive] = useState<Tab>('Terminal')

  // Sliding-underline indicator: we measure the active button's offset/width and
  // drive an absolutely-positioned pill that eases between tabs (see .tachi-tab-slider).
  const barRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [slider, setSlider] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const btn = btnRefs.current[active]
    const bar = barRef.current
    if (!btn || !bar) return
    const measure = () => {
      const b = btnRefs.current[active]
      if (!b || !barRef.current) return
      setSlider({ left: b.offsetLeft, width: b.offsetWidth })
    }
    measure()
    // Re-measure on container resize (dock width changes, font load, etc.)
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [active])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div
        ref={barRef}
        style={{ position: 'relative', display: 'flex', borderBottom: 'var(--border-width) solid var(--border)', padding: '0 8px' }}
      >
        {TABS.map(t => (
          <button
            key={t}
            ref={el => { btnRefs.current[t] = el }}
            onClick={() => setActive(t)}
            style={{
              padding: '4px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12,
              color: active === t ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: active === t ? 700 : 400,
              transition: 'color 140ms ease-out, font-weight 140ms ease-out',
            }}
          >{t}</button>
        ))}
        {/* Animated underline that slides to the active tab. */}
        <div
          className="tachi-tab-slider"
          style={{
            position: 'absolute', bottom: -1, height: 2,
            left: slider.left, width: slider.width,
            background: 'var(--accent)',
          }}
        />
      </div>
      {/* key={active} remounts the panel so the crossfade keyframe replays per switch. */}
      <div key={active} className="tachi-tab-content" style={{ flex: 1, overflow: 'hidden' }}>
        {active === 'Terminal'       && <TerminalTab />}
        {active === 'Agent Commands' && <AgentCommandsTab />}
        {active === 'Codex'          && <CodexTab />}
        {active === 'Logs'           && <LogsTab />}
        {active === 'Trace'          && <TraceTab />}
        {active === 'Observability'  && <ObservabilityTab />}
      </div>
    </div>
  )
}
