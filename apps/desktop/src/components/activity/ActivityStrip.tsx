// apps/desktop/src/components/activity/ActivityStrip.tsx
//
// THE ACTIVITY RAIL (audit U2 §2.6) — the rendering half of the three modules
// that were already on disk (activityRows / activityBridge / activity.store)
// and had no component to feed.
//
// «прогресс какая бы вкладка не была не должен проебываться теряться — юзер
// может лазить по приложению пока процессы идут» — the owner, after starting a
// Wan video generation on the Media tab, switching tabs, and finding neither an
// indicator that it was running nor a way to stop it. This strip is the answer:
// it lives in the console dock ABOVE the collapsible console body, so it is on
// screen on every route regardless of dock state, and it renders one row per
// operation that is really in flight, with the producer's own progress phrase, a
// measured bar, a wall-clock elapsed and — when a real kill exists — STOP.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
//
//  • IT IS NOT A SECOND SOURCE OF TRUTH. Every row is projected by the pure
//    `buildActivityEntries` out of stores that already existed: media.store's
//    `run` slice (fed by mediaProgressBridge, which never unsubscribes) and
//    activity.store (fed by activityBridge, likewise). This file holds no
//    progress state of its own — only the two pieces of pure VIEW state a rail
//    needs: which rows are folded, and which Stop buttons have been pressed.
//
//  • IT DOES NOT RENDER DOWNLOADS — yet. `ActivityEntry` models them and the
//    pure module orders them, but the download queue still has its own
//    `DownloadStrip` mounted one line below this one in the same dock. Feeding
//    `downloads` in here today would draw every transfer TWICE. Unifying them is
//    audit §3 step 0 (the main-process ActivityRegistry), which owns
//    DownloadStrip's markup and its tests; that is a migration, not this lane.
//
//  • IT ARMS NO TIMER TO LOOK FOR WORK. The one interval below ticks only while
//    a row is actually running, exists solely to advance the elapsed clock, and
//    is cleared the moment the last row settles. Nothing polls for state — the
//    rows arrive on push channels the producers were already emitting on.
//
//  • NO `window.confirm`. It freezes this renderer (house gotcha), and a
//    confirmation prompt in front of a Stop is the wrong product answer while a
//    GPU is burning. The click IS the decision; the button latches instead.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useActivityStore } from '../../store/activity.store'
import { useMediaStore } from '../../store/media.store'
import {
  buildActivityEntries,
  splitEntries,
  formatRowDetail,
  fmtElapsed,
  parseRunProgress,
  type ActivityRow,
} from './activityRows'
import { installActivityBridge } from './activityBridge'
import { setActivityNotifyCopy } from './activityNotify'
import { runActivityCancel } from './activityCancel'
import { showToast } from '../Toaster'

const MONO = 'JetBrains Mono, monospace'

/**
 * The row's kind, as a three-letter tag. Deliberately NOT translated: these are
 * the same class of terminal shorthand as `MB/s` and the audit's own sketch
 * (`IMG` / `DL` / `IDX`), they must stay four characters wide in every locale so
 * the rows stay aligned, and inventing eight translations for `GEN` would be
 * renderer-authored copy about work the producer already named.
 */
const KIND_TAG: Record<ActivityRow['kind'], string> = {
  'generate': 'GEN',
  'render': 'EXP',
  'engine-install': 'ENG',
  'migrate': 'MOV',
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontFamily: MONO,
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '1px 6px',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: '14px',
}

function barColor(row: ActivityRow): string {
  if (row.status === 'failed') return 'var(--danger)'
  if (row.status === 'completed') return 'var(--success)'
  return 'var(--accent)'
}

interface RowProps {
  row: ActivityRow
  /** ms since the rail first saw this row — see `firstSeen` below. */
  elapsedMs: number
  /** A Stop has been pressed for this row and the producer has not answered. */
  stopping: boolean
  onStop(row: ActivityRow): void
  onOpen(row: ActivityRow): void
  onDismiss(row: ActivityRow): void
}

