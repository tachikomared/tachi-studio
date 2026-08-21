// apps/desktop/src/pages/aeon/AeonDashboardView.tsx
//
// Embeds Aeon's native Next.js dashboard inside the Aeon tab via iframe.
// The whole flow is zero-terminal: clicking "Launch dashboard" tells the
// main process to download the upstream Aeon source tarball, npm-install
// it under app userData, and spawn `next dev` with our GitHub OAuth token
// passed through as GH_TOKEN. The iframe swaps in once the dashboard is
// answering on its assigned port.
//
// The renderer never has to know about ports, paths, processes, or shells —
// it just subscribes to progress events and renders one of: ready (iframe),
// installing (progress card), error (retry card), idle (launch card).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAeonStore } from '../../store/aeon.store'
import { useConfirm } from '../../components/ConfirmProvider'

interface AeonDashboardViewProps {
  owner: string
}

type Stage = 'idle' | 'downloading' | 'extracting' | 'installing-deps' | 'installing-gh' | 'starting' | 'ready' | 'error'

interface ProgressEvent {
  stage:    Stage
  bytes?:   number
  total?:   number
  port?:    number
  message?: string
}

// Maps each Stage to its translation key suffix under `dashboard.stage.*`
// (hyphenated stage ids become camelCase keys so they index cleanly via t()).
const STAGE_KEY: Record<Stage, string> = {
  idle:              'idle',
  downloading:       'downloading',
  extracting:        'extracting',
  'installing-deps': 'installingDeps',
  'installing-gh':   'installingGh',
  starting:          'starting',
  ready:             'ready',
  error:             'error',
}

type TFn = (key: string) => string
function stageLabel(t: TFn, stage: Stage): string {
  return t(`dashboard.stage.${STAGE_KEY[stage]}`)
}

