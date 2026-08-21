// apps/desktop/src/components/TabTour.tsx
//
// Reusable interactive walkthrough for any tab. Shows a brutalist panel
// (bottom-left) with Next/Back, and on each step spotlights a real on-screen
// control by its `data-tour="..."` selector — drawing a glowing ring around it
// so the user sees exactly which button the explanation is about.
//
// Unlike NodesHowTo (which BUILDS an example graph), TabTour is read-only: it
// never mutates app state, only highlights + explains. Use it for Chat, Code,
// Swarm, etc.
//
// Usage:
//   const [open, setOpen] = useState(false)
//   useTourFirstVisit('chat', setOpen)            // auto-open once, ever
//   <TabTour open={open} onClose={() => setOpen(false)} steps={CHAT_TOUR} />
//
// Brutalist: 2px borders, no radius, JetBrains Mono, semantic vars, no emojis.

import React, { useEffect, useState } from 'react'

export interface TourStep {
  title: string
  body: string
  /** CSS selector of the element to spotlight, e.g. '[data-tour="chat-send"]'. */
  selector?: string
}

/** Auto-open a tab's tour the first time the user ever visits it. */
export function useTourFirstVisit(tabKey: string, setOpen: (v: boolean) => void) {
  useEffect(() => {
    try {
      const k = `tachi-tour-${tabKey}-seen`
      if (!localStorage.getItem(k)) {
        setOpen(true)
        localStorage.setItem(k, '1')
      }
    } catch { /* ignore storage errors */ }
  }, [tabKey, setOpen])
}

export function TabTour({
  open,
  onClose,
  steps,
  title = 'How to use this tab',
}: {
  open: boolean
  onClose: () => void
  steps: TourStep[]
  title?: string
}) {
  const [step, setStep] = useState(0)

  // Reset to step 0 each time the tour opens.
  useEffect(() => { if (open) setStep(0) }, [open])

  // Highlight the current step's target by animating the ACTUAL element (add a
  // pulse class), rather than positioning a separate ring that can drift. Also
  // scroll it into view so off-screen controls become visible.
  useEffect(() => {
    if (!open) return
    const sel = steps[step]?.selector
    if (!sel) return
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return
    el.classList.add('tachi-tour-pulse')
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
    return () => { el.classList.remove('tachi-tour-pulse') }
  }, [open, step, steps])

  if (!open || steps.length === 0) return null
  const s = steps[Math.min(step, steps.length - 1)]!
  const isLast = step >= steps.length - 1
  const isFirst = step === 0

  return (
    <>
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: 'fixed', left: 16, bottom: 16, width: 380, zIndex: 1200,
          border: '2px solid var(--accent)', background: 'var(--bg-surface)',
          boxShadow: '6px 6px 0 0 var(--border)', fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', flex: 1 }}>
            {title}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{step + 1} / {steps.length}</span>
          <button onClick={onClose} aria-label="Close walkthrough" title="Close"
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>
            x
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{s.title}</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>{s.body}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
            {steps.map((_, i) => (
              <span key={i} style={{ width: 18, height: 4, background: i <= step ? 'var(--accent)' : 'var(--border)' }} />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: '2px solid var(--border)' }}>
          <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={isFirst}
            style={{ ...btn, opacity: isFirst ? 0.4 : 1, cursor: isFirst ? 'default' : 'pointer' }}>
            Back
          </button>
          {!isLast ? (
            <button onClick={() => setStep(s => Math.min(steps.length - 1, s + 1))} style={{ ...btn, ...btnAccent, marginLeft: 'auto' }}>
              Next
            </button>
          ) : (
            <button onClick={onClose} style={{ ...btn, ...btnAccent, marginLeft: 'auto' }}>
              Done
            </button>
          )}
        </div>
      </div>
    </>
  )
}

const btn: React.CSSProperties = {
  padding: '5px 12px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
  fontWeight: 700, letterSpacing: '0.04em', cursor: 'pointer', textTransform: 'uppercase',
}
const btnAccent: React.CSSProperties = {
  border: '2px solid var(--accent)', background: 'var(--accent)', color: 'var(--bg-base)',
}
