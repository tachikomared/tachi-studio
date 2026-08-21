// apps/desktop/src/components/ConfirmProvider.tsx
//
// Global dialog provider. Wrap your app root with <ConfirmProvider> and:
//   • useConfirm()    → Promise<boolean>        yes/no dialog (window.confirm)
//   • usePromptText() → Promise<string | null>  text input   (window.prompt)
//
// Both share ONE queue — if a second dialog fires while one is open it appends
// and they show one at a time, in order. That is deliberate: two fixed-position
// modals at z-index 99999 would otherwise stack on top of each other.
//
// The native globals these replace are unusable here: window.prompt() is not
// implemented in Electron's renderer (it THROWS, killing the click handler), and
// window.confirm() opens a native modal that blocks the renderer's event loop.

import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import { ConfirmDialog, type ConfirmOptions } from './ConfirmDialog'
import { PromptDialog, type PromptOptions } from './PromptDialog'

// ── Types ─────────────────────────────────────────────────────────────────────

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>
/** Resolves the TRIMMED input, or null if cancelled / dismissed / left blank. */
type PromptFn = (options: PromptOptions) => Promise<string | null>

interface PendingConfirm {
  kind:    'confirm'
  id:      number
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

interface PendingPrompt {
  kind:    'prompt'
  id:      number
  options: PromptOptions
  resolve: (value: string | null) => void
}

type PendingEntry = PendingConfirm | PendingPrompt

// ── Context ───────────────────────────────────────────────────────────────────

const ConfirmContext = createContext<ConfirmFn>(() => {
  throw new Error('[ConfirmProvider] useConfirm() must be used inside <ConfirmProvider>.')
})

const PromptContext = createContext<PromptFn>(() => {
  throw new Error('[ConfirmProvider] usePromptText() must be used inside <ConfirmProvider>.')
})

// ── Provider ──────────────────────────────────────────────────────────────────

let _seq = 0

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<PendingEntry[]>([])
  const queueRef = useRef<PendingEntry[]>([])

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      const entry: PendingConfirm = { kind: 'confirm', id: ++_seq, options, resolve }
      queueRef.current = [...queueRef.current, entry]
      setQueue(q => [...q, entry])
    })
  }, [])

  const promptText = useCallback<PromptFn>((options) => {
    return new Promise<string | null>((resolve) => {
      const entry: PendingPrompt = { kind: 'prompt', id: ++_seq, options, resolve }
      queueRef.current = [...queueRef.current, entry]
      setQueue(q => [...q, entry])
    })
  }, [])

  const close = useCallback((id: number, result: boolean | string | null) => {
    queueRef.current = queueRef.current.filter(e => e.id !== id)
    setQueue(q => {
      const entry = q.find(e => e.id === id)
      if (entry) {
        if (entry.kind === 'confirm') entry.resolve(result === true)
        else entry.resolve(typeof result === 'string' ? result : null)
      }
      return q.filter(e => e.id !== id)
    })
  }, [])

  // Only render the first pending dialog. After it resolves, the next in queue
  // will appear automatically because queue[0] changes.
  const current = queue[0]

  return (
    <ConfirmContext.Provider value={confirm}>
      <PromptContext.Provider value={promptText}>
        {children}
        {current && current.kind === 'confirm' && (
          <ConfirmDialog
            key={current.id}
            {...current.options}
            onOk={()     => close(current.id, true)}
            onCancel={()  => close(current.id, false)}
          />
        )}
        {current && current.kind === 'prompt' && (
          <PromptDialog
            key={current.id}
            {...current.options}
            onOk={(value) => close(current.id, value)}
            onCancel={()  => close(current.id, null)}
          />
        )}
      </PromptContext.Provider>
    </ConfirmContext.Provider>
  )
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

/**
 * In-app replacement for window.prompt(). Resolves the trimmed string the user
 * entered, or null if they cancelled (Escape, CANCEL, backdrop) — a blank or
 * whitespace-only input can never resolve to a value.
 */
export function usePromptText(): PromptFn {
  return useContext(PromptContext)
}
