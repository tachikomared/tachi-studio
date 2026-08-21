// apps/desktop/src/pages/agent/PermissionCard.tsx
//
// Renders a pending permission request inline in the agent log.
// The agent is paused until the user makes a decision.
//
// Brutalist: 2px borders, JetBrains Mono, no border-radius, semantic CSS vars.
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionDecision } from '../../types/electron'
import { InlineDiff } from './InlineDiff'

// UX #8: file mutations render as a red/green diff, not a JSON blob — the
// user reviews WHAT changes, not an arg dump. TACHI names its edit args
// oldString/newString (camelCase); InlineDiff speaks the sidecar snake_case,
// so we normalize here at the seam.
function diffFor(toolName: string, toolInput: unknown): { family: 'edit' | 'write'; parsedInput: Record<string, unknown> } | null {
  if (!toolInput || typeof toolInput !== 'object') return null
  const o = toolInput as Record<string, unknown>
  if (/^edit/i.test(toolName) && (typeof o.oldString === 'string' || typeof o.old_string === 'string')) {
    return {
      family: 'edit',
      parsedInput: {
        old_string: o.old_string ?? o.oldString ?? '',
        new_string: o.new_string ?? o.newString ?? '',
      },
    }
  }
  if (/^(write|create)/i.test(toolName) && typeof o.content === 'string') {
    return { family: 'write', parsedInput: { content: o.content } }
  }
  return null
}

export interface PermissionRequest {
  id: string
  toolName: string
  toolInput: unknown
  reason: string
  recommendedDecision: 'allow' | 'deny'
  /**
   * Harness session the blocked call belongs to. Stamped by main so the
   * renderer can tell the operator WHOSE run they are approving when the card
   * shows up on a surface that does not own it (the queue is app-lifetime).
   * Optional: a card re-synced from an older main has none, and an unknown
   * owner is left unlabelled rather than guessed.
   */
  sessionId?: string
}

interface PermissionCardProps {
  request: PermissionRequest
  onDecide: (id: string, decision: PermissionDecision) => void
  /**
   * Set when this card belongs to a run on the OTHER surface — e.g. "CODE RUN"
   * while the operator is on TACHIAPP. The buttons stay live (unblocking the
   * run from the wrong tab beats a stalled card); the chip is what stops the
   * operator from approving a bash call they think is theirs.
   */
  ownerLabel?: string
  /** Tooltip for the owner chip (why it is here). */
  ownerHint?: string
}

