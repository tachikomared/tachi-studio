// apps/desktop/src/pages/media/RifeAction.tsx
//
// The RIFE button on a local video card: one control that is honest about which
// of three states it is in — engine missing, idle, or running.
//
// ── WHY IT IS NOT JUST A BUTTON ──────────────────────────────────────────────
//
//  • THE ENGINE IS 431 MB. An "RIFE 2×" button that silently starts a 431 MB
//    download the first time it is pressed is an ambush on a metered
//    connection, so before the engine exists the button SAYS the size and the
//    press installs. Only once it is installed does it become the verb.
//  • ONE STATUS CALL, NOT N. A gallery renders many cards; each mounting its own
//    `rife.status()` would fire an IPC storm on every scroll. The status is
//    fetched once per app and shared, and invalidated by the two events that
//    can change it (install, uninstall).
//  • PROGRESS LIVES ON THE RAIL. The activity strip already renders this run
//    with real frame counts and a Stop, from any tab. This button therefore
//    tracks only its OWN latching (so it cannot be pressed twice) and shows the
//    failure inline — a second progress bar here would be a second, divergent
//    copy of a number the rail already owns.
//  • NO CONFIRM DIALOG. `window.confirm` freezes the renderer in this app.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from '../../components/Toaster'
import type { RifeStatusInfo } from '../../types/electron'

// ── shared status (one IPC per app, not one per card) ────────────────────────

type StatusListener = (s: RifeStatusInfo | null) => void

let cached: RifeStatusInfo | null = null
let inFlight: Promise<RifeStatusInfo | null> | null = null
const listeners = new Set<StatusListener>()

function publish(s: RifeStatusInfo | null): void {
  cached = s
  for (const l of listeners) { try { l(s) } catch { /* a dead card must not break the rest */ } }
}

/** Fetch once; every later caller joins the same promise (or the cache). */
function loadStatus(force = false): Promise<RifeStatusInfo | null> {
  if (!force && cached) return Promise.resolve(cached)
  if (!force && inFlight) return inFlight
  const api = (globalThis as { tachi?: { rife?: { status(): Promise<RifeStatusInfo> } } }).tachi?.rife
  if (!api?.status) return Promise.resolve(null)
  inFlight = api.status()
    .then(s => { publish(s); return s })
    .catch(() => null)
    .finally(() => { inFlight = null })
  return inFlight
}

/** "431 MB" — the number the button owes the user before it spends their data. */
export function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  return `${Math.round(bytes / 1_048_576)} MB`
}

/**
 * The shared engine status. EXPORTED because the canvas rife node needs exactly
 * the same answer and must not open a second cache: two module-level caches for
 * one IPC would drift the moment an install completes on one surface, and the
 * gallery could sit on "install me" while the node knows better.
 */
export function useRifeStatus(): { status: RifeStatusInfo | null; refresh: () => void } {
  const [status, setStatus] = useState<RifeStatusInfo | null>(cached)
  useEffect(() => {
    listeners.add(setStatus)
    void loadStatus()
    return () => { listeners.delete(setStatus) }
  }, [])
  const refresh = useCallback(() => { void loadStatus(true) }, [])
  return { status, refresh }
}

// ── the control ──────────────────────────────────────────────────────────────

export interface RifeActionProps {
  /** Absolute path of the LOCAL video. Remote/undefined ⇒ nothing renders. */
  path?: string
  /** The gallery's own button styling, so this control does not invent a look. */
  style?: React.CSSProperties
  /** Called with the new file once a run lands. */
  onSaved?: (outputPath: string) => void
}

export function RifeAction({ path, style, onSaved }: RifeActionProps): React.ReactElement | null {
  const { t } = useTranslation('media')
  const { status, refresh } = useRifeStatus()
  const [busy, setBusy] = useState<'install' | 'run' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // A run started from ANOTHER surface (or before this card mounted) still owns
  // this path — read that off the shared status so the button latches for it too.
  const runningElsewhere = !!path && !!status?.active?.some(p => p === path)
  const running = busy === 'run' || runningElsewhere

  const install = useCallback(async () => {
    setError(null)
    setBusy('install')
    try {
      const res = await window.tachi.rife.install()
      if (!res?.ok) {
        const msg = res?.error || t('rife.failed')
        setError(msg)
        showToast({ kind: 'error', text: msg })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast({ kind: 'error', text: msg })
    } finally {
      if (alive.current) setBusy(null)
      refresh()
    }
  }, [refresh, t])

  const interpolate = useCallback(async () => {
    if (!path) return
    setError(null)
    setBusy('run')
    try {
      const res = await window.tachi.rife.interpolate(path, 2)
      if (res?.ok && res.outputPath) {
        const name = res.outputPath.split(/[\\/]/).pop() ?? res.outputPath
        showToast({ kind: 'success', text: t('rife.saved', { name }) })
        onSaved?.(res.outputPath)
      } else if (!res?.cancelled) {
        const msg = res?.error || t('rife.failed')
        setError(msg)
        showToast({ kind: 'error', text: msg })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      showToast({ kind: 'error', text: msg })
    } finally {
      if (alive.current) setBusy(null)
      refresh()
    }
  }, [path, onSaved, refresh, t])

  const stop = useCallback(() => {
    if (!path) return
    window.tachi.rife.cancel(path).catch(() => { /* the run reports its own end */ })
  }, [path])

  // A cloud artifact has no local file, and there is nothing honest to offer
  // for it — this pipeline reads bytes off disk.
  if (!path) return null
  // Platform with no published build: say so once, do not render a dead button.
  if (status && !status.supported) {
    return <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('rife.unsupported')}</span>
  }

  const sizeLabel = formatMb(status?.downloadBytes ?? 0)
  const installed = !!status?.installed

  return (
    <>
      {running ? (
        <button onClick={stop} style={style} title={t('actions.stopTitle')}>
          {t('rife.stop')}
        </button>
      ) : (
        <button
          onClick={() => { void (installed ? interpolate() : install()) }}
          disabled={busy !== null || status === null}
          style={style}
          title={installed ? t('rife.title') : t('rife.installTitle', { size: sizeLabel })}
        >
          {busy === 'install'
            ? t('rife.installing')
            : installed
              ? t('rife.action')
              : t('rife.install', { size: sizeLabel })}
        </button>
      )}
      {error && (
        <span style={{ fontSize: 9, color: 'var(--danger, #c00)', maxWidth: 300, wordBreak: 'break-word' }}>
          {error}
        </span>
      )}
    </>
  )
}
