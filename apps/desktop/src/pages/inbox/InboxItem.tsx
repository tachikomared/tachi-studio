// apps/desktop/src/pages/inbox/InboxItem.tsx
//
// PRIVATE MODE (Tier 4) — single capability request card.
//
// Renders one CapabilityRequest as a brutalist row. The parent InboxView
// owns the keyboard-nav focus state and approval mutations; this component
// is intentionally dumb so it stays cheap to render per-keystroke when the
// user is paging through the list with j/k.

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityRequest } from '../../store/capability.store'

interface InboxItemProps {
  request:   CapabilityRequest
  focused:   boolean
  onApprove: () => void
  onDeny:    () => void
  onFocus:   () => void
}

/**
 * Tail-truncate a long string so the row stays single-line. We keep the
 * suffix (file paths, command tails) because the prefix tends to repeat.
 */
function truncTail(s: string, max: number): string {
  if (s.length <= max) return s
  return '…' + s.slice(s.length - max + 1)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Extract a one-line summary of the tool input. Different tools have
 * different shapes — pull the most useful field for each common one and
 * fall back to a compact JSON dump.
 */
function summariseInput(toolName: string, input: unknown): { key: string; value: string } | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>

  // Bash / Shell — surface the command.
  if (/^(bash|shell|run_command|execute|cmd|terminal)/i.test(toolName)) {
    const cmd = obj['command']
    if (typeof cmd === 'string') return { key: 'command', value: cmd }
  }

  // Write / Edit / Create — surface the target path.
  if (/^(write|create|edit|patch|update|replace|str_replace|multiedit|delete|remove|move|rename|mkdir)/i.test(toolName)) {
    const path = obj['file_path'] ?? obj['path']
    if (typeof path === 'string') return { key: 'path', value: path }
  }

  // Fallback: compact one-line JSON. Keep it under 240 chars.
  try {
    const json = JSON.stringify(obj)
    if (json && json !== '{}') return { key: 'input', value: json.slice(0, 240) }
  } catch { /* ignore */ }
  return null
}

export function InboxItem({ request, focused, onApprove, onDeny, onFocus }: InboxItemProps) {
  const { t } = useTranslation('inbox')
  const summary = useMemo(
    () => summariseInput(request.toolName, request.toolInput),
    [request.toolName, request.toolInput],
  )

  // Status tag — colors derived from semantic CSS vars so the brutalist
  // dark/light themes both look right.
  const statusColor = (() => {
    if (request.status === 'approved') return 'var(--accent)'
    if (request.status === 'denied')   return 'var(--danger, #d43f00)'
    if (request.status === 'snoozed')  return 'var(--warning, #d4a83f)'
    return 'var(--text-primary)'
  })()
  const statusLabel = request.status.toUpperCase()

  // Brutalist row. Border-color brightens when focused so j/k navigation is
  // visible without changing layout.
  const rowStyle: React.CSSProperties = {
    border: focused
      ? '2px solid var(--accent)'
      : '2px solid var(--border)',
    background: focused ? 'var(--bg-elevated, #1a1a1a)' : 'var(--bg-surface)',
    padding: '10px 14px',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    lineHeight: 1.55,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    outline: 'none',
  }

  const labelTagStyle: React.CSSProperties = {
    display: 'inline-block',
    border: `2px solid ${statusColor}`,
    color: statusColor,
    padding: '0 6px',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    marginRight: 8,
  }

  const buttonBase: React.CSSProperties = {
    padding: '4px 10px',
    border: '2px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    cursor: 'pointer',
    textTransform: 'uppercase',
  }

  const approveStyle: React.CSSProperties = {
    ...buttonBase,
    border: '2px solid var(--accent)',
    background: 'var(--accent)',
    color: '#ffffff',
  }

  const denyStyle: React.CSSProperties = {
    ...buttonBase,
    border: '2px solid var(--danger, #d43f00)',
    color: 'var(--danger, #d43f00)',
  }

  const isPending = request.status === 'pending'

  return (
    <div
      role="listitem"
      tabIndex={-1}
      onClick={onFocus}
      style={rowStyle}
    >
      {/* Header line: status tag + tool name + timestamp */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={labelTagStyle}>[{statusLabel}]</span>
        <span style={{ fontWeight: 700 }}>PreToolUse · {request.toolName}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
          {formatTime(request.pushedAt)}
        </span>
      </div>

      {/* Input summary */}
      {summary && (
        <div style={{ paddingLeft: 14, color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>{summary.key}:</span>{' '}
          <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>
            {truncTail(summary.value, 180)}
          </span>
        </div>
      )}

      {/* Reason */}
      <div style={{ paddingLeft: 14, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>{t('fields.reason')}</span>{' '}
        <span style={{ color: 'var(--text-primary)' }}>{request.reason}</span>
      </div>

      {/* Session + workingDir */}
      <div style={{ paddingLeft: 14, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>{t('fields.session')}</span>{' '}
        <span style={{ color: 'var(--text-primary)' }}>{truncTail(request.sessionId, 32)}</span>
      </div>
      <div style={{ paddingLeft: 14, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>{t('fields.workingDir')}</span>{' '}
        <span style={{ color: 'var(--text-primary)' }}>{truncTail(request.workingDir, 60)}</span>
      </div>

      {/* Actions — only show for pending. Resolved rows stay visible so the
          user can audit recent decisions; "clear resolved" lives at the
          parent level. */}
      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, paddingLeft: 14 }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApprove() }}
            style={approveStyle}
            aria-label={t('item.approveAria')}
          >
            {t('item.approve')}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeny() }}
            style={denyStyle}
            aria-label={t('item.denyAria')}
          >
            {t('item.deny')}
          </button>
        </div>
      )}
    </div>
  )
}