export function PermissionCard({ request, onDecide, ownerLabel, ownerHint }: PermissionCardProps) {
  const { t } = useTranslation('agent')
  const { id, toolName, toolInput, reason, recommendedDecision } = request

  // The card mounts at the bottom of a long transcript, so its ALLOW/DENY row
  // can sit below the fold with no visible cue — live-found: a run sat parked
  // ~5 min because the buttons were under the composer. Scroll it into view
  // once per request; never again after, so the user can scroll away freely.
  const cardRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [id])

  // Diff-first (UX #8): file mutations show the actual change; the JSON dump
  // stays only for tools with no diffable payload.
  const diff = diffFor(toolName, toolInput)

  // Render the tool input as formatted JSON if possible.
  let inputPreview = ''
  try {
    inputPreview = typeof toolInput === 'string'
      ? JSON.stringify(JSON.parse(toolInput), null, 2)
      : JSON.stringify(toolInput, null, 2)
  } catch {
    inputPreview = String(toolInput)
  }

  return (
    <div
      ref={cardRef}
      /* Stable styling hook for theme structure layers (the TK-05 chassis theme
         flashes this border with hazard stripes — "run paused, decide" is the
         one card on screen that stops the machine). Neutral for every theme that
         does not target it; nothing here reads it. */
      data-permission-card=""
      style={{
        border: '2px solid var(--warning)',
        background: 'var(--bg-elevated)',
        fontFamily: 'JetBrains Mono, monospace',
        marginBottom: 6,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '2px solid var(--warning)',
          background: 'rgba(245,158,11,0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {/* OWNER CHIP — first thing in the header, because "which run is this?"
            has to be answered before "allow or deny?". Only rendered when the
            card belongs to the other surface. */}
        {ownerLabel && (
          <span
            data-testid="permission-owner"
            title={ownerHint}
            style={{
              padding: '2px 8px',
              border: '2px solid var(--warning)',
              background: 'transparent',
              color: 'var(--warning)',
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            {ownerLabel}
          </span>
        )}
        <span
          style={{
            padding: '2px 8px',
            background: 'var(--warning)',
            color: '#000',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {t('permission.badge')}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--warning)',
            letterSpacing: '0.04em',
          }}
        >
          {toolName}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 10,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('permission.paused')}
        </span>
      </div>

      {/* Reason (highlighted risk) */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: 'var(--border-width) solid var(--border)',
          background: recommendedDecision === 'deny'
            ? 'rgba(255,82,82,0.08)'
            : 'rgba(245,158,11,0.06)',
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: recommendedDecision === 'deny' ? 'var(--danger)' : 'var(--warning)',
            marginRight: 8,
          }}
        >
          {recommendedDecision === 'deny' ? t('permission.risky') : t('permission.review')}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          {reason}
        </span>
      </div>

      {/* Diff preview for file mutations (red/green), JSON only otherwise */}
      {diff && (
        <div style={{ borderBottom: 'var(--border-width) solid var(--border)', maxHeight: 220, overflowY: 'auto' }}>
          <InlineDiff family={diff.family} parsedInput={diff.parsedInput} />
        </div>
      )}

      {/* Input preview */}
      {!diff && inputPreview && (
        <div style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
          <div
            style={{
              padding: '3px 12px',
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              background: 'var(--bg-base)',
              borderBottom: 'var(--border-width) solid var(--border)',
            }}
          >
            {t('permission.input')}
          </div>
          <pre
            style={{
              margin: 0,
              padding: '6px 12px',
              fontSize: 10,
              lineHeight: 1.5,
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 120,
              overflowY: 'auto',
              background: '#0a0a0a',
            }}
          >
            {inputPreview.length > 800 ? inputPreview.slice(0, 800) + '…' : inputPreview}
          </pre>
        </div>
      )}

      {/* Action buttons */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '8px 12px',
          background: 'var(--bg-surface)',
          flexWrap: 'wrap',
        }}
      >
        <DecisionButton
          label={t('permission.allow')}
          hint={t('permission.allowHint')}
          color="var(--success)"
          onClick={() => onDecide(id, 'allow')}
          primary={recommendedDecision === 'allow'}
        />
        <DecisionButton
          label={t('permission.deny')}
          hint={t('permission.denyHint')}
          color="var(--danger)"
          onClick={() => onDecide(id, 'deny')}
          primary={recommendedDecision === 'deny'}
        />
        <DecisionButton
          label={t('permission.allow30m', { defaultValue: 'Allow 30 min' })}
          hint={t('permission.allow30mHint', { toolName, defaultValue: 'Let "{{toolName}}" run without asking for the next 30 minutes — the grant expires silently' })}
          color="var(--accent)"
          onClick={() => onDecide(id, 'allow_30m')}
        />
        <DecisionButton
          label={t('permission.alwaysAllowTool')}
          hint={t('permission.alwaysAllowToolHint', { toolName })}
          color="var(--accent)"
          onClick={() => onDecide(id, 'always_allow_tool')}
        />
        <DecisionButton
          label={t('permission.alwaysAllowFamily')}
          hint={t('permission.alwaysAllowFamilyHint')}
          color="var(--text-muted)"
          onClick={() => onDecide(id, 'always_allow_server')}
        />
      </div>
    </div>
  )
}

// ── DecisionButton ─────────────────────────────────────────────────────────────

function DecisionButton({
  label,
  hint,
  color,
  onClick,
  primary = false,
}: {
  label: string
  hint: string
  color: string
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      style={{
        padding: '5px 14px',
        border: `2px solid ${color}`,
        background: primary ? color : 'transparent',
        color: primary ? '#000' : color,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
