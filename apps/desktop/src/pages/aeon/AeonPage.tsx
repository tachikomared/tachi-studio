// apps/desktop/src/pages/aeon/AeonPage.tsx
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { useAeonStore } from '../../store/aeon.store'
import type { AeonForkStatus, AeonSyncStatus } from '../../types/electron'
import { showToast } from '../../components/Toaster'
import { AuthCard } from './AuthCard'
import { RepoSetupCard } from './RepoSetupCard'
import { ProviderCard } from './ProviderCard'
import { ChannelsCard } from './ChannelsCard'
import { SkillsList } from './SkillsList'
import { RunsTable } from './RunsTable'
import { AeonTaskComposer } from './AeonTaskComposer'
import { AeonDashboardView } from './AeonDashboardView'
import { MemorySearch } from './MemorySearch'

// ─── State types ──────────────────────────────────────────────────────────────
type PageState = 'loading' | 'gh-not-installed' | 'not-authed' | 'authed-but-no-fork' | 'ready'

// ─── Not-installed view ───────────────────────────────────────────────────────
function GhNotInstalledView() {
  const { t } = useTranslation('aeon')
  return (
    <div style={{
      maxWidth: 480,
      margin: '48px auto',
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-hard)',
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: 'var(--border-width) solid var(--border)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.1em',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        {t('ghNotInstalled.header')}
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {t('ghNotInstalled.requires.before')} <strong style={{ color: 'var(--text-primary)' }}>GitHub CLI</strong> (<code style={{ fontFamily: 'JetBrains Mono, monospace' }}>gh</code>).
          {' '}{t('ghNotInstalled.requires.installFrom')}{' '}
          <button
            onClick={() => window.tachi.shell.openExternal('https://cli.github.com')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-text)',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            cli.github.com
          </button>
          {' '}{t('ghNotInstalled.requires.thenRestart')}
        </p>
        <div style={{
          padding: '8px 10px',
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-elevated)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: 'var(--text-dim)',
        }}>
          # Windows (winget)<br />
          winget install --id GitHub.cli<br /><br />
          # macOS (brew)<br />
          brew install gh
        </div>
      </div>
    </div>
  )
}

// ─── Intro block ──────────────────────────────────────────────────────────────
// Plain-language framing for normal users, mirroring the Swarm tab's explainer
// card (accent uppercase title + muted body inside a hard-shadow card).
function AeonIntroBlock({ owner }: { owner: string }) {
  const { t } = useTranslation('aeon')
  return (
    <div style={{
      border: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-hard)',
      padding: '12px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      flexShrink: 0,
    }}>
      <div style={{
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--accent)',
      }}>
        {t('intro.title', { defaultValue: 'AEON — YOUR AGENT IN THE CLOUD' })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {t('intro.body', {
          defaultValue: 'Aeon is your agent working for you in the cloud, even when this app is closed. It lives in your own GitHub fork ({{owner}}/aeon) and runs skills — research, monitoring, writing — autonomously via GitHub Actions, on a schedule or whenever you dispatch a task. Results land in Recent runs below and in any channel you connect (Telegram, Discord, Slack, email).',
          owner,
        })}
      </div>
    </div>
  )
}

// ─── Collapsible one-time setup section ───────────────────────────────────────
// The secrets/channels plumbing, demoted below the actual work surface. This
// view only renders once the fork exists (pageState === 'ready'), i.e. the
// one-time setup already happened — so it starts collapsed.
function SetupSection({ owner }: { owner: string }) {
  const { t } = useTranslation('aeon')
  const [open, setOpen] = useState(false)
  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-hard)',
      flexShrink: 0,
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          border: 'none',
          borderBottom: open ? 'var(--border-width) solid var(--border)' : 'none',
          background: 'var(--bg-inset)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}>
          {open ? '▾' : '▸'} {t('setup.header', { defaultValue: 'SETUP (ONE-TIME)' })}
        </span>
        <span style={{ flex: 1, fontSize: 9, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('setup.hint', { defaultValue: 'Provider secrets + notification channels. Already done if your runs work.' })}
        </span>
      </button>
      {open && (
        <div style={{
          padding: 12,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          alignItems: 'start',
        }}>
          <ProviderCard owner={owner} />
          <ChannelsCard owner={owner} />
        </div>
      )}
    </div>
  )
}

// ─── Ready main UI ────────────────────────────────────────────────────────────
function AeonReadyView({ owner }: { owner: string }) {
  const [refreshSignal, setRefreshSignal] = useState(0)
  const bumpRefresh = () => setRefreshSignal(s => s + 1)
  // When the user clicks "Dashboard" in the sidebar, the home grid is replaced
  // with the embedded Next.js dashboard (or its setup card if not running).
  const view = useAeonStore(s => s.view)
  if (view === 'dashboard') {
    return <AeonDashboardView owner={owner} />
  }

  return (
    <div style={{
      flex: 1,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      overflow: 'auto',
      minHeight: 0,
    }}>
      {/* Plain-language framing first — what Aeon is, for a normal user */}
      <AeonIntroBlock owner={owner} />

      {/* Work surface: skills + memory left, composer + runs kanban right.
          Renders ABOVE the setup plumbing — runs are the point of the page. */}
      <div style={{
        flex: 1,
        minHeight: 320,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 200, gap: 12 }}>
          <SkillsList owner={owner} onRunTriggered={bumpRefresh} />
          <MemorySearch />
        </div>

        {/* Task composer on top, runs table below.
            Nested flex layout — composer is auto-sized, runs table flexes. */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 12 }}>
          <AeonTaskComposer owner={owner} onDispatched={bumpRefresh} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <RunsTable owner={owner} refreshSignal={refreshSignal} />
          </div>
        </div>
      </div>

      {/* One-time plumbing, demoted + collapsed (fork exists → configured) */}
      <SetupSection owner={owner} />
    </div>
  )
}

