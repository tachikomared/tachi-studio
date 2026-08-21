// apps/desktop/src/pages/agent/SlashCommandCard.tsx
//
// Sprint F3 — Brutalist slash-command plan cards.
// Renders TroubleshootPlan, RefactorPlan, ReviewReport, or PlanArtifact
// returned by the agent inside <tachi-plan> tags.
//
// Design: §4 + §5 of docs/SPRINT-F-DESIGN.md
// CSS vars: --accent, --success, --warning, --danger, --bg-surface, --bg-elevated,
//           --border, --text-primary, --text-muted, --text-dim, --shadow-soft

import React from 'react'
import { useTranslation } from 'react-i18next'
import type {
  SlashCommandResult,
  SlashCardStatus,
  TroubleshootPlan,
  RefactorPlan,
  ReviewReport,
  PlanArtifact,
} from '../../types/slash-commands'

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SlashCommandCardProps {
  plan: SlashCommandResult | null
  status: SlashCardStatus
  onApprove: () => void
  onApply: () => void
  onCancel: () => void
}

// ── Shared style constants ────────────────────────────────────────────────────

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}

const SHELL: React.CSSProperties = {
  ...MONO,
  border: '2px solid var(--accent)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-soft)',
  borderRadius: 0,
  padding: 12,
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  marginBottom: 4,
  ...MONO,
}

// ── Status badge ──────────────────────────────────────────────────────────────

function badgeColor(status: SlashCardStatus): string {
  if (status === 'pending-review') return 'var(--accent)'
  if (status === 'approved')       return 'var(--success)'
  if (status === 'applied')        return 'var(--success)'
  return 'var(--danger)' // cancelled
}

function badgeLabelKey(status: SlashCardStatus): string {
  if (status === 'pending-review') return 'slash.status.pendingReview'
  if (status === 'approved')       return 'slash.status.approved'
  if (status === 'applied')        return 'slash.status.applied'
  return 'slash.status.cancelled'
}

function StatusBadge({ status }: { status: SlashCardStatus }) {
  const { t } = useTranslation('agent')
  const color = badgeColor(status)
  return (
    <span
      style={{
        ...MONO,
        border: `var(--border-width) solid ${color}`,
        color,
        fontSize: 10,
        padding: '2px 6px',
        letterSpacing: '0.08em',
        flexShrink: 0,
      }}
    >
      {t(badgeLabelKey(status))}
    </span>
  )
}

// ── Card header ───────────────────────────────────────────────────────────────

function CardHeader({ command, status }: { command: string; status: SlashCardStatus }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
        gap: 8,
      }}
    >
      <span
        style={{
          ...MONO,
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text-primary)',
          letterSpacing: '0.04em',
        }}
      >
        [/{command}]
      </span>
      <StatusBadge status={status} />
    </div>
  )
}

// ── Risk / impact badge (inline) ──────────────────────────────────────────────

type RiskLevel = 'low' | 'medium' | 'high'

function riskColor(risk: RiskLevel): string {
  if (risk === 'low')    return 'var(--success)'
  if (risk === 'medium') return 'var(--warning)'
  return 'var(--danger)'
}

function riskLabelKey(risk: RiskLevel): string {
  if (risk === 'low')    return 'slash.risk.low'
  if (risk === 'medium') return 'slash.risk.med'
  return 'slash.risk.high'
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const { t } = useTranslation('agent')
  const color = riskColor(risk)
  return (
    <span
      style={{
        ...MONO,
        border: `var(--border-width) solid ${color}`,
        color,
        fontSize: 9,
        padding: '1px 5px',
        letterSpacing: '0.06em',
        flexShrink: 0,
      }}
    >
      {t(riskLabelKey(risk))}
    </span>
  )
}

// ── Action buttons ────────────────────────────────────────────────────────────

interface CardFooterProps {
  status: SlashCardStatus
  onApprove: () => void
  onApply: () => void
  onCancel: () => void
}

