// apps/desktop/src/app/QuickAskWindow.tsx
//
// The QUICK-ASK floating window (loaded as index.html#quickask by
// quick-ask-service). Enter asks, the answer STREAMS in, follow-ups keep the
// thread; answers come from the keyless local FreeLLM router.
//
// The bar no longer throws work away: re-summoning replays the running thread
// (main keeps it), PIN stops the window hiding when it loses focus, Esc aborts
// a run before it closes anything, Ctrl+N starts fresh and Ctrl+J hands the
// whole exchange to the main chat window.
//
// QUICK PROMPTS + CONTEXT (the "select text → hotkey → click a prompt" flow):
//   • a CONTEXT CHIP above the input carries whatever main captured on summon —
//     the auto-captured selection, or the clipboard. Armed chips ride along with
//     the next send; X (or the first Esc) disarms.
//   • a CHIP ROW under the input offers 4 built-ins (translate / summarize /
//     explain / fix) plus the newest saved templates from the SAME prompt
//     library the chat input uses. Clicking one composes template + context +
//     whatever is typed into ONE user turn and sends it. Nothing ever
//     auto-sends: a click or Enter is always required.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePromptsStore } from '../store/prompts.store'
import {
  builtinQuickPrompts,
  libraryQuickPrompts,
  composeQuickAsk,
  previewTurnText,
  type QuickPrompt,
} from './quickAskPrompts'
import type { QuickAskContext } from '../types/electron'

type Turn = { role: 'user' | 'assistant'; content: string }

const btn: React.CSSProperties = {
  padding: '2px 8px', border: '2px solid var(--border, #2a2a2a)', background: 'transparent',
  color: 'var(--text-muted, #888)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer',
}

const chipStyle: React.CSSProperties = {
  padding: '3px 8px', border: '2px solid var(--border, #2a2a2a)', background: 'transparent',
  color: 'var(--text-muted, #888)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer',
  whiteSpace: 'nowrap', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis',
}