function Row({ row, elapsedMs, stopping, onStop, onOpen, onDismiss }: RowProps) {
  const { t } = useTranslation('common')

  // The row's NAME: the producer's own literal first (an engine calls itself
  // "stable-diffusion.cpp"), and only when it has none does the renderer supply
  // a translated noun for the kind of work.
  const name = row.label || (row.labelKey ? t(row.labelKey) : KIND_TAG[row.kind])
  const running = row.status === 'running'
  const pct = row.percent
  const detail = formatRowDetail(row)
  const isStopping = stopping || row.stopping

  const statusWord =
    row.status === 'failed' ? t('activity.failed')
    : row.status === 'completed' ? t('activity.done')
    : row.status === 'cancelled' ? t('activity.cancelled')
    : null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, height: 22 }}>
      <span style={{
        fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em',
        color: 'var(--text-muted)', opacity: 0.7, flexShrink: 0, width: 26,
      }}>
        {KIND_TAG[row.kind]}
      </span>

      {/* The label is the jump: clicking it lands on the surface that owns the
          work, which is the other half of "the user can wander while it runs". */}
      <button
        type="button"
        title={row.surface ? t('activity.open') : name}
        onClick={() => onOpen(row)}
        disabled={!row.surface}
        style={{
          background: 'none', border: 'none', padding: 0, textAlign: 'left',
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: row.status === 'failed' ? 'var(--danger)' : 'var(--text-primary)',
          cursor: row.surface ? 'pointer' : 'default',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          flexShrink: 1, minWidth: 60, maxWidth: 220,
        }}
      >
        {name}
      </button>

      {/* percent < 0 is NOT a measurement, so NOTHING BAR-SHAPED is drawn for
          it. This used to render the same bordered track as a measured run,
          filled 100% at low opacity — static, but it reads as a progress bar,
          and a bar the user cannot trust is worse than no bar (driver-reported
          2026-08-01, next to an honest "queued · Ns"). A dashed rule keeps the
          strip's columns aligned while being unmistakably not-a-fill: there is
          no edge to read as "this far along". The elapsed seconds beside it are
          the honest signal, and they are the only one we have.
          (DownloadStrip still uses the filled-track treatment for its own
          indeterminate case — a byte transfer that genuinely has an end.) */}
      {row.status !== 'failed' && (
        pct >= 0 ? (
          <div style={{ flex: 1, minWidth: 40, height: 8, border: '1px solid var(--border)', position: 'relative' }}>
            <div
              style={{
                position: 'absolute', inset: 0,
                width: `${pct}%`,
                background: barColor(row),
                opacity: running ? 1 : 0.55,
                transition: 'width 0.25s linear',
              }}
            />
          </div>
        ) : (
          <div
            aria-hidden="true"
            style={{
              flex: 1, minWidth: 40, height: 8,
              display: 'flex', alignItems: 'center',
            }}
          >
            <div style={{
              width: '100%',
              borderTop: '1px dashed var(--border)',
              opacity: running ? 0.8 : 0.4,
            }} />
          </div>
        )
      )}

      <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {row.status === 'failed'
          ? (
            <span title={row.error ?? undefined} style={{
              color: 'var(--danger)', maxWidth: 320, display: 'inline-block',
              overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom',
            }}>
              {row.error ?? t('activity.failed')}
            </span>
          )
          : (
            <>
              {pct >= 0 && `${pct}%`}
              {detail && `${pct >= 0 ? ' · ' : ''}${detail}`}
              {running && ` · ${fmtElapsed(elapsedMs)}`}
            </>
          )}
      </span>

      {/* The producer's own progress phrase, verbatim. Never synthesized here —
          and never printed TWICE: `parseRunProgress` is the exact inverse of the
          formatter that produced the phrase, so a stage that IS the measurement
          ("14/20", "48%") is already on the bar and in the column to the left.
          Prose the engine writes itself ("loading model") parses to -1 and is
          the only thing this slot exists to carry. */}
      {row.stage && row.status !== 'failed' && parseRunProgress(row.stage).percent < 0 && (
        <span
          title={row.stage}
          style={{
            fontFamily: MONO, fontSize: 9, letterSpacing: '0.04em', color: 'var(--text-muted)',
            opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            flexShrink: 1, maxWidth: 180,
          }}
        >
          {row.stage}
        </span>
      )}

      {statusWord && (
        <span style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: row.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
          opacity: 0.7, flexShrink: 0,
        }}>
          {statusWord}
        </span>
      )}

      {/* A STOP renders IFF a real cancel exists (honesty clause 5). A row that
          is already stopping shows the latched word instead of a second button. */}
      {isStopping && running && (
        <span style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: 'var(--text-muted)', opacity: 0.7, flexShrink: 0,
        }}>
          {t('activity.stopping')}
        </span>
      )}
      {row.cancel && !isStopping && (
        <button
          type="button"
          style={{ ...btnStyle, color: 'var(--text-primary)' }}
          title={t('activity.stop')}
          onClick={() => onStop(row)}
        >
          {t('activity.stop')}
        </button>
      )}

      {/* Settled rows can be cleared by hand. A FAILURE is sticky until the user
          does so — an error nobody saw is the loss this rail exists to stop. */}
      {!running && (
        <button
          type="button"
          style={btnStyle}
          title={t('activity.dismiss')}
          onClick={() => onDismiss(row)}
        >✕</button>
      )}
    </div>
  )
}

