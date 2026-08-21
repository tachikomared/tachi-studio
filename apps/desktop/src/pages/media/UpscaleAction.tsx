// apps/desktop/src/pages/media/UpscaleAction.tsx
//
// The UPSCALE button on a local image card — the answer to "make it bigger",
// which is the #1 follow-up to a finished render and had none.
//
// ── THE SAME THREE STATES RifeAction HAS, FOR THE SAME REASONS ───────────────
//
//  • THE WEIGHTS ARE 64 MB. An "UPSCALE" button that silently starts a 64 MB
//    download the first time it is pressed is an ambush on a metered
//    connection, so before the file exists the button SAYS the size and the
//    press installs. Only once it is on disk does it become the verb.
//  • ONE CATALOG CALL, NOT N. A gallery renders many tiles; each mounting its
//    own status IPC would fire a storm on every scroll. The upscaler list is
//    fetched once per app and shared, and invalidated by the one event that can
//    change it (an install).
//  • PROGRESS LIVES ON THE RAIL. The activity strip already renders this run —
//    it rides the shared `sd-cpp:gen-progress` channel, so the existing Stop
//    works on it — and a second bar here would be a divergent copy of a number
//    the rail owns. This button tracks only its OWN latching.
//  • NO CONFIRM DIALOG. `window.confirm` freezes the renderer in this app.
//
// WHY IT IS NOT ON EVERY TILE: `-M upscale` reads BYTES OFF DISK. A cloud
// artifact (a Venice/Surplus render served from a URL) has no local file, and
// there is nothing honest to offer for it — the same `if (!path) return null`
// rule RifeAction applies to a remote video.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from '../../components/Toaster'

/** One curated upscaler as the catalog reports it. */
export interface UpscalerInfo {
  id:          string
  name:        string
  scale:       number
  sizeMbTotal: number
  installed:   boolean
  notes:       string
}

// ── shared catalog slice (one IPC per app, not one per tile) ──────────────────

type Listener = (u: UpscalerInfo[] | null) => void

let cached: UpscalerInfo[] | null = null
let inFlight: Promise<UpscalerInfo[] | null> | null = null
const listeners = new Set<Listener>()

function publish(u: UpscalerInfo[] | null): void {
  cached = u
  for (const l of listeners) { try { l(u) } catch { /* a dead tile must not break the rest */ } }
}

/** Fetch once; every later caller joins the same promise (or the cache). */
function loadUpscalers(force = false): Promise<UpscalerInfo[] | null> {
  if (!force && cached) return Promise.resolve(cached)
  if (!force && inFlight) return inFlight
  const api = window.tachi?.sdCpp
  if (!api?.catalog) return Promise.resolve(null)
  inFlight = api.catalog()
    .then(c => {
      // An older main build sends no `upscalers` key at all — that is an empty
      // list, not an error, and no button renders.
      const list = (c?.ok ? c.upscalers ?? [] : []) as UpscalerInfo[]
      publish(list)
      return list
    })
    .catch(() => null)
    .finally(() => { inFlight = null })
  return inFlight
}

/** "64 MB" — the number the button owes the user before it spends their data. */
export function formatUpscalerMb(sizeMb: number): string {
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) return '—'
  return `${Math.round(sizeMb)} MB`
}

/**
 * The shared upscaler list. EXPORTED so a second surface (the canvas, later)
 * cannot open a second cache: two module-level caches for one payload would
 * drift the moment an install completes on one of them.
 */
export function useUpscalers(): { upscalers: UpscalerInfo[] | null; refresh: () => void } {
  const [upscalers, setUpscalers] = useState<UpscalerInfo[] | null>(cached)
  useEffect(() => {
    listeners.add(setUpscalers)
    void loadUpscalers()
    return () => { listeners.delete(setUpscalers) }
  }, [])
  const refresh = useCallback(() => { void loadUpscalers(true) }, [])
  return { upscalers, refresh }
}

// ── the control ──────────────────────────────────────────────────────────────

export interface UpscaleActionProps {
  /** Absolute path of the LOCAL image. Remote/undefined ⇒ nothing renders. */
  path?: string
  /** The gallery's own button styling, so this control does not invent a look. */
  style?: React.CSSProperties
  /** Called with the new file and the factor that produced it once a run lands. */
  onSaved?: (outputPath: string, scale: number) => void
}

export function UpscaleAction({ path, style, onSaved }: UpscaleActionProps): React.ReactElement | null {
  const { t } = useTranslation('media')
  const { upscalers, refresh } = useUpscalers()
  const [busy, setBusy] = useState<'install' | 'run' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // The curated default is the first row: one is shipped, and a second would be
  // a picker rather than a button.
  const row = upscalers?.[0]

  const install = useCallback(async () => {
    if (!row) return
    setError(null)
    setBusy('install')
    try {
      const res = await window.tachi.sdCpp.downloadUpscaler(row.id)
      if (!res?.ok) {
        const msg = res?.error || t('upscale.failed')
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
  }, [row, refresh, t])

  const upscale = useCallback(async () => {
    if (!path || !row) return
    setError(null)
    setBusy('run')
    try {
      const res = await window.tachi.sdCpp.upscale({ path, upscalerId: row.id })
      if (res?.ok && res.path) {
        const name = res.path.split(/[\\/]/).pop() ?? res.path
        showToast({ kind: 'success', text: t('upscale.saved', { name }) })
        onSaved?.(res.path, res.scale ?? row.scale)
      } else {
        const msg = res?.error || t('upscale.failed')
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
  }, [path, row, onSaved, refresh, t])

  // A cloud artifact has no local file, and this pipeline reads bytes off disk.
  if (!path) return null
  // The catalog has not answered yet, or this build ships no upscaler at all:
  // render nothing rather than a dead button.
  if (!row) return null

  const sizeLabel = formatUpscalerMb(row.sizeMbTotal)
  const scale = row.scale

  return (
    <>
      <button
        onClick={() => { void (row.installed ? upscale() : install()) }}
        disabled={busy !== null}
        style={style}
        title={row.installed
          ? t('upscale.title', { scale, name: row.name })
          : t('upscale.installTitle', { size: sizeLabel, name: row.name })}
      >
        {busy === 'install'
          ? t('upscale.installing')
          : busy === 'run'
            ? t('upscale.running')
            : row.installed
              ? t('upscale.action', { scale })
              : t('upscale.install', { size: sizeLabel })}
      </button>
      {error && (
        <span style={{ fontSize: 9, color: 'var(--danger, #c00)', maxWidth: 300, wordBreak: 'break-word' }}>
          {error}
        </span>
      )}
    </>
  )
}
