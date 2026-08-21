// apps/desktop/src/components/PermissionOverlayHost.tsx
//
// GLOBAL renderer for pending permission cards. Mounted in App.tsx ABOVE the
// routes, so an approval is reachable from every tab.
//
// THE BUG (dogfood-4, 2026-07-26). The permission QUEUE has been app-lifetime
// store state since batch13, and the app-lifetime bridge fills it even with no
// page mounted — but the CARDS are JSX inside AgentPage. TACHI raised an approval
// mid-run, the driver navigated off /tachiapp, and the pending card had no
// renderer anywhere: main sat awaiting its resolver for 5.5 minutes. Store state
// that nothing renders is exactly as unreachable as component state that was
// thrown away.
//
// EXCLUSIVITY, not addition: this overlay renders ONLY when the mounted route
// does not already render the cards inline (`permissionOverlayVisible`). Two
// live PermissionCards for one request id would mean two ALLOW buttons for one
// resolver — the second click resolves nothing and looks broken. The inline card
// keeps its context (it sits in the transcript right after the tool call that
// asked); the overlay is the fallback everywhere else, including /agent while the
// PARALLEL GRID has replaced the log (a second, quieter instance of the same
// unreachable-card bug).
//
// One card at a time, oldest first, with a "+n waiting" line — identical rule to
// the inline surface, because answering out of arrival order is how a run gets
// approved for a call the operator never read.
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../store/agent.store'
import { useParallelAgentsStore } from '../store/parallel-agents.store'
import { PermissionCard } from '../pages/agent/PermissionCard'
import { activePermission, queuedBehind, permissionOwnerSurface } from '../pages/agent/permissionQueue'
import { permissionOverlayVisible, routeForSurface } from './permissionOverlay'
import type { PermissionDecision } from '../types/electron'

export function PermissionOverlayHost() {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const location = useLocation()

  const permissionQueue  = useAgentStore(s => s.permissionQueue)
  const settlePermission = useAgentStore(s => s.settlePermission)
  const sessionId        = useAgentStore(s => s.sessionId)
  const sessionTag       = useAgentStore(s => s.sessionTag)
  const parallelTaskCount = useParallelAgentsStore(s => s.taskOrder.length)
  const parallelTasks     = useParallelAgentsStore(s => s.tasks)

  const parallelSessionIds = React.useMemo(
    () => [...parallelTasks.values()].map(tk => tk.sessionId).filter(Boolean) as string[],
    [parallelTasks],
  )

  const visible = permissionOverlayVisible({
    pathname:          location.pathname,
    pendingCount:      permissionQueue.length,
    parallelTaskCount,
  })

  const pending = activePermission(permissionQueue)
  const behind  = queuedBehind(permissionQueue)

  // WHOSE run is this? Off-surface every known owner is worth labelling (the
  // header of the page you are on says nothing about a run). Unknown ownership
  // stays UNLABELLED rather than guessed — a wrong owner chip would have the
  // operator approve a bash command believing it belongs to a run it does not.
  const owner = permissionOwnerSurface(pending, { sessionId, sessionTag, parallelSessionIds })
  const ownerLabel = owner === 'code'
    ? t('permission.owner.code', { defaultValue: 'CODE RUN' })
    : owner === 'tachiapp'
      ? t('permission.owner.tachiapp', { defaultValue: 'TACHIAPP RUN' })
      : undefined

  const onDecide = React.useCallback((id: string, decision: PermissionDecision) => {
    settlePermission(id)
    window.tachi.agent.permissionResponse(id, decision).catch(() => {})
  }, [settlePermission])

  if (!visible || !pending) return null

  return (
    <div
      data-testid="permission-overlay"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 'min(460px, calc(100vw - 32px))',
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
        // Above every page chrome (PageTopbar/ContextMeter sit at 9999) but
        // below the Toaster (10000): a blocked run must not be hidden by a tab,
        // and must not hide a toast.
        zIndex: 9999,
        fontFamily: 'JetBrains Mono, monospace',
        boxShadow: '0 0 0 2px var(--warning), 8px 8px 0 0 rgba(0,0,0,0.45)',
        background: 'var(--bg-base)',
      }}
    >
      {/* Header: why is this floating here, and where does the run live? */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        background: 'var(--warning)',
        color: '#000',
      }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          {t('permission.overlay.title', { defaultValue: 'APPROVAL NEEDED' })}
        </span>
        <span style={{ flex: 1, fontSize: 9, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('permission.overlay.hint', { defaultValue: 'A run is blocked until you answer — this stays on every tab' })}
        </span>
        <button
          onClick={() => navigate(routeForSurface(owner))}
          title={t('permission.overlay.gotoHint', { defaultValue: 'Open the surface that owns this run to see the full transcript' })}
          style={{
            padding: '2px 8px',
            border: '2px solid #000',
            background: 'transparent',
            color: '#000',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9, fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {t('permission.overlay.goto', { defaultValue: 'GO TO RUN' })}
        </button>
      </div>

      {behind > 0 && (
        <div style={{
          padding: '3px 10px',
          background: 'rgba(245,158,11,0.12)',
          color: 'var(--warning)',
          fontSize: 9, fontWeight: 800,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}>
          {t('permission.morePending', {
            n: behind,
            defaultValue: '+{{n}} more waiting — decide this one first',
          })}
        </div>
      )}

      <PermissionCard
        key={pending.id}
        request={pending}
        onDecide={onDecide}
        ownerLabel={ownerLabel}
        ownerHint={ownerLabel
          ? t('permission.owner.hint', { defaultValue: 'This approval belongs to a run on the other tab. Answering it unblocks THAT run — the tool executes in that run\'s workspace, not this one.' })
          : undefined}
      />
    </div>
  )
}