export function QuickAskWindow() {
  const { t, i18n } = useTranslation('common')
  const [prompt, setPrompt] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [context, setContext] = useState<QuickAskContext | null>(null)
  const [autoCapture, setAutoCapture] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Prompt-recall ring (newest first) + cursor; -1 == not recalling.
  const historyRef = useRef<string[]>([])
  const histIdx = useRef(-1)
  const busyRef = useRef(false)
  busyRef.current = busy
  // Esc must disarm the context chip before it closes the bar.
  const armedRef = useRef(false)
  armedRef.current = !!context?.armed

  // The chat prompt library — same zustand store, same localStorage key. This
  // window is a SECOND renderer, so its copy is rehydrated on every summon
  // (templates saved in the chat window while the bar sat hidden still show up).
  const templates = usePromptsStore(s => s.templates)
  const libraryChips = useMemo(() => libraryQuickPrompts(templates), [templates])
  const builtinChips = useMemo(() => builtinQuickPrompts(i18n.resolvedLanguage ?? i18n.language), [i18n.resolvedLanguage, i18n.language])

  const focusInput = () => setTimeout(() => inputRef.current?.focus(), 30)

  // Keep the scrollback pinned to the newest text while an answer streams.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, streaming])

  const startNew = useCallback(() => {
    void window.tachi.quickask.newSession().catch(() => {})
    setTurns([]); setStreaming(''); setError(null); setBusy(false); setPrompt('')
    histIdx.current = -1
    focusInput()
  }, [])

  useEffect(() => {
    inputRef.current?.focus()

    type ShownPayload = {
      turns?: Turn[]
      pinned?: boolean
      history?: string[]
      busy?: boolean
      context?: QuickAskContext | null
      autoCapture?: boolean
    }
    const applyShown = (payload: ShownPayload | null | undefined) => {
      // THEME FOLLOW (live-found: the bar rendered light-on-white inside a
      // dark app). This window's data-theme is stamped once by the anti-FOUC
      // script at load and never hears theme.store changes — re-read the
      // persisted choice on every summon. Custom themes' injected <style>
      // lives only in the main window, so `custom:` ids fall back to dark.
      try {
        const saved = localStorage.getItem('tachi-theme')
        if (saved) {
          document.documentElement.setAttribute(
            'data-theme', saved.startsWith('custom:') ? 'tachi-dark' : saved)
        }
      } catch { /* storage unavailable — keep the load-time theme */ }
      const running = !!payload?.busy
      setTurns(payload?.turns ?? [])
      setPinned(!!payload?.pinned)
      historyRef.current = payload?.history ?? []
      histIdx.current = -1
      setContext(payload?.context ?? null)
      setAutoCapture(payload?.autoCapture !== false)
      // Templates saved in the main window land in localStorage, not in this
      // renderer's store — re-read them whenever the bar comes back up.
      try { void usePromptsStore.persist?.rehydrate?.() } catch { /* store not persisted */ }
      // Re-summoning mid-answer must NOT wipe the text still arriving.
      if (!running) setStreaming('')
      setError(null); setBusy(running); setPrompt('')
      focusInput()
    }

    // Re-summon: replay whatever main still holds instead of wiping the answer.
    const offShown = window.tachi.quickask.onShown(applyShown)
    // The FIRST summon fires 'quickask:shown' before this component subscribes;
    // pull the same payload so the very first context chip is not lost.
    void window.tachi.quickask.sync?.().then(p => { if (p?.ok) applyShown(p) }).catch(() => {})

    const offChunk = window.tachi.quickask.onChunk?.((chunk) => {
      if (chunk.type === 'delta') { setStreaming(s => s + chunk.text); return }
      if (chunk.type === 'done') {
        setStreaming('')
        setTurns(ts => [...ts, { role: 'assistant', content: chunk.text }])
        setBusy(false)
        focusInput()
        return
      }
      // error
      setStreaming(''); setBusy(false)
      if (chunk.error !== 'aborted') {
        setError(chunk.error === 'freellm-not-running' ? t('quickask.routerDown') : chunk.error)
      }
      focusInput()
    })

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc cancels a run first, then disarms the context chip; only after
        // that does it close the bar.
        if (busyRef.current) { void window.tachi.quickask.abort?.(); return }
        if (armedRef.current) { setContext(c => (c ? { ...c, armed: false } : c)); return }
        void window.tachi.quickask.hide()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); startNew(); return }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        void window.tachi.quickask.handoff?.().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { offShown(); offChunk?.(); window.removeEventListener('keydown', onKey) }
  }, [t, startNew])

  /** The single send path — chips and Enter both land here with ONE user turn. */
  const sendText = async (text: string, recall: string) => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true); setError(null); setStreaming('')
    setTurns(ts => [...ts, { role: 'user', content: q }])
    // Recall ring is main-owned, but mirror locally so Up works immediately.
    const remembered = recall.trim()
    if (remembered) {
      historyRef.current = [remembered, ...historyRef.current.filter(x => x !== remembered)].slice(0, 20)
    }
    histIdx.current = -1
    setPrompt('')
    // Context is consumed by the send it rode along with.
    setContext(c => (c ? { ...c, armed: false } : c))
    inputRef.current?.focus()
    const r = await window.tachi.quickask.ask(q).catch(e => ({ ok: false as const, error: String(e) }))
    // Chunks normally finish the turn; this is the fallback for a run that
    // returned without ever streaming (router down, HTTP error, abort).
    setBusy(false)
    if (!r.ok) {
      setStreaming('')
      if (r.error !== 'aborted') {
        setError(r.error === 'freellm-not-running' ? t('quickask.routerDown') : (r.error ?? 'error'))
      }
      inputRef.current?.focus()
    }
  }

  const armedContext = context?.armed ? context.text : ''

  const askNow = async () => {
    const typed = prompt.trim()
    if (!typed || busy) return
    await sendText(composeQuickAsk('', armedContext, typed), typed)
  }

  // A chip needs SOMETHING to act on: armed context, typed text, or a thread to
  // follow up on. Otherwise "translate" would ask the model to translate air.
  const chipsDisabled = busy || (!armedContext && !prompt.trim() && turns.length === 0)

  const runChip = (chip: QuickPrompt) => {
    if (chipsDisabled) return
    const typed = prompt.trim()
    void sendText(composeQuickAsk(chip.template, armedContext, typed), typed || chip.label)
  }

  // Up/Down cycles previous prompts, but only from an EMPTY input.
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { void askNow(); return }
    const ring = historyRef.current
    if (e.key === 'ArrowUp') {
      if (!ring.length) return
      if (prompt && histIdx.current === -1) return
      e.preventDefault()
      const next = Math.min(histIdx.current + 1, ring.length - 1)
      histIdx.current = next
      setPrompt(ring[next] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      if (histIdx.current < 0) return
      e.preventDefault()
      const next = histIdx.current - 1
      histIdx.current = next
      setPrompt(next < 0 ? '' : (ring[next] ?? ''))
    }
  }

  const togglePin = () => {
    const want = !pinned
    setPinned(want)
    void window.tachi.quickask.setPinned?.(want).catch(() => {})
    inputRef.current?.focus()
  }

  const toggleAutoCapture = () => {
    const want = !autoCapture
    setAutoCapture(want)
    void window.tachi.quickask.setAutoCapture?.(want).catch(() => {})
    inputRef.current?.focus()
  }

  const builtinLabel = (chip: QuickPrompt) => {
    switch (chip.id) {
      case 'qp-translate': return t('quickask.qpTranslate', 'translate')
      case 'qp-summarize': return t('quickask.qpSummarize', 'summarize')
      case 'qp-explain':   return t('quickask.qpExplain', 'explain')
      case 'qp-fix':       return t('quickask.qpFix', 'fix')
      default:             return chip.label
    }
  }

  const lastAnswer = [...turns].reverse().find(x => x.role === 'assistant')?.content ?? ''
  const hasThread = turns.length > 0 || !!streaming
  // Chips are for STARTING something: hidden once the user is typing a
  // free-form question, unless a context chip is armed (translate THIS).
  const showChips = !prompt.trim() || !!context?.armed
  const chips: QuickPrompt[] = [...builtinChips, ...libraryChips]

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-base, #0f0f0f)', color: 'var(--text-primary, #f5f5f0)',
      border: '2px solid var(--border-strong, #3a3a3a)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      {context && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          borderBottom: '2px solid var(--border, #2a2a2a)', fontSize: 10,
        }}>
          <span
            title={context.preview}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px',
              border: `2px solid ${context.armed ? 'var(--accent, #6b38d4)' : 'var(--border, #2a2a2a)'}`,
              color: context.armed ? 'var(--text-primary, #f5f5f0)' : 'var(--text-muted, #888)',
              maxWidth: '100%', overflow: 'hidden',
            }}>
            <span style={{ flexShrink: 0 }}>
              {context.kind === 'selection'
                ? t('quickask.ctxSelection', 'Selection')
                : t('quickask.ctxClipboard', 'Clipboard')} · {context.chars}
            </span>
            <span style={{ color: 'var(--text-dim, #444)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {context.preview}
            </span>
            <button
              onClick={() => setContext(c => (c && c.armed ? { ...c, armed: false } : null))}
              title={t('quickask.ctxDismiss', 'Do not send this as context (Esc)')}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-dim, #444)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, padding: 0, flexShrink: 0 }}>
              ✕
            </button>
          </span>
          {!context.armed && (
            <button onClick={() => setContext(c => (c ? { ...c, armed: true } : c))} style={btn}>
              {t('quickask.ctxUse', 'use')}
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '2px solid var(--border, #2a2a2a)' }}>
        <div style={{ width: 14, height: 14, background: 'var(--accent, #6b38d4)', border: '2px solid var(--border-strong, #3a3a3a)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          value={prompt}
          onChange={e => { setPrompt(e.target.value); histIdx.current = -1 }}
          onKeyDown={onInputKey}
          placeholder={t('quickask.placeholder')}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary, #f5f5f0)', fontFamily: 'inherit', fontSize: 14,
          }}
        />
        <button onClick={togglePin} title={t('quickask.pinTitle', 'Keep the window open when it loses focus')}
          style={{
            ...btn, padding: '4px 8px',
            borderColor: pinned ? 'var(--accent, #6b38d4)' : 'var(--border, #2a2a2a)',
            color: pinned ? 'var(--text-primary, #f5f5f0)' : 'var(--text-muted, #888)',
          }}>
          {pinned ? t('quickask.pinned', 'pinned') : t('quickask.pin', 'pin')}
        </button>
        <button onClick={() => void askNow()} disabled={busy || !prompt.trim()}
          style={{ padding: '4px 12px', border: '2px solid var(--border-strong, #3a3a3a)', background: 'var(--accent, #6b38d4)', color: '#fff', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', opacity: busy || !prompt.trim() ? 0.5 : 1 }}>
          {busy ? t('quickask.asking') : t('quickask.ask')}
        </button>
      </div>

      {showChips && chips.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', overflowX: 'auto',
          borderBottom: '2px solid var(--border, #2a2a2a)',
        }}>
          {chips.map(chip => {
            const label = chip.builtin ? builtinLabel(chip) : chip.label
            return (
              <button
                key={chip.id}
                onClick={() => runChip(chip)}
                disabled={chipsDisabled}
                title={chipsDisabled && !busy
                  ? t('quickask.chipNeedsText', 'Copy or select some text first, or type a question')
                  : chip.template}
                style={{
                  ...chipStyle,
                  opacity: chipsDisabled ? 0.5 : 1,
                  borderColor: chip.builtin ? 'var(--border, #2a2a2a)' : 'var(--border-strong, #3a3a3a)',
                }}>
                {label}
              </button>
            )
          })}
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 12, fontSize: 12.5, lineHeight: 1.55, wordBreak: 'break-word' }}>
        {turns.map((turn, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9.5, color: 'var(--text-dim, #444)', marginBottom: 2 }}>
              {turn.role === 'user' ? t('quickask.you', 'you') : t('quickask.answer', 'answer')}
            </div>
            <div style={{
              whiteSpace: 'pre-wrap',
              color: turn.role === 'user' ? 'var(--text-muted, #888)' : 'var(--text-primary, #f5f5f0)',
            }}>{turn.role === 'user' ? previewTurnText(turn.content) : turn.content}</div>
          </div>
        ))}
        {streaming && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9.5, color: 'var(--text-dim, #444)', marginBottom: 2 }}>{t('quickask.answer', 'answer')}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{streaming}</div>
          </div>
        )}
        {error && <div style={{ color: 'var(--danger, #ff5252)', whiteSpace: 'pre-wrap' }}>{error}</div>}
        {!hasThread && !error && (
          <span style={{ color: 'var(--text-dim, #444)' }}>{busy ? t('quickask.thinking') : t('quickask.hintEmpty')}</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderTop: '2px solid var(--border, #2a2a2a)', fontSize: 10, color: 'var(--text-dim, #444)' }}>
        <span>{t('quickask.footer')}</span>
        <span style={{ flex: 1 }} />
        <button onClick={toggleAutoCapture}
          title={t('quickask.captureTitle', 'Auto-copy the text selected in the app you are looking at when the bar opens')}
          style={{
            ...btn,
            borderColor: autoCapture ? 'var(--accent, #6b38d4)' : 'var(--border, #2a2a2a)',
            color: autoCapture ? 'var(--text-muted, #888)' : 'var(--text-dim, #444)',
          }}>
          {autoCapture ? t('quickask.captureOn', 'capture on') : t('quickask.captureOff', 'capture off')}
        </button>
        {hasThread && (
          <button onClick={startNew} title="Ctrl+N" style={btn}>{t('quickask.new', 'new')}</button>
        )}
        {lastAnswer && (
          <button onClick={() => { navigator.clipboard.writeText(lastAnswer).catch(() => {}) }} style={btn}>
            {t('quickask.copy')}
          </button>
        )}
        {turns.length > 0 && (
          <button onClick={() => void window.tachi.quickask.handoff?.().catch(() => {})} title="Ctrl+J" style={btn}>
            {t('quickask.continueInChat', 'continue in chat')}
          </button>
        )}
        <button onClick={() => void window.tachi.quickask.openApp()} style={btn}>
          {t('quickask.openApp')}
        </button>
      </div>
    </div>
  )
}
