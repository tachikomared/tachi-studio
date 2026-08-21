// apps/desktop/src/pages/aeon/SkillsList.tsx
import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonWorkflowSummary, AeonSkillAnalyticsMap } from '../../types/electron'
import { showToast } from '../../components/Toaster'

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '3px 6px',
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  outline: 'none',
}

interface SkillsListProps {
  owner: string
  onRunTriggered?: () => void
}

export function SkillsList({ owner, onRunTriggered }: SkillsListProps) {
  const { t } = useTranslation('aeon')
  const [workflows, setWorkflows] = useState<AeonWorkflowSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [triggering, setTriggering] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Track Actions-permissions state so we can show "Enable Actions" when the
  // GitHub fork came with them disabled (the usual cause of "No workflows found").
  const [actionsEnabled, setActionsEnabled] = useState<boolean | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [analytics, setAnalytics] = useState<AeonSkillAnalyticsMap>({})

  const load = useCallback(async () => {
    if (!owner) return
    setLoading(true)
    setError(null)
    try {
      const list = await window.tachi.aeon.listWorkflows(owner)
      setWorkflows(list)
      // If GitHub returned no workflows, probe permissions — the most common
      // cause is that Actions are still disabled on the fork.
      if (list.length === 0) {
        try {
          const perm = await window.tachi.aeon.actionsStatus(owner)
          setActionsEnabled(perm.enabled)
        } catch {
          setActionsEnabled(null)
        }
      } else {
        setActionsEnabled(true)
      }
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setLoading(false)
    }
  }, [owner])

  useEffect(() => { load() }, [load])

  // Load analytics whenever owner changes. Silently degraded — if the
  // dashboard isn't running or the fork is older, analytics stays empty ({})
  // and the columns show [--].
  useEffect(() => {
    if (!owner) return
    let cancelled = false
    window.tachi.aeon.getSkillAnalytics(owner)
      .then(data => { if (!cancelled) setAnalytics(data) })
      .catch(() => { /* degrade silently */ })
    return () => { cancelled = true }
  }, [owner])

  async function handleEnableActions() {
    setEnabling(true)
    setError(null)
    try {
      await window.tachi.aeon.enableActions(owner)
      showToast({ kind: 'success', text: t('skills.toast.actionsEnabled') })
      // Right after enabling, also try a sync so any new upstream skills land
      // in one shot, then reload the workflow list. Sync may fail harmlessly
      // (e.g. already up to date) — we surface the error but still reload.
      try {
        const res = await window.tachi.aeon.syncFork(owner)
        if (res.merge_type !== 'none') {
          showToast({ kind: 'info', text: t('skills.toast.synced', { mergeType: res.merge_type }) })
        }
      } catch (err: any) {
        // Non-fatal: just log to console — the enable still succeeded.
        console.warn('[SkillsList] post-enable sync failed:', err)
      }
      // Give GitHub a beat to register the workflow files
      await new Promise(r => setTimeout(r, 1500))
      await load()
    } catch (err: any) {
      setError(t('skills.errors.enableFailed', { error: err?.message ?? err }))
    } finally {
      setEnabling(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      const res = await window.tachi.aeon.syncFork(owner)
      showToast({
        kind: res.merge_type === 'none' ? 'info' : 'success',
        text: res.merge_type === 'none'
          ? t('skills.toast.upToDate')
          : t('skills.toast.synced', { mergeType: res.merge_type }),
      })
      await new Promise(r => setTimeout(r, 1000))
      await load()
    } catch (err: any) {
      setError(t('skills.errors.syncFailed', { error: err?.message ?? err }))
    } finally {
      setSyncing(false)
    }
  }

  async function handleTrigger(workflow: AeonWorkflowSummary) {
    setTriggering(workflow.id)
    try {
      await window.tachi.aeon.trigger(owner, workflow.path)
      onRunTriggered?.()
    } catch (err: any) {
      setError(t('skills.errors.triggerFailed', { name: workflow.name, error: err?.message ?? err }))
    } finally {
      setTriggering(null)
    }
  }

  const filtered = filter
    ? workflows.filter(w => w.name.toLowerCase().includes(filter.toLowerCase()))
    : workflows

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span>{t('skills.title', { filtered: filtered.length, total: workflows.length })}</span>
        <input
          style={inputStyle}
          placeholder={t('skills.filterPlaceholder')}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button
          onClick={load}
          style={{
            padding: '3px 8px',
            border: 'var(--border-width) solid var(--border)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title={t('skills.refresh')}
        >
          ⟳
        </button>
      </div>

      {error && (
        <div style={{
          padding: '6px 12px',
          fontSize: 11,
          color: 'var(--destructive)',
          fontFamily: 'JetBrains Mono, monospace',
          borderBottom: 'var(--border-width) solid var(--border)',
          flexShrink: 0,
        }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {t('skills.loading')}
          </div>
        )}
        {!loading && filtered.length === 0 && workflows.length === 0 && (
          <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{
              margin: 0,
              fontSize: 11,
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              lineHeight: 1.5,
            }}>
              {actionsEnabled === false ? (
                <>
                  <strong>{t('skills.empty.actionsDisabled.title')}</strong><br />
                  {t('skills.empty.actionsDisabled.body')}
                </>
              ) : (
                <>
                  <strong>{t('skills.empty.noWorkflows.title')}</strong><br />
                  {t('skills.empty.noWorkflows.body')}
                </>
              )}
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {actionsEnabled === false && (
                <button
                  onClick={handleEnableActions}
                  disabled={enabling}
                  style={{
                    padding: '6px 10px',
                    border: 'var(--border-width) solid var(--accent)',
                    background: 'var(--accent)',
                    color: '#ffffff',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: enabling ? 'default' : 'pointer',
                    letterSpacing: '0.04em',
                    opacity: enabling ? 0.6 : 1,
                  }}
                >
                  {enabling ? t('skills.empty.enabling') : t('skills.empty.enableActions')}
                </button>
              )}
              <button
                onClick={handleSync}
                disabled={syncing}
                style={{
                  padding: '6px 10px',
                  border: 'var(--border-width) solid var(--border)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: syncing ? 'default' : 'pointer',
                  letterSpacing: '0.04em',
                  opacity: syncing ? 0.6 : 1,
                }}
              >
                {syncing ? t('skills.empty.syncing') : t('skills.empty.syncFromUpstream')}
              </button>
              <button
                onClick={() => window.tachi.shell.openExternal(`https://github.com/${owner}/aeon/actions`)}
                style={{
                  padding: '6px 10px',
                  border: 'var(--border-width) solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                }}
              >
                {t('skills.empty.openActionsTab')}
              </button>
            </div>
          </div>
        )}
        {!loading && filtered.length === 0 && workflows.length > 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
            {t('skills.noMatches')}
          </div>
        )}
        {filtered.map(workflow => {
          const isActive = workflow.state === 'active'
          const dotColor = isActive ? 'var(--success)' : 'var(--text-dim)'
          const isTriggering = triggering === workflow.id
          // Derive a lookup key: workflow name without .yml extension (matches
          // Aeon's analytics key format, e.g. "run_skill_name").
          const analyticsKey = workflow.name.replace(/\.yml$/, '')
          const stat = analytics[analyticsKey] ?? analytics[workflow.name] ?? null

          return (
            <div
              key={workflow.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                borderBottom: 'var(--border-width) solid var(--border)',
              }}
            >
              {/* State dot */}
              <div style={{ width: 5, height: 5, background: dotColor, flexShrink: 0 }} />

              {/* Name */}
              <span style={{
                flex: 1,
                fontSize: 11,
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }} title={workflow.name}>
                {workflow.name}
              </span>

              {/* Analytics columns — success rate, streak, avg duration */}
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: stat ? 'var(--text-primary)' : 'var(--text-dim)',
                  flexShrink: 0,
                  minWidth: 52,
                  textAlign: 'right',
                }}
                title={t('skills.analytics.successRate')}
              >
                {stat ? `[OK ${Math.round(stat.successRate)}%]` : '[--]'}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: stat ? 'var(--text-primary)' : 'var(--text-dim)',
                  flexShrink: 0,
                  minWidth: 44,
                  textAlign: 'right',
                }}
                title={t('skills.analytics.streak')}
              >
                {stat ? `[N=${stat.streak}]` : '[--]'}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: stat ? 'var(--text-primary)' : 'var(--text-dim)',
                  flexShrink: 0,
                  minWidth: 52,
                  textAlign: 'right',
                }}
                title={t('skills.analytics.avgDuration')}
              >
                {stat ? `[~${stat.avgDurationMin.toFixed(1)}m]` : '[--]'}
              </span>

              {/* Run button */}
              <button
                disabled={isTriggering || !isActive}
                onClick={() => handleTrigger(workflow)}
                style={{
                  padding: '3px 8px',
                  border: 'var(--border-width) solid var(--border)',
                  background: isActive ? 'var(--bg-elevated)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-dim)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  cursor: isActive ? 'pointer' : 'default',
                  flexShrink: 0,
                  opacity: isTriggering ? 0.6 : 1,
                }}
                title={isActive ? t('skills.run.triggerTitle') : t('skills.run.disabledTitle')}
              >
                {isTriggering ? '…' : t('skills.run.label')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