export function ActivityStrip() {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const run = useMediaStore(s => s.run)
  const tasks = useActivityStore(s => s.tasks)
  const [expanded, setExpanded] = useState(false)
  const [stoppingIds, setStoppingIds] = useState<readonly string[]>([])

  // The rail's own listeners. Installed from an app-lifetime mount and never
  // torn down — the same contract as mediaProgressBridge, and the reason a tick
  // that lands while the producing page is unmounted still reaches a row.
  // Idempotent inside the module, so React 18 StrictMode's double-invoke (and
  // any HMR remount of this file) attaches exactly one set.
  useEffect(() => { installActivityBridge() }, [])

  // The OS toast a settled row fires when nobody is watching the window. The
  // seam installs once for the life of the app and the locale does not, so the
  // lines are re-registered whenever `t` changes rather than captured at first
  // mount (the same contract MediaPage uses for the engine's phase labels).
  useEffect(() => {
    setActivityNotifyCopy({
      imageReady:    () => t('activity.notify.imageReady'),
      videoReady:    () => t('activity.notify.videoReady'),
      genFailed:     () => t('activity.notify.genFailed'),
      installed:     (name) => t('activity.notify.installed', { name }),
      installFailed: (name) => t('activity.notify.installFailed', { name }),
      renderDone:    () => t('activity.notify.renderDone'),
      renderFailed:  () => t('activity.notify.renderFailed'),
      rifeDone:      () => t('activity.notify.rifeDone'),
      rifeFailed:    () => t('activity.notify.rifeFailed'),
      audioOverviewDone:   () => t('activity.notify.audioOverviewReady'),
      audioOverviewFailed: () => t('activity.notify.audioOverviewFailed'),
      took:          (elapsed) => t('activity.notify.took', { elapsed }),
    })
  }, [t])

  const entries = useMemo(
    // Downloads deliberately omitted — DownloadStrip still owns them (header).
    () => buildActivityEntries({ run, tasks, downloads: null }),
    [run, tasks],
  )
  const rows = useMemo(
    () => entries.flatMap(e => (e.type === 'row' ? [e.row] : [])),
    [entries],
  )
  const liveCount = rows.filter(r => r.status === 'running').length

  // ── ELAPSED · first-seen, not producer-reported ────────────────────────────
  // `ActivityRow` carries no start time (the media run slice has none to give),
  // so the rail times what IT saw: the instant a row id first appeared. That is
  // the honest claim — "this has been on the rail for 4:12" — and it is a ref,
  // not state, so recording it can never itself schedule a render.
  const firstSeen = useRef<Map<string, number>>(new Map())
  const now = Date.now()
  {
    const seen = firstSeen.current
    const live = new Set(rows.map(r => r.id))
    for (const id of live) if (!seen.has(id)) seen.set(id, now)
    for (const id of Array.from(seen.keys())) if (!live.has(id)) seen.delete(id)
  }

  // One second-hand, and only while something is actually running. `tick` is
  // never read — advancing it is the whole point (it re-renders the elapsed
  // column). Nothing here fetches, and the interval is gone the moment the last
  // row settles, so an idle app arms no timer at all.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (liveCount === 0) return
    const h = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(h)
  }, [liveCount])

  // Drop a latch once its row is no longer running: the producer has answered,
  // so a re-run on the same id must get a live Stop again.
  const runningKey = rows.filter(r => r.status === 'running').map(r => r.id).join('|')
  useEffect(() => {
    const running = new Set(runningKey ? runningKey.split('|') : [])
    setStoppingIds(prev => {
      const next = prev.filter(id => running.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [runningKey])

  // Zero rows ⇒ no chrome at all. The rail is collapsed-by-default in the only
  // way that is honest: when nothing is running there is nothing to show.
  if (entries.length === 0) return null

  const { shown, hidden } = splitEntries(entries, expanded)

  const onStop = (row: ActivityRow) => {
    if (!row.cancel) return
    setStoppingIds(prev => (prev.includes(row.id) ? prev : [...prev, row.id]))
    // The row's real state arrives on the producer's own terminal event, exactly
    // as it does for the composer's Stop button — nothing is awaited here. But a
    // Stop that could not even be ISSUED (no bridge, a throwing IPC) must say so:
    // a button that visibly latches and then does nothing is how the owner ends
    // up watching a render they believe they already killed.
    void runActivityCancel(row.cancel).then(out => {
      if (!out.ok && out.error) showToast({ kind: 'error', text: out.error })
    })
  }

  const onOpen = (row: ActivityRow) => {
    if (row.surface) navigate(row.surface)
  }

  const onDismiss = (row: ActivityRow) => {
    useActivityStore.getState().dismissTask(row.id)
  }

  return (
    <div
      data-activity-strip=""
      style={{
        borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)',
        padding: '3px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-muted)', opacity: 0.6,
        }}>
          {t('activity.title')} · {entries.length}
        </span>
        <span style={{ flex: 1 }} />
        {(hidden > 0 || expanded) && (
          <button
            type="button"
            style={btnStyle}
            onClick={() => setExpanded(v => !v)}
          >
            {/* `n`, not `count`: passing `count` would put i18next into plural
                resolution and make this one string need `_one`/`_other` forms
                in eight locales for a number that is always ≥ 1 here. */}
            {expanded ? t('activity.less') : t('activity.more', { n: hidden })}
          </button>
        )}
      </div>

      {shown.map(entry => entry.type === 'row' ? (
        <Row
          key={entry.row.id}
          row={entry.row}
          elapsedMs={now - (firstSeen.current.get(entry.row.id) ?? now)}
          stopping={stoppingIds.includes(entry.row.id)}
          onStop={onStop}
          onOpen={onOpen}
          onDismiss={onDismiss}
        />
      ) : null)}
    </div>
  )
}