function formatMB(bytes?: number): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AeonDashboardView({ owner }: AeonDashboardViewProps) {
  const { t } = useTranslation('aeon')
  const setView   = useAeonStore(s => s.setView)
  const confirm   = useConfirm()
  const [stage, setStage]   = useState<Stage>('idle')
  const [bytes, setBytes]   = useState<number | undefined>()
  const [total, setTotal]   = useState<number | undefined>()
  const [port,  setPort]    = useState<number | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [prereqs, setPrereqs] = useState<{ node: boolean; npm: boolean } | null>(null)
  // Force the iframe to remount when we re-launch (new port or recovered state).
  const [iframeKey, setIframeKey] = useState(0)

  // Resolve initial status + subscribe to live progress on mount. Streaming
  // from the main process is one-way push — no polling — so once we mount
  // we just react to whatever stage the service is in.
  useEffect(() => {
    let cancelled = false

    // If a previous instance of this view scheduled an auto-stop on unmount,
    // cancel it — the user came back within the grace period and we don't
    // want to nuke the running dashboard.
    const w = window as unknown as { __aeonDashStopTimer?: ReturnType<typeof setTimeout> }
    if (w.__aeonDashStopTimer) {
      clearTimeout(w.__aeonDashStopTimer)
      w.__aeonDashStopTimer = undefined
    }

    Promise.all([
      window.tachi.aeon.dashboardStatus(),
      window.tachi.aeon.dashboardPrereqs(),
    ]).then(([status, pre]) => {
      if (cancelled) return
      setStage(status.state)
      setPort(status.port)
      setErrMsg(status.message ?? null)
      setPrereqs({ node: pre.node.found, npm: pre.npm.found })
    }).catch(() => { /* nothing yet — leave at idle */ })

    const off = window.tachi.aeon.onDashboardProgress(e => {
      setStage(e.stage as Stage)
      setBytes(e.bytes)
      setTotal(e.total)
      if (e.port  !== undefined) setPort(e.port)
      if (e.stage === 'error') setErrMsg(e.message ?? 'Unknown error')
      else if (e.stage !== 'error') setErrMsg(null)
      if (e.stage === 'ready') setIframeKey(k => k + 1)
    })
    return () => { cancelled = true; off() }
  }, [])

  // ── Auto-stop on unmount (with grace period) ────────────────────────────
  //
  // The embedded Next.js dashboard polls /api/runs every few seconds when
  // its iframe is mounted; each /api/runs call internally proxies to
  // api.github.com to list Actions runs. Once the user leaves the dashboard
  // view we should stop the server so we're not hitting GitHub in the
  // background — but tab-switching is cheap, so we wait 60s before killing
  // the process to avoid restart-thrash on quick navigations.
  useEffect(() => {
    return () => {
      const t = setTimeout(() => {
        window.tachi.aeon.dashboardStop().catch(() => { /* idempotent */ })
      }, 60_000)
      // If the user mounts a fresh AeonDashboardView within 60s, that view
      // will hit dashboardStatus() and find the server still running. Its
      // own unmount cleanup will reset this timer. We can't cancel the
      // already-scheduled timeout from a *future* mount, but the cost is
      // just one redundant stop call which is a no-op when nothing is
      // running. Acceptable tradeoff for simplicity.
      // (Storing the timer on window keeps it cancellable across remounts
      //  in the same JS realm, in case we want that optimisation later.)
      ;(window as unknown as { __aeonDashStopTimer?: ReturnType<typeof setTimeout> }).__aeonDashStopTimer = t
    }
  }, [])

  const launch = useCallback(async () => {
    setErrMsg(null)
    try {
      await window.tachi.aeon.dashboardInstallAndLaunch(owner)
    } catch (err) {
      // The service emits the error event too — but this catch keeps the
      // button from getting stuck on a stale "starting" state if the IPC
      // itself rejects (e.g. preload mismatch).
      setErrMsg(err instanceof Error ? err.message : String(err))
      setStage('error')
    }
  }, [owner])

  const stop = useCallback(async () => {
    await window.tachi.aeon.dashboardStop()
  }, [])

  const resetCache = useCallback(async () => {
    const ok = await confirm({ message: t('dashboard.resetConfirm.message'), okLabel: t('dashboard.resetConfirm.ok') })
    if (!ok) return
    await window.tachi.aeon.dashboardReset()
  }, [confirm, t])

  const dashboardUrl = port ? `http://localhost:${port}/` : ''
  const isRunning    = stage === 'ready' && port !== null
  const isWorking    = stage === 'downloading' || stage === 'extracting' || stage === 'installing-deps' || stage === 'installing-gh' || stage === 'starting'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}>
        <button
          onClick={() => setView('home')}
          title={t('dashboard.backTitle')}
          style={btnGhost}
        >{t('dashboard.back')}</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
          {t('dashboard.label')}
        </span>
        {dashboardUrl && (
          <code style={{
            fontSize: 11,
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            background: 'var(--bg-inset)',
            padding: '2px 6px',
            border: 'var(--border-width) solid var(--border)',
          }}>{dashboardUrl}</code>
        )}
        <span style={{
          fontSize: 9,
          padding: '2px 6px',
          border: `var(--border-width) solid ${stageColor(stage)}`,
          color: stageColor(stage),
          letterSpacing: '0.08em',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 700,
        }}>
          {stageLabel(t, stage).toUpperCase()}
        </span>
        <span style={{ flex: 1 }} />
        {isRunning && (
          <>
            <button onClick={() => setIframeKey(k => k + 1)} style={btnGhost} title={t('dashboard.reloadIframeTitle')}>{t('dashboard.reload')}</button>
            <button onClick={() => window.tachi.shell.openExternal(dashboardUrl)} style={btnGhost}>{t('dashboard.openInBrowser')}</button>
            <button onClick={stop} style={btnGhost} title={t('dashboard.stopTitle')}>{t('dashboard.stop')}</button>
          </>
        )}
      </div>

      {/* Body */}
      {isRunning && dashboardUrl
        ? (
          <iframe
            key={iframeKey}
            src={dashboardUrl}
            title={t('dashboard.iframeTitle')}
            // sandbox omitted — needs same-origin localhost + full JS to drive
            // its `gh` shell-outs. We trust localhost:<port> because we
            // spawned the process ourselves with GH_TOKEN env passed through.
            style={{ flex: 1, width: '100%', border: 'none', background: '#ffffff' }}
          />
        )
        : isWorking
          ? <ProgressCard stage={stage} bytes={bytes} total={total} />
          : <LaunchCard
              owner={owner}
              prereqs={prereqs}
              errorMessage={errMsg}
              onLaunch={launch}
              onResetCache={resetCache}
            />
      }
    </div>
  )
}

function stageColor(stage: Stage): string {
  switch (stage) {
    case 'ready':            return 'var(--success)'
    case 'error':            return 'var(--danger)'
    case 'idle':             return 'var(--text-dim)'
    default:                 return 'var(--accent)'  // any working stage
  }
}

// ── Cards ────────────────────────────────────────────────────────────────────

interface ProgressCardProps {
  stage: Stage
  bytes?: number
  total?: number
}

