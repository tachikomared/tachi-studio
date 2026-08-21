// apps/desktop/src/pages/agent/CodexWorkerChip.tsx
//
// The Codex worker chip on the CODE-tab toolbar: STATUS + ON/OFF only.
// Install/login MANAGEMENT lives in Settings (user's explicit call) — when
// the sidecar isn't ready, clicking the chip NAVIGATES to the Settings card
// (and scrolls to it) instead of running flows from the toolbar:
//   + CODEX          not installed        → click opens Settings → CODEX WORKER
//   CODEX: LOG IN    installed, no login  → click opens Settings → CODEX WORKER
//   CODEX ON (green) ready + enabled      → click turns the worker OFF
//   CODEX OFF        ready + disabled     → click turns it back ON
// Direct chat: start a message with "@codex …".

import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

type CodexState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'logged-out' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'busy'; label: string }
  | { kind: 'error'; detail: string }

export function CodexWorkerChip({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const [state, setState] = useState<CodexState>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const s = await window.tachi.codex.status()
      if (!s.installed) setState({ kind: 'absent' })
      else if (!s.loggedIn) setState({ kind: 'logged-out' })
      else setState({ kind: s.enabled ? 'on' : 'off' })
    } catch (e) {
      setState({ kind: 'error', detail: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onClick = useCallback(async () => {
    if (state.kind === 'absent' || state.kind === 'logged-out' || state.kind === 'error') {
      // Management (install/login/logout) lives in SETTINGS — take the user to
      // the card and let SettingsPage scroll it into view.
      sessionStorage.setItem('tachi:settings-scroll', 'codex')
      navigate('/settings')
    } else if (state.kind === 'on' || state.kind === 'off') {
      // THE toggle — instant visual flip, then persist.
      const next = state.kind !== 'on'
      setState({ kind: next ? 'on' : 'off' })
      await window.tachi.codex.setEnabled(next).catch(() => null)
    }
  }, [state.kind, navigate])

  const { label, color, bg, title } = ((): { label: string; color: string; bg: string; title: string } => {
    switch (state.kind) {
      case 'loading':    return { label: 'CODEX …', color: 'var(--text-dim)', bg: 'var(--bg-inset)', title: t('codexChip.titleLoading') }
      case 'absent':     return { label: '+ CODEX', color: 'var(--text-muted)', bg: 'var(--bg-inset)', title: t('codexChip.titleInstall') }
      case 'logged-out': return { label: 'CODEX: LOG IN', color: 'var(--warning)', bg: 'var(--bg-inset)', title: t('codexChip.titleLogin') }
      case 'on':         return { label: 'CODEX ON', color: 'var(--bg-base)', bg: 'var(--success)', title: t('codexChip.titleOn') }
      case 'off':        return { label: 'CODEX OFF', color: 'var(--text-muted)', bg: 'var(--bg-inset)', title: t('codexChip.titleOff') }
      case 'busy':       return { label: state.label, color: 'var(--text-muted)', bg: 'var(--bg-inset)', title: state.label }
      case 'error':      return { label: 'CODEX !', color: 'var(--destructive)', bg: 'var(--bg-inset)', title: state.detail }
    }
  })()

  return (
    <button
      onClick={() => { void onClick() }}
      disabled={disabled || state.kind === 'busy' || state.kind === 'loading'}
      title={title}
      style={{
        padding: '3px 10px',
        border: 'var(--border-width) solid var(--border)',
        background: bg,
        color,
        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        cursor: (disabled || state.kind === 'busy') ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}
