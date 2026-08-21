// apps/desktop/src/pages/aeon/RunDetailDrawer.tsx
//
// Live "what is it doing" view for an Aeon run. Polls /actions/runs/:runId/jobs
// every 3s while the run is in_progress to render a job/step timeline, and
// tails plain-text logs for the currently active job every 5s.
//
// Surface:
//   - Modal overlay (close on Esc, click backdrop, X button)
//   - Header: run name + status badge + "Open on GitHub" + close
//   - Left col: jobs list, each expandable to show step status timeline
//   - Right col: live-tailing log pane for the selected job
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonJobSummary, AeonRunSummary } from '../../types/electron'

interface RunDetailDrawerProps {
  owner:  string
  run:    AeonRunSummary | null
  onClose: () => void
}

const JOB_POLL_MS = 3_000
const LOG_POLL_MS = 5_000

function jobStatusColor(j: AeonJobSummary | { status: string; conclusion?: string | null }): string {
  if (j.status === 'queued' || j.status === 'waiting' || j.status === 'pending' || j.status === 'requested') return 'var(--warning)'
  if (j.status === 'in_progress') return 'var(--info)'
  if (j.conclusion === 'success') return 'var(--success)'
  if (j.conclusion === 'failure' || j.conclusion === 'timed_out') return 'var(--destructive)'
  if (j.conclusion === 'cancelled' || j.conclusion === 'skipped') return 'var(--text-dim)'
  return 'var(--text-dim)'
}

function statusLabel(j: AeonJobSummary | { status: string; conclusion?: string | null }): string {
  if (j.status === 'in_progress') return 'RUNNING'
  if (j.status === 'queued') return 'QUEUED'
  if (j.status === 'waiting' || j.status === 'pending' || j.status === 'requested') return j.status.toUpperCase()
  if (j.conclusion) return j.conclusion.toUpperCase()
  return j.status.toUpperCase()
}