function CardFooter({ status, onApprove, onApply, onCancel }: CardFooterProps) {
  const { t } = useTranslation('agent')
  // Per-button disable matrix (Sprint F review):
  // - pending-review : APPROVE / APPLY / CANCEL all enabled.
  // - approved       : APPROVE disabled (already pressed); CANCEL disabled
  //                    (operation is in flight); APPLY still enabled because
  //                    APPLY = approved + --fix semantics, which is a stronger
  //                    action than APPROVE and may still be initiated by the user.
  // - applied        : all disabled (terminal state).
  // - cancelled      : all disabled (terminal state).
  const terminal     = status === 'applied' || status === 'cancelled'
  const approveDis   = terminal || status === 'approved'
  const applyDis     = terminal
  const cancelDis    = terminal || status === 'approved'

  function btnStyle(disabled: boolean): React.CSSProperties {
    return {
      ...MONO,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      background: 'none',
      borderRadius: 0,
      padding: '3px 10px',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        marginTop: 12,
        paddingTop: 10,
        borderTop: 'var(--border-width) solid var(--border)',
      }}
    >
      <button
        type="button"
        onClick={onApprove}
        disabled={approveDis}
        style={{
          ...btnStyle(approveDis),
          border: '2px solid var(--accent)',
          color: 'var(--accent)',
        }}
        onMouseEnter={e => {
          if (!approveDis) {
            const el = e.currentTarget
            el.style.background = 'var(--accent)'
            el.style.color = 'var(--bg-base, #0f0f0f)'
          }
        }}
        onMouseLeave={e => {
          if (!approveDis) {
            const el = e.currentTarget
            el.style.background = 'none'
            el.style.color = 'var(--accent)'
          }
        }}
      >
        {t('slash.approve')}
      </button>

      <button
        type="button"
        onClick={onApply}
        disabled={applyDis}
        style={{
          ...btnStyle(applyDis),
          border: '2px solid var(--success)',
          color: 'var(--success)',
        }}
        onMouseEnter={e => {
          if (!applyDis) {
            const el = e.currentTarget
            el.style.background = 'var(--success)'
            el.style.color = 'var(--bg-base, #0f0f0f)'
          }
        }}
        onMouseLeave={e => {
          if (!applyDis) {
            const el = e.currentTarget
            el.style.background = 'none'
            el.style.color = 'var(--success)'
          }
        }}
      >
        {t('slash.apply')}
      </button>

      <button
        type="button"
        onClick={onCancel}
        disabled={cancelDis}
        style={{
          ...btnStyle(cancelDis),
          border: '2px solid var(--danger)',
          color: 'var(--danger)',
        }}
        onMouseEnter={e => {
          if (!cancelDis) {
            const el = e.currentTarget
            el.style.background = 'var(--danger)'
            el.style.color = 'var(--bg-base, #0f0f0f)'
          }
        }}
        onMouseLeave={e => {
          if (!cancelDis) {
            const el = e.currentTarget
            el.style.background = 'none'
            el.style.color = 'var(--danger)'
          }
        }}
      >
        {t('slash.cancel')}
      </button>
    </div>
  )
}

// ── TroubleshootCard ──────────────────────────────────────────────────────────

function TroubleshootCard({ plan }: { plan: TroubleshootPlan }) {
  const { t } = useTranslation('agent')
  return (
    <div>
      {/* ROOT CAUSE */}
      <div style={{ marginBottom: 10 }}>
        <div style={SECTION_LABEL}>{t('slash.rootCause')}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            fontSize: 11,
            color: 'var(--text-primary)',
            ...MONO,
          }}
        >
          <span style={{ color: 'var(--accent)', flexShrink: 0 }}>&gt;</span>
          <span style={{ flex: 1 }}>{plan.rootCause.summary}</span>
          <span
            style={{
              fontSize: 9,
              color: 'var(--text-muted)',
              flexShrink: 0,
              alignSelf: 'center',
            }}
          >
            {t('slash.confidence', { confidence: plan.rootCause.confidence })}
          </span>
        </div>
      </div>

      {/* SOLUTIONS + RISK columns */}
      {plan.solutions.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={SECTION_LABEL}>{t('slash.solutions')}</div>
            <div style={SECTION_LABEL}>{t('slash.riskColumn')}</div>
          </div>
          {plan.solutions.map((sol, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 3,
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--text-primary)', ...MONO }}>
                {'  '}{i + 1}. {sol.title}
              </span>
              <RiskBadge risk={sol.risk} />
            </div>
          ))}
        </div>
      )}

      {/* RISKS */}
      {plan.risks.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>{t('slash.risks')}</div>
          {plan.risks.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 6,
                fontSize: 10,
                color: 'var(--text-muted)',
                marginBottom: 2,
                ...MONO,
              }}
            >
              <span style={{ flexShrink: 0 }}>-</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── RefactorCard ──────────────────────────────────────────────────────────────

