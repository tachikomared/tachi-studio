// apps/desktop/src/pages/swarm/SwarmPage.tsx
//
// Top-level swarm page: three-pane brutalist dashboard (agents · kanban ·
// feed) with a route-driven repo selection.
//
// Routes handled by this component:
//   /swarm                    -> empty state, with NEW SWARM and OPEN buttons
//   /swarm/:repoPath          -> active swarm, loadAll on mount, watch wired
//
// :repoPath is URL-encoded (the gnap protocol accepts any local path, so on
// Windows the path contains backslashes and colons that must be encoded).
//
// Live updates: we subscribe to window.tachi.gnap.watch(activeRepo, ...) on
// mount and selectively re-fetch only the slice(s) the commit touched. The
// classifier inspects event.touchedFiles and maps the .gnap/* subpath to one
// of four slices (agents/tasks/runs/messages). If a single commit straddles
// multiple slices we fall back to a full loadAll(). Every event is still
// ingested into the feed so the live commit stream stays accurate.

import React, { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useSwarmStore } from '../../store/swarm.store'
import { AgentsPane } from './AgentsPane'
import { KanbanPane } from './KanbanPane'
import { FeedPane } from './FeedPane'
import { SwarmHistory } from './SwarmHistory'
import { NewSwarmDialog } from './NewSwarmDialog'
import { MessagingInbox } from './MessagingInbox'
import { useSwarmMessagesStore } from '../../store/swarm-messages.store'
import { TabTour, useTourFirstVisit, type TourStep } from '../../components/TabTour'

function buildSwarmTour(t: (key: string) => string): TourStep[] {
  return [
    { title: t('tour.step1.title'), body: t('tour.step1.body') },
    { title: t('tour.step2.title'), body: t('tour.step2.body'), selector: '[data-tour="swarm-new"]' },
    { title: t('tour.step3.title'), body: t('tour.step3.body') },
    { title: t('tour.step4.title'), body: t('tour.step4.body') },
  ]
}