function durationStr(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const s = Math.max(0, Math.floor((end - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// ── Log parser — turns the raw Actions log into a human-readable result ──────
//
// GitHub Actions log lines look like:
//   2026-05-24T23:21:05.330Z Article complete and notification sent.
//   2026-05-24T23:21:05.345Z ##[notice]Token usage — input: 844, output: 6737...
//   2026-05-24T23:21:26.221Z [main 3ad8167] chore(article): auto-commit 2026-05-24
//   2026-05-24T23:21:26.221Z  create mode 100644 articles/2026-05-24.md
//
// We strip the leading timestamps and ANSI color codes, then walk the result
// once collecting the four sections users actually care about.
interface ParsedResult {
  summary:      string | null  // The notify-message printed by the skill
  tokenUsage:   { input: number; output: number; cacheRead: number; cacheCreation: number; total: number } | null
  files:        Array<{ status: 'created' | 'modified' | 'deleted' | 'renamed'; path: string }>
  commitSha:    string | null
  commitMessage: string | null
}

function stripTimestampAndAnsi(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/, '')  // strip Actions timestamp
    .replace(/\x1B\[[0-9;]*m/g, '')                                 // strip ANSI color codes
}

function parseRunLogs(raw: string): ParsedResult {
  const result: ParsedResult = {
    summary: null,
    tokenUsage: null,
    files: [],
    commitSha: null,
    commitMessage: null,
  }
  if (!raw) return result

  const lines = raw.split('\n').map(stripTimestampAndAnsi)

  // Summary block — heuristic: the chunk between "Claude CLI" output and the
  // "##[notice]Token usage" or "##[group]Run" boundary that follows. The skill
  // typically prints a short markdown summary followed by ## Summary header.
  // We capture the contiguous non-`##[…]` block that ends just before
  // "##[notice]Token usage".
  const tokenUsageIdx = lines.findIndex(l => /^##\[notice\]Token usage/.test(l))
  if (tokenUsageIdx > 0) {
    const buf: string[] = []
    for (let i = tokenUsageIdx - 1; i >= 0; i--) {
      const l = lines[i]
      // Skip empty lines but stop at the next ##[group] or ##[notice] boundary
      // — anything before that is the skill's natural output.
      if (/^##\[(group|notice|endgroup|error|warning|debug)\]/.test(l)) break
      buf.unshift(l)
    }
    const text = buf.join('\n').trim()
    if (text.length > 0) result.summary = text
  }

  // Token usage line.
  const tokenLine = lines.find(l => /^##\[notice\]Token usage/.test(l))
  if (tokenLine) {
    const m = tokenLine.match(/input:\s*(\d+),\s*output:\s*(\d+),\s*cache_read:\s*(\d+),\s*cache_creation:\s*(\d+),\s*total:\s*(\d+)/)
    if (m) {
      result.tokenUsage = {
        input:         Number(m[1]),
        output:        Number(m[2]),
        cacheRead:     Number(m[3]),
        cacheCreation: Number(m[4]),
        total:         Number(m[5]),
      }
    }
  }

  // Auto-commit line: `[main 3ad8167] chore(article): auto-commit 2026-05-24`.
  // Capture sha + message.
  for (const l of lines) {
    const m = l.match(/^\[main ([0-9a-f]{7,40})\]\s+(.+)$/)
    if (m) {
      result.commitSha = m[1]
      result.commitMessage = m[2]
      break
    }
  }

  // File mutations from `git commit`'s short stat:
  //   `create mode 100644 articles/2026-05-24.md`
  //   `delete mode 100644 old-file.md`
  //   `rename oldpath => newpath (95%)`
  // Plus the "X files changed" header is not useful here — we want per-file.
  for (const l of lines) {
    const created = l.match(/^\s*create mode \d+\s+(.+)$/)
    if (created) { result.files.push({ status: 'created', path: created[1].trim() }); continue }
    const deleted = l.match(/^\s*delete mode \d+\s+(.+)$/)
    if (deleted) { result.files.push({ status: 'deleted', path: deleted[1].trim() }); continue }
    const renamed = l.match(/^\s*rename\s+(.+?)\s+=>\s+(.+?)(?:\s+\(\d+%\))?$/)
    if (renamed) { result.files.push({ status: 'renamed', path: `${renamed[1].trim()} → ${renamed[2].trim()}` }); continue }
    // Modified files appear as `mode change ... => ... path` or just in diffstat
    // (we don't have those in the auto-commit output, so skip).
  }
  // Dedupe in case parsing matched the same line via multiple steps.
  const seen = new Set<string>()
  result.files = result.files.filter(f => {
    const k = `${f.status}:${f.path}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return result
}

export function RunDetailDrawer({ owner, run, onClose }: RunDetailDrawerProps) {
  const { t } = useTranslation('aeon')
  const [jobs, setJobs]             = useState<AeonJobSummary[]>([])
  const [selectedJobId, setJobSel]  = useState<number | null>(null)
  const [logs, setLogs]             = useState<string>('')
  const [logsLoading, setLogsLoad]  = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [jobsLoading, setJobsLoad]  = useState(false)
  // Defaults to RESULT view when run has completed (the user mostly wants to
  // see *what was produced*, not raw shell output). Falls back to LOGS for
  // in-flight runs since RESULT requires terminal output to parse.
  const [view, setView]             = useState<'result' | 'logs'>(
    run?.status === 'completed' ? 'result' : 'logs',
  )
  const jobsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logTailRef   = useRef<HTMLPreElement | null>(null)

  // ── Load jobs ─────────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    if (!run) return
    setJobsLoad(true)
    try {
      const list = await window.tachi.aeon.listJobs(owner, run.id)
      setJobs(list)
      // Auto-select the active job, else the most recent
      if (selectedJobId == null && list.length > 0) {
        const running = list.find(j => j.status === 'in_progress')
        setJobSel(running ? running.id : list[list.length - 1].id)
      }
      setError(null)
    } catch (err: any) {
      setError(t('drawer.errors.loadJobs', { error: err?.message ?? err }))
    } finally {
      setJobsLoad(false)
    }
  }, [owner, run, selectedJobId, t])

  // ── Load logs for selected job ────────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    if (!selectedJobId) return
    setLogsLoad(true)
    try {
      const text = await window.tachi.aeon.jobLogs(owner, selectedJobId)
      setLogs(text)
      // Auto-scroll log tail to bottom on each refresh
      requestAnimationFrame(() => {
        if (logTailRef.current) {
          logTailRef.current.scrollTop = logTailRef.current.scrollHeight
        }
      })
    } catch (err: any) {
      // Don't blow up on 404 — that means logs haven't started yet
      setLogs(t('drawer.errors.logFetch', { error: err?.message ?? err }))
    } finally {
      setLogsLoad(false)
    }
  }, [owner, selectedJobId, t])

  // ── Initial load + polling lifecycle ──────────────────────────────────────
  useEffect(() => {
    if (!run) return
    loadJobs()
    // Poll jobs while run not completed; stop when completed
    const stopJobs = () => {
      if (jobsTimerRef.current) { clearInterval(jobsTimerRef.current); jobsTimerRef.current = null }
    }
    stopJobs()
    if (run.status !== 'completed') {
      jobsTimerRef.current = setInterval(() => loadJobs(), JOB_POLL_MS)
    }
    return stopJobs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id])

  useEffect(() => {
    if (!selectedJobId) return
    loadLogs()
    const stopLogs = () => {
      if (logsTimerRef.current) { clearInterval(logsTimerRef.current); logsTimerRef.current = null }
    }
    stopLogs()
    // Keep polling logs as long as that job (or its run) isn't terminal.
    const job = jobs.find(j => j.id === selectedJobId)
    if (job && job.status !== 'completed') {
      logsTimerRef.current = setInterval(() => loadLogs(), LOG_POLL_MS)
    }
    return stopLogs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobs.find(j => j.id === selectedJobId)?.status])

  // ── Close on Esc ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!run) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, onClose])

  if (!run) return null

  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? null
  const isRunning = run.status === 'in_progress' || run.status === 'queued'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '90vw',
          maxWidth: 1100,
          height: '85vh',
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-surface)',
          boxShadow: 'var(--shadow-hard)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '10px 14px',
          borderBottom: 'var(--border-width) solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}>
          <span
            className={isRunning ? 'tachi-pulse-dot' : undefined}
            style={{
              width: 8, height: 8,
              background: jobStatusColor({ status: run.status, conclusion: run.conclusion }),
              flexShrink: 0,
            }}
          />
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '0.04em',
          }} title={run.name}>
            {run.name}
          </span>
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            border: `2px solid ${jobStatusColor({ status: run.status, conclusion: run.conclusion })}`,
            color: jobStatusColor({ status: run.status, conclusion: run.conclusion }),
            letterSpacing: '0.08em',
          }}>
            {statusLabel({ status: run.status, conclusion: run.conclusion })}
          </span>
          <span style={{ flex: 1 }} />
          {/* RESULT / LOGS toggle — only meaningful on completed runs, but we
              show it on in-flight runs too as a hint that a parsed summary
              will appear once the run finishes. */}
          <div style={{ display: 'flex', border: 'var(--border-width) solid var(--border)' }}>
            <button
              onClick={() => setView('result')}
              disabled={run.status !== 'completed'}
              title={run.status === 'completed'
                ? t('drawer.resultTitle')
                : t('drawer.resultTitleDisabled')}
              style={{
                padding: '4px 10px',
                border: 'none',
                background: view === 'result' ? 'var(--accent)' : 'transparent',
                color: view === 'result' ? '#ffffff' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: 700,
                cursor: run.status === 'completed' ? 'pointer' : 'not-allowed',
                opacity: run.status === 'completed' ? 1 : 0.5,
                letterSpacing: '0.04em',
              }}
            >{t('drawer.tabs.result')}</button>
            <button
              onClick={() => setView('logs')}
              style={{
                padding: '4px 10px',
                border: 'none',
                borderLeft: 'var(--border-width) solid var(--border)',
                background: view === 'logs' ? 'var(--accent)' : 'transparent',
                color: view === 'logs' ? '#ffffff' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >{t('drawer.tabs.logs')}</button>
          </div>
          <button
            onClick={loadJobs}
            disabled={jobsLoading}
            style={{
              padding: '4px 8px',
              border: 'var(--border-width) solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              cursor: 'pointer',
              opacity: jobsLoading ? 0.6 : 1,
            }}
            title={t('drawer.refresh')}
          >
            ⟳ {jobsLoading ? '…' : t('drawer.reload')}
          </button>
          <button
            onClick={() => window.tachi.shell.openExternal(run.html_url)}
            style={{
              padding: '4px 8px',
              border: 'var(--border-width) solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              cursor: 'pointer',
            }}
            title={t('drawer.openOnGithubTitle')}
          >
            {t('drawer.openOnGithub')}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '4px 10px',
              border: 'var(--border-width) solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={t('drawer.closeTitle')}
            aria-label={t('drawer.close')}
          >
            ×
          </button>
        </div>

        {error && (
          <div style={{
            padding: '6px 14px',
            borderBottom: 'var(--border-width) solid var(--border)',
            fontSize: 11,
            color: 'var(--destructive)',
            flexShrink: 0,
          }}>
            {error}
          </div>
        )}

        {/* Body: RESULT view (parsed summary) OR LOGS view (jobs + raw logs) */}
        {view === 'result' && run.status === 'completed' && (
          <ResultPanel owner={owner} run={run} logs={logs} />
        )}
        <div style={{
          flex: 1, display: view === 'logs' || run.status !== 'completed' ? 'flex' : 'none', minHeight: 0,
        }}>
          {/* Jobs list */}
          <div style={{
            width: 320,
            flexShrink: 0,
            borderRight: 'var(--border-width) solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'auto',
          }}>
            <div style={{
              padding: '8px 12px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              borderBottom: 'var(--border-width) solid var(--border)',
              flexShrink: 0,
            }}>
              {t('drawer.jobs.title', { count: jobs.length })}
            </div>
            {jobs.length === 0 && !jobsLoading && (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>
                {isRunning ? t('drawer.jobs.waiting') : t('drawer.jobs.none')}
              </div>
            )}
            {jobs.map(job => {
              const isSel = job.id === selectedJobId
              return (
                <div key={job.id} style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
                  <button
                    onClick={() => setJobSel(job.id)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      border: 'none',
                      background: isSel ? 'var(--bg-elevated)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className={job.status === 'in_progress' ? 'tachi-pulse-dot' : undefined}
                        style={{ width: 6, height: 6, background: jobStatusColor(job), flexShrink: 0 }}
                      />
                      <span style={{
                        flex: 1,
                        fontSize: 11,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }} title={job.name}>
                        {job.name}
                      </span>
                      <span style={{
                        fontSize: 9,
                        color: jobStatusColor(job),
                        letterSpacing: '0.06em',
                        fontWeight: 700,
                      }}>
                        {statusLabel(job)}
                      </span>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', paddingLeft: 12 }}>
                      {durationStr(job.started_at, job.completed_at)}
                    </div>
                  </button>
                  {/* Step list — always shown for selected, collapsed for others */}
                  {isSel && job.steps.length > 0 && (
                    <div style={{ padding: '4px 12px 8px 26px' }}>
                      {job.steps.map(step => (
                        <div key={step.number} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '2px 0',
                          fontSize: 10,
                          fontFamily: 'JetBrains Mono, monospace',
                        }}>
                          <span
                            className={step.status === 'in_progress' ? 'tachi-pulse-dot' : undefined}
                            style={{ width: 4, height: 4, background: jobStatusColor(step), flexShrink: 0 }}
                          />
                          <span style={{
                            flex: 1,
                            color: step.status === 'completed' && step.conclusion === 'success' ? 'var(--text-muted)' : 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }} title={step.name}>
                            {step.number}. {step.name}
                          </span>
                          <span style={{ color: 'var(--text-dim)', fontSize: 9, flexShrink: 0 }}>
                            {durationStr(step.started_at, step.completed_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Log tail */}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: '#0a0a0a',
          }}>
            <div style={{
              padding: '8px 12px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              borderBottom: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-surface)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span>{t('drawer.logs.title')}</span>
              {selectedJob && (
                <>
                  <span style={{ color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                    {selectedJob.name}
                  </span>
                  {selectedJob.status === 'in_progress' && (
                    <span style={{ color: 'var(--info)', fontSize: 9, letterSpacing: '0.08em' }}>
                      {t('drawer.logs.live')}
                    </span>
                  )}
                </>
              )}
              <span style={{ flex: 1 }} />
              {logsLoading && (
                <span style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400 }}>{t('drawer.logs.fetching')}</span>
              )}
            </div>
            <pre
              ref={logTailRef}
              style={{
                flex: 1,
                margin: 0,
                padding: '10px 12px',
                fontSize: 10,
                lineHeight: 1.5,
                color: '#d4d4d4',
                fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                overflow: 'auto',
              }}
            >
              {selectedJob
                ? (logs || (selectedJob.status === 'queued' ? t('drawer.logs.queued') : t('drawer.logs.noOutput')))
                : t('drawer.logs.selectJob')}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultPanel — human-language summary of a completed Aeon run.
//
// Reads the same `logs` blob the Logs view already fetched and parses out the
// skill's notify message, files committed, and token usage. Links each file
// to its GitHub URL on the user's fork so they can read the result in one
// click.
// ─────────────────────────────────────────────────────────────────────────────
interface ResultPanelProps {
  owner: string
  run:   AeonRunSummary
  logs:  string
}

function ResultPanel({ owner, run, logs }: ResultPanelProps) {
  const { t } = useTranslation('aeon')
  const parsed = React.useMemo(() => parseRunLogs(logs), [logs])

  const sectionStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: 'var(--border-width) solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  }
  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    fontFamily: 'JetBrains Mono, monospace',
  }

  // Without logs (e.g. fetch hasn't returned yet) show a skeleton state.
  // Once logs arrive parseRunLogs will populate the parsed values and the
  // memo re-runs — no manual refetch needed.
  if (!logs) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: 24, color: 'var(--text-dim)', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
        {t('drawer.result.loadingLogs')}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* What the skill produced — the notify summary block */}
      <div style={sectionStyle}>
        <span style={sectionHeaderStyle}>{t('drawer.result.whatItDid')}</span>
        {parsed.summary
          ? (
            <pre style={{
              margin: 0,
              padding: 12,
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-inset)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>{parsed.summary}</pre>
          )
          : (
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {t('drawer.result.noSummary')}
            </p>
          )
        }
      </div>

      {/* Files committed — clickable into GitHub */}
      <div style={sectionStyle}>
        <span style={sectionHeaderStyle}>
          {parsed.files.length > 0
            ? t('drawer.result.filesProducedCount', { count: parsed.files.length })
            : t('drawer.result.filesProduced')}
        </span>
        {parsed.files.length === 0 && (
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {t('drawer.result.noFiles')}
          </p>
        )}
        {parsed.files.map(file => {
          const url = `https://github.com/${owner}/aeon/blob/main/${file.path.split(' → ').pop() ?? file.path}`
          const statusBadge = file.status === 'created' ? '+'
            : file.status === 'deleted' ? '−'
            : file.status === 'renamed' ? '↪'
            : '~'
          const statusColor = file.status === 'created' ? 'var(--success)'
            : file.status === 'deleted' ? 'var(--danger)'
            : file.status === 'renamed' ? 'var(--accent)'
            : 'var(--warning)'
          return (
            <button
              key={`${file.status}-${file.path}`}
              onClick={() => window.tachi.shell.openExternal(url)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              title={t('drawer.result.openFileTitle', { path: file.path })}
            >
              <span style={{ color: statusColor, fontWeight: 700, fontSize: 12, width: 12 }}>{statusBadge}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.path}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{t('drawer.result.open')}</span>
            </button>
          )
        })}
      </div>

      {/* Commit reference */}
      {parsed.commitSha && (
        <div style={sectionStyle}>
          <span style={sectionHeaderStyle}>{t('drawer.result.commit')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
            <code style={{
              padding: '2px 6px',
              background: 'var(--bg-inset)',
              border: 'var(--border-width) solid var(--border)',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}>{parsed.commitSha.slice(0, 7)}</code>
            <span style={{ flex: 1, color: 'var(--text-muted)' }}>{parsed.commitMessage}</span>
            <button
              onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon/commit/${parsed.commitSha}`)}
              style={{
                padding: '3px 8px',
                border: 'var(--border-width) solid var(--border)',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9,
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >{t('drawer.result.openShort')}</button>
          </div>
        </div>
      )}

      {/* Token usage */}
      {parsed.tokenUsage && (
        <div style={sectionStyle}>
          <span style={sectionHeaderStyle}>{t('drawer.result.tokenUsage')}</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
            {(['input', 'output', 'cacheRead', 'cacheCreation', 'total'] as const).map(k => {
              const label = k === 'cacheRead' ? t('drawer.result.tokens.cacheRead')
                : k === 'cacheCreation' ? t('drawer.result.tokens.cacheCreation')
                : k
              return (
                <div key={k} style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '6px 8px',
                  border: 'var(--border-width) solid var(--border)',
                  background: k === 'total' ? 'var(--bg-inset)' : 'transparent',
                }}>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: k === 'total' ? 700 : 400 }}>
                    {(parsed.tokenUsage?.[k] ?? 0).toLocaleString()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Footer — links to the broader fork dashboard so users can browse history */}
      <div style={{ ...sectionStyle, borderBottom: 'none', flex: 1 }}>
        <span style={sectionHeaderStyle}>{t('drawer.result.browseOutputs')}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon/tree/main/dashboard/outputs`)}
            style={{
              padding: '5px 9px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
            title={t('drawer.result.outputsTitle')}
          >{t('drawer.result.links.outputs')}</button>
          <button
            onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon/tree/main/articles`)}
            style={{
              padding: '5px 9px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >{t('drawer.result.links.articles')}</button>
          <button
            onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon/commits/main`)}
            style={{
              padding: '5px 9px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >{t('drawer.result.links.commits')}</button>
          <button
            onClick={() => window.tachi.shell.openExternal(run.html_url)}
            style={{
              padding: '5px 9px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >{t('drawer.result.links.thisRun')}</button>
        </div>
      </div>
    </div>
  )
}