function RefactorCard({ plan }: { plan: RefactorPlan }) {
  const { t } = useTranslation('agent')
  return (
    <div>
      {/* SCOPE */}
      <div style={{ marginBottom: 10 }}>
        <div style={SECTION_LABEL}>{t('slash.scope')}</div>
        <div style={{ fontSize: 10, color: 'var(--text-primary)', ...MONO }}>
          {'  '}{plan.target}
        </div>
      </div>

      {/* CHANGES */}
      {plan.changes.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={SECTION_LABEL}>{t('slash.changes')}</div>
          {plan.changes.map((ch, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                marginBottom: 4,
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: 10, flexShrink: 0, ...MONO }}>
                &gt;
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'var(--text-dim)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  flexShrink: 0,
                  width: 54,
                  ...MONO,
                }}
              >
                {ch.kind}
              </span>
              <span style={{ flex: 1, fontSize: 10, color: 'var(--text-primary)', ...MONO }}>
                {ch.description}
              </span>
              <RiskBadge risk={ch.impact} />
            </div>
          ))}
        </div>
      )}

      {/* ESTIMATED DIFF */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', ...MONO }}>
        {t('slash.estimatedDiff')}{'  '}
        <span style={{ color: 'var(--success)' }}>+{plan.estimatedDiff.added}</span>
        {' / '}
        <span style={{ color: 'var(--danger)' }}>-{plan.estimatedDiff.removed}</span>
        {' '}{t('slash.lines')}
      </div>
    </div>
  )
}

// ── ReviewCard ────────────────────────────────────────────────────────────────

type Severity = 'error' | 'warning' | 'info'

function severityIcon(s: Severity): string {
  if (s === 'error')   return '!'
  if (s === 'warning') return '~'
  return 'i'
}

function severityColor(s: Severity): string {
  if (s === 'error')   return 'var(--danger)'
  if (s === 'warning') return 'var(--warning)'
  return 'var(--text-muted)'
}