// ── E2: Fork-behind badge ─────────────────────────────────────────────────────
const SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

interface ForkBehindBadgeProps {
  syncStatus: AeonSyncStatus | null
  syncing: boolean
  onSync: () => void
}

function ForkBehindBadge({ syncStatus, syncing, onSync }: ForkBehindBadgeProps) {
  const { t } = useTranslation('aeon')
  if (!syncStatus || syncStatus.behind === 0) return null
  const label = syncing ? t('forkBadge.syncing') : t('forkBadge.behind', { count: syncStatus.behind })
  return (
    <button
      onClick={onSync}
      disabled={syncing}
      title={t('forkBadge.title', { count: syncStatus.behind })}
      style={{
        padding: '3px 8px',
        border: '2px solid var(--warning, #e6a817)',
        background: 'transparent',
        color: 'var(--warning, #e6a817)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        cursor: syncing ? 'default' : 'pointer',
        opacity: syncing ? 0.6 : 1,
        borderRadius: 0,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function AeonPage() {
  const { t } = useTranslation('aeon')
  const {
    ghInstalled, ghAuthenticated, ghUsername, forked,
    setGhStatus, setForked,
  } = useAeonStore()

  const [pageState, setPageState] = useState<PageState>('loading')
  const [forkOwner, setForkOwner] = useState<string | undefined>(undefined)
  // E2: fork-behind polling state
  const [syncStatus, setSyncStatus] = useState<AeonSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = useCallback(async () => {
    setPageState('loading')
    try {
      const status = await window.tachi.aeon.ghStatus()
      setGhStatus({
        ghInstalled: status.installed,
        ghAuthenticated: status.authenticated,
        ghUsername: status.username,
      })

      if (!status.installed) {
        setPageState('gh-not-installed')
        return
      }

      if (!status.authenticated) {
        setPageState('not-authed')
        return
      }

      // Authenticated — check for fork
      const fork = await window.tachi.aeon.detectFork()
      setForked(fork.forked)
      if (!fork.forked) {
        setPageState('authed-but-no-fork')
        return
      }

      setForkOwner(fork.owner)
      setPageState('ready')
    } catch (err) {
      console.warn('[AeonPage] status check failed:', err)
      setPageState('gh-not-installed')
    }
  }, [setGhStatus, setForked])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  // E2: Poll /api/sync every 5 min when page is ready. Starts immediately on
  // pageState → 'ready', clears on unmount or when page leaves ready state.
  useEffect(() => {
    if (pageState !== 'ready') return
    async function pollSyncStatus() {
      try {
        const status = await window.tachi.aeon.getSyncStatus()
        setSyncStatus(status)
      } catch {
        // Silently ignore — dashboard may not be running yet
      }
    }
    pollSyncStatus()
    const id = setInterval(pollSyncStatus, SYNC_POLL_INTERVAL_MS)
    syncIntervalRef.current = id
    return () => {
      clearInterval(id)
      syncIntervalRef.current = null
    }
  }, [pageState])

  async function handleSyncFork() {
    if (!forkOwner || syncing) return
    setSyncing(true)
    try {
      const res = await window.tachi.aeon.syncFork(forkOwner)
      showToast({
        kind: res.merge_type === 'none' ? 'info' : 'success',
        text: res.merge_type === 'none'
          ? t('skills.toast.upToDate')
          : t('skills.toast.synced', { mergeType: res.merge_type }),
      })
      // Re-poll immediately after sync so badge clears
      try {
        const status = await window.tachi.aeon.getSyncStatus()
        setSyncStatus(status)
      } catch { /* ignore */ }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('skills.toast.syncFailed', { error: msg }) })
    } finally {
      setSyncing(false)
    }
  }

  function handleAuthed() {
    // Re-run full status refresh after login
    refreshStatus()
  }

  function handleForked(fork: AeonForkStatus) {
    setForked(true)
    setForkOwner(fork.owner)
    setPageState('ready')
  }

  const topbarSession = forkOwner ? `${forkOwner}/aeon` : ghUsername ? `${ghUsername}` : undefined

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-base)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <PageTopbar
        section="Aeon"
        sessionName={topbarSession}
        badge="Aeon"
        onNew={pageState === 'ready' ? () => {} : undefined}
      />
      {pageState === 'ready' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 12px',
          borderBottom: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-surface)',
          gap: 8,
          flexShrink: 0,
          minHeight: 28,
        }}>
          <ForkBehindBadge
            syncStatus={syncStatus}
            syncing={syncing}
            onSync={handleSyncFork}
          />
        </div>
      )}

      {pageState === 'loading' && (
        <div style={{ padding: 16, fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
          {t('page.checkingStatus')}
        </div>
      )}

      {pageState === 'gh-not-installed' && <GhNotInstalledView />}

      {pageState === 'not-authed' && (
        <AuthCard onAuthed={handleAuthed} />
      )}

      {pageState === 'authed-but-no-fork' && (
        <RepoSetupCard onForked={handleForked} />
      )}

      {pageState === 'ready' && forkOwner && (
        <AeonReadyView owner={forkOwner} />
      )}
    </div>
  )
}