export function SwarmPage() {
  const { t } = useTranslation('swarm')
  const navigate = useNavigate()
  const params   = useParams<{ repoPath?: string }>()
  const [tourOpen, setTourOpen] = useState(false)
  useTourFirstVisit('swarm', setTourOpen)
  const swarmTour = useMemo(() => buildSwarmTour(t), [t])

  // Decode the URL-encoded repo path from the route. An empty string is
  // treated the same as "no repo selected" so the empty state renders.
  const routeRepo = useMemo<string | null>(() => {
    if (!params.repoPath) return null
    try {
      const decoded = decodeURIComponent(params.repoPath)
      return decoded || null
    } catch {
      // Malformed URL component — fall back to null and let the empty
      // state render. We do not crash the route.
      return null
    }
  }, [params.repoPath])

  // Selectors. Avoid grabbing the whole store as one object — that would
  // re-render on every unrelated state change.
  const activeRepo    = useSwarmStore((s) => s.activeRepo)
  const recentRepos   = useSwarmStore((s) => s.recentRepos)
  const agents        = useSwarmStore((s) => s.agents)
  const tasks         = useSwarmStore((s) => s.tasks)
  const messages      = useSwarmStore((s) => s.messages)
  const feed          = useSwarmStore((s) => s.feed)
  const runs          = useSwarmStore((s) => s.runs)
  const loading       = useSwarmStore((s) => s.loading)
  const error         = useSwarmStore((s) => s.error)
  const setActiveRepo = useSwarmStore((s) => s.setActiveRepo)
  const addRecentRepo = useSwarmStore((s) => s.addRecentRepo)
  const loadAll          = useSwarmStore((s) => s.loadAll)
  const loadAgentsOnly   = useSwarmStore((s) => s.loadAgentsOnly)
  const loadTasksOnly    = useSwarmStore((s) => s.loadTasksOnly)
  const loadRunsOnly     = useSwarmStore((s) => s.loadRunsOnly)
  const loadMessagesOnly = useSwarmStore((s) => s.loadMessagesOnly)
  const ingestEvent      = useSwarmStore((s) => s.ingestEvent)
  const reset            = useSwarmStore((s) => s.reset)

  // Inter-agent messaging is renderer-only/in-memory. Clear the log whenever
  // the active repo changes so messages don't bleed across swarms.
  const clearMessages    = useSwarmMessagesStore((s) => s.clear)

  const [showNew, setShowNew]                 = useState(false)
  const [openDraft, setOpenDraft]             = useState('')
  const [openDraftError, setOpenDraftError]   = useState<string | null>(null)
  const [showHistory, setShowHistory]         = useState(false)
  const historyCount = useMemo(() => runs.filter((r) => r.state !== 'running').length, [runs])

  // Whenever the route's repo changes, sync the store + remember it + load.
  useEffect(() => {
    if (routeRepo) {
      if (routeRepo !== activeRepo) {
        setActiveRepo(routeRepo)
        addRecentRepo(routeRepo)
      }
      loadAll(routeRepo)
      clearMessages()
    } else {
      // Route says "no repo" — clear any leftover in-memory state.
      reset()
      clearMessages()
    }
    // We intentionally do not put `activeRepo` in the dep list — including
    // it would cause a reload loop when setActiveRepo flips activeRepo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeRepo])

  // Wire the watch subscription. For each commit, classify touched files to
  // figure out which slice changed and re-fetch only that one. If the commit
  // straddles multiple slices (or touches an unrecognised path) fall back to
  // a full loadAll. Unsubscribes on unmount or repo change.
  useEffect(() => {
    if (!routeRepo) return
    const unsubscribe = window.tachi.gnap.watch(routeRepo, (event) => {
      ingestEvent({ ...event, at: Date.now() })

      // Classify touched files into slice buckets. We normalise path
      // separators so Windows paths (".gnap\\messages\\foo.json") classify
      // the same as POSIX ones.
      const slices = new Set<'agents' | 'tasks' | 'runs' | 'messages' | 'other'>()
      for (const raw of event.touchedFiles ?? []) {
        const f = raw.replace(/\\/g, '/')
        if (f.startsWith('.gnap/messages/'))   slices.add('messages')
        else if (f.startsWith('.gnap/tasks/')) slices.add('tasks')
        else if (f.startsWith('.gnap/runs/'))  slices.add('runs')
        else if (f === '.gnap/agents.json')    slices.add('agents')
        else                                   slices.add('other')
      }

      // No recognised slice, or multiple slices touched, or anything outside
      // the four known paths — fall back to a full refresh.
      if (slices.size === 0 || slices.size > 1 || slices.has('other')) {
        loadAll(routeRepo)
        return
      }

      // Exactly one slice touched — refresh just that one.
      if (slices.has('agents'))   { loadAgentsOnly(routeRepo);   return }
      if (slices.has('tasks'))    { loadTasksOnly(routeRepo);    return }
      if (slices.has('runs'))     { loadRunsOnly(routeRepo);     return }
      if (slices.has('messages')) { loadMessagesOnly(routeRepo); return }
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeRepo])

  async function handleOpenExisting() {
    setOpenDraftError(null)
    try {
      const picked = await window.tachi.agent.pickFolder()
      if (!picked) return
      navigate(`/swarm/${encodeURIComponent(picked)}`)
    } catch (err) {
      setOpenDraftError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleOpenDraft() {
    const trimmed = openDraft.trim()
    if (!trimmed) {
      setOpenDraftError(t('empty.pathRequired'))
      return
    }
    navigate(`/swarm/${encodeURIComponent(trimmed)}`)
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!routeRepo) {
    return (
      <div style={{
        flex:          1,
        display:       'flex',
        flexDirection: 'column',
        background:    'var(--bg-base)',
        color:         'var(--text-primary)',
        fontFamily:    'JetBrains Mono, monospace',
        overflow:      'hidden',
      }}>
        <TopbarBar
          repoPath={null}
          loading={false}
          onNew={() => setShowNew(true)}
          onOpen={handleOpenExisting}
          onRefresh={null}
          error={null}
        />

        <div style={{
          flex:    1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}>
          <div style={{
            maxWidth:  640,
            width:     '100%',
            border:    '2px solid var(--border)',
            background: 'var(--bg-surface)',
            padding:   24,
            display:   'flex',
            flexDirection: 'column',
            gap:       16,
            boxShadow: 'var(--shadow-hard)',
          }}>
            <div style={{
              fontSize:      14,
              fontWeight:    700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color:         'var(--accent)',
            }}>
              {t('empty.title')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {t('empty.descBefore')} <code>.gnap/</code>{t('empty.descAfter')}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                data-tour="swarm-new"
                onClick={() => setShowNew(true)}
                style={primaryButtonStyle}
              >
                {t('actions.newSwarm')}
              </button>
              <button
                type="button"
                onClick={handleOpenExisting}
                style={ghostButtonStyle}
              >
                {t('actions.openExisting')}
              </button>
              <button
                type="button"
                onClick={() => setTourOpen(true)}
                style={ghostButtonStyle}
                title={t('actions.howToTitle')}
              >
                {t('actions.howTo')}
              </button>
            </div>

            {/* Manual-path fallback for users without a working file picker. */}
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={openDraft}
                onChange={(e) => setOpenDraft(e.target.value)}
                placeholder={t('empty.pathPlaceholder')}
                style={{
                  flex:       1,
                  padding:    '6px 8px',
                  border:     '2px solid var(--border)',
                  background: 'var(--bg-base)',
                  color:      'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize:   12,
                  outline:    'none',
                }}
              />
              <button
                type="button"
                onClick={handleOpenDraft}
                style={ghostButtonStyle}
              >
                {t('actions.open')}
              </button>
            </div>
            {openDraftError && (
              <div style={{
                padding:    '6px 8px',
                border:     '2px solid var(--danger, #ff5252)',
                color:      'var(--danger, #ff5252)',
                fontSize:   11,
              }}>
                {openDraftError}
              </div>
            )}

            {recentRepos.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                }}>
                  {t('empty.recent')}
                </div>
                {recentRepos.map((repo) => (
                  <button
                    key={repo}
                    type="button"
                    onClick={() => navigate(`/swarm/${encodeURIComponent(repo)}`)}
                    style={{
                      textAlign:  'left',
                      padding:    '4px 8px',
                      border:     'var(--border-width) solid var(--border)',
                      background: 'transparent',
                      color:      'var(--text-primary)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize:   11,
                      cursor:     'pointer',
                      overflow:   'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {repo}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {showNew && (
          <NewSwarmDialog
            onCreated={(repo) => {
              setShowNew(false)
              navigate(`/swarm/${encodeURIComponent(repo)}`)
            }}
            onCancel={() => setShowNew(false)}
          />
        )}

        <TabTour open={tourOpen} onClose={() => setTourOpen(false)} steps={swarmTour} title={t('tour.title')} />
      </div>
    )
  }

  // ── Active swarm: three-pane layout ───────────────────────────────────────
  return (
    <div style={{
      flex:          1,
      display:       'flex',
      flexDirection: 'column',
      background:    'var(--bg-base)',
      color:         'var(--text-primary)',
      fontFamily:    'JetBrains Mono, monospace',
      overflow:      'hidden',
    }}>
      <TopbarBar
        repoPath={routeRepo}
        loading={loading}
        onNew={() => setShowNew(true)}
        onOpen={handleOpenExisting}
        onRefresh={() => loadAll(routeRepo)}
        error={error}
      />

      {/* BOARD (live three-pane) vs HISTORY (past runs) switcher. */}
      <div style={{ display: 'flex', gap: 8, padding: '4px 16px', borderBottom: '2px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0 }}>
        <button type="button" onClick={() => setShowHistory(false)} style={{
          padding: '4px 12px', border: '2px solid var(--border)',
          background: !showHistory ? 'var(--accent-muted)' : 'transparent',
          color: !showHistory ? 'var(--accent-text)' : 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer',
        }}>BOARD</button>
        <button type="button" onClick={() => setShowHistory(true)} style={{
          padding: '4px 12px', border: '2px solid var(--border)',
          background: showHistory ? 'var(--accent-muted)' : 'transparent',
          color: showHistory ? 'var(--accent-text)' : 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer',
        }}>HISTORY{historyCount > 0 ? ` (${historyCount})` : ''}</button>
      </div>

      {showHistory ? (
        <SwarmHistory runs={runs} />
      ) : (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left column: agent roster on top, inter-agent messaging below. */}
        <div style={{
          width:         200,
          flexShrink:    0,
          display:       'flex',
          flexDirection: 'column',
          overflow:      'hidden',
        }}>
          <AgentsPane
            agents={agents}
            activeRepo={routeRepo}
            onChanged={() => loadAll(routeRepo)}
          />
          <MessagingInbox agents={agents} />
        </div>
        <KanbanPane
          tasks={tasks}
          agents={agents}
          activeRepo={routeRepo}
          onChanged={() => loadAll(routeRepo)}
        />
        <FeedPane feed={feed} messages={messages} />
      </div>
      )}

      {showNew && (
        <NewSwarmDialog
          onCreated={(repo) => {
            setShowNew(false)
            navigate(`/swarm/${encodeURIComponent(repo)}`)
          }}
          onCancel={() => setShowNew(false)}
        />
      )}
    </div>
  )
}

// ─── Topbar ──────────────────────────────────────────────────────────────────

interface TopbarBarProps {
  repoPath:    string | null
  loading:     boolean
  onNew:       () => void
  onOpen:      () => void
  onRefresh:   (() => void) | null
  error:       string | null
}

function TopbarBar({ repoPath, loading, onNew, onOpen, onRefresh, error }: TopbarBarProps) {
  const { t } = useTranslation('swarm')
  return (
    <div style={{
      display:       'flex',
      alignItems:    'center',
      gap:           12,
      padding:       '8px 16px',
      borderBottom:  '2px solid var(--border)',
      background:    'var(--bg-surface)',
      minHeight:     40,
      fontFamily:    'JetBrains Mono, monospace',
      fontSize:      12,
      flexShrink:    0,
    }}>
      {/* Badge */}
      <div style={{
        padding:       '2px 8px',
        border:        '2px solid var(--accent)',
        background:    'var(--accent-muted)',
        color:         'var(--accent-text)',
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}>
        SWARM
      </div>

      {/* Repo path */}
      <div style={{
        flex:       1,
        color:      'var(--text-muted)',
        overflow:   'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {repoPath ?? t('topbar.noSwarmOpen')}
        {loading && (
          <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>{t('topbar.loading')}</span>
        )}
        {error && (
          <span style={{ marginLeft: 8, color: 'var(--danger, #ff5252)' }}>
            · {error}
          </span>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={onNew} style={topbarButtonStyle}>
          {t('actions.newSwarm')}
        </button>
        <button type="button" onClick={onOpen} style={topbarButtonStyle}>
          {t('actions.open')}
        </button>
        {onRefresh && (
          <button type="button" onClick={onRefresh} style={topbarButtonStyle}>
            {t('actions.refresh')}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Shared styles ───────────────────────────────────────────────────────────

const primaryButtonStyle: React.CSSProperties = {
  padding:       '6px 14px',
  border:        '2px solid var(--accent)',
  background:    'var(--accent)',
  color:         '#ffffff',
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      11,
  fontWeight:    700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor:        'pointer',
  boxShadow:     'var(--shadow-hard)',
}

const ghostButtonStyle: React.CSSProperties = {
  padding:       '6px 14px',
  border:        '2px solid var(--border-strong)',
  background:    'var(--bg-elevated)',
  color:         'var(--text-primary)',
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      11,
  fontWeight:    700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor:        'pointer',
}

const topbarButtonStyle: React.CSSProperties = {
  padding:       '4px 10px',
  border:        '2px solid var(--border-strong)',
  background:    'var(--bg-elevated)',
  color:         'var(--text-primary)',
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      11,
  fontWeight:    700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor:        'pointer',
}