function ReviewCard({ plan }: { plan: ReviewReport }) {
  const { t } = useTranslation('agent')
  const { errorCount, warningCount, infoCount } = plan.summary
  return (
    <div>
      {/* SCOPE */}
      <div style={{ marginBottom: 10 }}>
        <div style={SECTION_LABEL}>{t('slash.scope')}</div>
        <div style={{ fontSize: 10, color: 'var(--text-primary)', ...MONO }}>
          {'  '}{plan.scope}
        </div>
      </div>

      {/* FINDINGS */}
      {plan.findings.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={SECTION_LABEL}>{t('slash.findings')}</div>
          {plan.findings.map((f, i) => {
            const color = severityColor(f.severity)
            const icon = severityIcon(f.severity)
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  marginBottom: 4,
                  fontSize: 10,
                  ...MONO,
                }}
              >
                <span style={{ color, flexShrink: 0, fontWeight: 700 }}>{icon}</span>
                <span
                  style={{
                    color,
                    textTransform: 'uppercase',
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    flexShrink: 0,
                    width: 60,
                  }}
                >
                  {f.severity}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                  {f.file}{f.line != null ? `:${f.line}` : ''}
                </span>
                <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>&mdash;</span>
                <span style={{ color: 'var(--text-primary)', flex: 1 }}>
                  {f.description}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* SUMMARY */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', ...MONO }}>
        {t('slash.summary')}{'  '}
        <span style={{ color: 'var(--danger)' }}>{t('slash.errors', { count: errorCount })}</span>
        {' · '}
        <span style={{ color: 'var(--warning)' }}>{t('slash.warnings', { count: warningCount })}</span>
        {' · '}
        <span>{t('slash.infoCount', { count: infoCount })}</span>
      </div>
    </div>
  )
}

// ── PlanCard ──────────────────────────────────────────────────────────────────

type PhaseStatus = 'pending' | 'in-progress' | 'done'

function phaseCheckbox(status: PhaseStatus): string {
  if (status === 'done')        return '[x]'
  if (status === 'in-progress') return '[~]'
  return '[ ]'
}

function phaseStatusColor(status: PhaseStatus): string {
  if (status === 'done')        return 'var(--success)'
  if (status === 'in-progress') return 'var(--warning)'
  return 'var(--text-dim)'
}

function PlanCard({ plan }: { plan: PlanArtifact }) {
  const { t } = useTranslation('agent')
  return (
    <div>
      {/* GOAL */}
      <div style={{ marginBottom: 10 }}>
        <div style={SECTION_LABEL}>{t('slash.goal')}</div>
        <div style={{ fontSize: 10, color: 'var(--text-primary)', ...MONO }}>
          {'  '}{plan.goal}
        </div>
      </div>

      {/* PHASES */}
      {plan.phases.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={SECTION_LABEL}>{t('slash.phases')}</div>
          {plan.phases.map((phase, i) => {
            const depends = phase.dependsOn.length > 0
              ? phase.dependsOn.join(', ')
              : '—'
            const taskList = phase.tasks.map(t => t.description).join(', ')
            const statusColor = phaseStatusColor(phase.status)
            const checkbox = phaseCheckbox(phase.status)
            return (
              <div key={phase.id} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 10,
                    ...MONO,
                  }}
                >
                  <span style={{ color: statusColor, flexShrink: 0 }}>{checkbox}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                    {t('slash.phase', { num: i + 1, name: phase.name })}
                  </span>
                  <span style={{ color: 'var(--text-dim)', marginLeft: 'auto', fontSize: 9 }}>
                    {t('slash.depends', { depends })}
                  </span>
                </div>
                {phase.tasks.length > 0 && (
                  <div
                    style={{
                      paddingLeft: 24,
                      fontSize: 9,
                      color: 'var(--text-muted)',
                      marginTop: 2,
                      ...MONO,
                    }}
                  >
                    {t('slash.tasks', { tasks: taskList })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* RISKS */}
      {plan.risks.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={SECTION_LABEL}>{t('slash.risks')}</div>
          {plan.risks.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 6,
                fontSize: 10,
                color: 'var(--text-muted)',
                marginBottom: 2,
                ...MONO,
              }}
            >
              <span style={{ flexShrink: 0 }}>-</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}

      {/* CRITICAL PATH */}
      {plan.criticalPath.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', ...MONO }}>
          {t('slash.criticalPath')}{'  '}
          <span style={{ color: 'var(--text-muted)' }}>
            {plan.criticalPath.join(' > ')}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Error / fallback card ─────────────────────────────────────────────────────

function ErrorCard({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation('agent')
  return (
    <div
      style={{
        ...MONO,
        border: '2px solid var(--danger)',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-soft)',
        borderRadius: 0,
        padding: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', ...MONO }}>
          {t('slash.errorCard.title')}
        </span>
        <span
          style={{
            ...MONO,
            border: 'var(--border-width) solid var(--danger)',
            color: 'var(--danger)',
            fontSize: 10,
            padding: '2px 6px',
          }}
        >
          {t('slash.errorCard.badge')}
        </span>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', ...MONO, marginBottom: 8 }}>
        {t('slash.errorCard.parseFailed')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', ...MONO, marginBottom: 12 }}>
        {t('slash.errorCard.rawLogged')}
      </div>

      <div style={{ paddingTop: 10, borderTop: 'var(--border-width) solid var(--border)' }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            ...MONO,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            background: 'none',
            border: '2px solid var(--danger)',
            color: 'var(--danger)',
            borderRadius: 0,
            padding: '3px 10px',
            cursor: 'pointer',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--danger)'
            e.currentTarget.style.color = 'var(--bg-base, #0f0f0f)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'none'
            e.currentTarget.style.color = 'var(--danger)'
          }}
        >
          {t('slash.errorCard.dismiss')}
        </button>
      </div>
    </div>
  )
}

// ── SlashCommandCard (dispatcher) ─────────────────────────────────────────────

export function SlashCommandCard({
  plan,
  status,
  onApprove,
  onApply,
  onCancel,
}: SlashCommandCardProps) {
  // Null / unknown plan: show the error card
  if (
    plan == null ||
    !['troubleshoot', 'refactor', 'review', 'plan'].includes(plan.command)
  ) {
    return <ErrorCard onCancel={onCancel} />
  }

  return (
    <div style={SHELL}>
      <CardHeader command={plan.command} status={status} />

      {plan.command === 'troubleshoot' && <TroubleshootCard plan={plan} />}
      {plan.command === 'refactor'     && <RefactorCard plan={plan} />}
      {plan.command === 'review'       && <ReviewCard plan={plan} />}
      {plan.command === 'plan'         && <PlanCard plan={plan} />}

      <CardFooter
        status={status}
        onApprove={onApprove}
        onApply={onApply}
        onCancel={onCancel}
      />
    </div>
  )
}