function ProgressCard({ stage, bytes, total }: ProgressCardProps) {
  const { t } = useTranslation('aeon')
  const pct = bytes && total ? Math.min(100, Math.round((bytes / total) * 100)) : null

  return (
    <CenteredCard title={t('dashboard.progress.title', { stage: stageLabel(t, stage) })}>
      <p style={cardBodyText}>
        {t('dashboard.progress.body')}
      </p>

      {/* Stepper showing where we are */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {(['downloading', 'extracting', 'installing-deps', 'installing-gh', 'starting'] as Stage[]).map(s => {
          const isCurrent = s === stage
          const done = stageOrder(s) < stageOrder(stage)
          const colour = done ? 'var(--success)' : isCurrent ? 'var(--accent)' : 'var(--text-dim)'
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
              <span
                className={isCurrent ? 'tachi-pulse-dot' : undefined}
                style={{ width: 8, height: 8, background: colour, display: 'inline-block', flexShrink: 0 }}
              />
              <span style={{ color: done ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                {stageLabel(t, s)}
              </span>
              {isCurrent && (s === 'downloading' || s === 'installing-gh') && (
                <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10 }}>
                  {formatMB(bytes)}{total ? ` / ${formatMB(total)}` : ''}
                  {pct !== null && ` (${pct}%)`}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Coarse progress bar — only meaningful for downloads with content-length */}
      {(stage === 'downloading' || stage === 'installing-gh') && pct !== null && (
        <div style={{
          height: 6,
          background: 'var(--bg-inset)',
          border: 'var(--border-width) solid var(--border)',
          overflow: 'hidden',
        }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
      )}
    </CenteredCard>
  )
}

function stageOrder(s: Stage): number {
  return ({
    idle: 0, downloading: 1, extracting: 2, 'installing-deps': 3,
    'installing-gh': 4, starting: 5, ready: 6, error: 6,
  } as const)[s] ?? 0
}

interface LaunchCardProps {
  owner:        string
  prereqs:      { node: boolean; npm: boolean } | null
  errorMessage: string | null
  onLaunch:     () => void
  onResetCache: () => void
}

function LaunchCard({ owner, prereqs, errorMessage, onLaunch, onResetCache }: LaunchCardProps) {
  const { t } = useTranslation('aeon')
  const missingNode = prereqs && !prereqs.node
  const missingNpm  = prereqs && !prereqs.npm
  const canLaunch   = prereqs?.node && prereqs?.npm

  return (
    <CenteredCard title={errorMessage ? t('dashboard.launch.errorTitle') : t('dashboard.launch.title')}>
      {errorMessage
        ? (
          <div style={{
            padding: '10px 12px',
            border: 'var(--border-width) solid var(--danger)',
            background: 'var(--bg-inset)',
            color: 'var(--danger)',
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: 'JetBrains Mono, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>{errorMessage}</div>
        )
        : (
          <p style={cardBodyText}>
            {t('dashboard.launch.body.before')} <code style={{ fontFamily: 'inherit', color: 'var(--text-primary)' }}>gh auth login</code> {t('dashboard.launch.body.after')}
          </p>
        )
      }

      {/* Prereq strip — only shown when something's missing */}
      {prereqs && (missingNode || missingNpm) && (
        <div style={{
          padding: '8px 10px',
          border: 'var(--border-width) solid var(--warning, #f59e0b)',
          background: 'var(--bg-inset)',
          fontSize: 11,
          color: 'var(--warning, #f59e0b)',
          lineHeight: 1.5,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {missingNode && <div>{t('dashboard.prereq.nodeMissing.before')} <button onClick={() => window.tachi.shell.openExternal('https://nodejs.org/en/download')} style={inlineLinkStyle}>nodejs.org ↗</button> {t('dashboard.prereq.nodeMissing.after')}</div>}
          {missingNpm  && <div>{t('dashboard.prereq.npmMissing')}</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={onLaunch}
          disabled={!canLaunch}
          style={{
            padding: '8px 14px',
            border: 'var(--border-width) solid var(--accent)',
            background: 'var(--accent)',
            color: '#ffffff',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            fontWeight: 700,
            cursor: canLaunch ? 'pointer' : 'not-allowed',
            opacity: canLaunch ? 1 : 0.5,
            letterSpacing: '0.04em',
          }}
        >
          ▶ {errorMessage ? t('dashboard.launch.retry') : t('dashboard.launch.launch')}
        </button>
        <button onClick={onResetCache} style={btnGhost} title={t('dashboard.launch.resetCacheTitle')}>
          {t('dashboard.launch.resetCache')}
        </button>
        <button onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon`)} style={btnGhost}>
          {t('dashboard.launch.yourFork')}
        </button>
      </div>

      <p style={{ ...cardBodyText, fontSize: 10, color: 'var(--text-dim)' }}>
        {t('dashboard.launch.source.before')} <code style={{ fontFamily: 'inherit' }}>aaronjmars/aeon@main</code>{t('dashboard.launch.source.after')}
      </p>
    </CenteredCard>
  )
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function CenteredCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div style={{
        maxWidth: 640,
        width: '100%',
        border: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-hard)',
      }}>
        <div style={{
          padding: '10px 14px',
          borderBottom: 'var(--border-width) solid var(--border)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          fontFamily: 'JetBrains Mono, monospace',
        }}>{title}</div>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

const cardBodyText: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--text-muted)',
  lineHeight: 1.55,
  fontFamily: 'JetBrains Mono, monospace',
}

const btnGhost: React.CSSProperties = {
  padding: '4px 8px',
  border: 'var(--border-width) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.04em',
}

const inlineLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: 'var(--accent)',
  textDecoration: 'underline',
  cursor: 'pointer',
  fontSize: 'inherit',
  fontFamily: 'inherit',
}
