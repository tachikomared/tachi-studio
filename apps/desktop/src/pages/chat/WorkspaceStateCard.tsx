// apps/desktop/src/pages/chat/WorkspaceStateCard.tsx
//
// Sprint D3 — Renders a `state`-type PlaybookEntry.
// Shows goal as headline, phases as accordion with ASCII status indicators,
// blockers as --warning colored badges, decisions as bullet list.
//
// Brutalist aesthetic: 2px borders, JetBrains Mono, no border-radius.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

// ── Types (mirrored from playbook-service.ts — no electron import on renderer) ──

export interface Task {
  id:           string
  description:  string
  dependencies: string[]
  status:       'pending' | 'in-progress' | 'done'
}

export interface Phase {
  name:   string
  status: 'pending' | 'in-progress' | 'done'
  tasks:  Task[]
}

export interface StateEntry {
  type:         'state'
  ts:           number
  goal:         string
  phases:       Phase[]
  blockers:     string[]
  decisions:    string[]
  criticalPath: string[]
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}

// ── Status indicator (ASCII brutalist) ────────────────────────────────────────

function statusIndicator(status: 'pending' | 'in-progress' | 'done'): string {
  if (status === 'done')        return '[x]'
  if (status === 'in-progress') return '[~]'
  return '[ ]'
}

function statusColor(status: 'pending' | 'in-progress' | 'done'): string {
  if (status === 'done')        return 'var(--success, #81c784)'
  if (status === 'in-progress') return 'var(--warning, #ffb74d)'
  return 'var(--text-muted)'
}

// ── PhaseAccordion ────────────────────────────────────────────────────────────

function PhaseAccordion({ phase }: { phase: Phase }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  return (
    <div style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '3px 10px',
          textAlign: 'left',
          color: 'var(--text-primary)',
          ...MONO,
          fontSize: 10,
        }}
      >
        <span style={{ color: statusColor(phase.status), flexShrink: 0 }}>
          {statusIndicator(phase.status)}
        </span>
        <span style={{ flex: 1 }}>{phase.name}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{open ? '-' : '+'}</span>
      </button>

      {open && phase.tasks.length > 0 && (
        <div style={{ paddingLeft: 20, paddingBottom: 4 }}>
          {phase.tasks.map(task => (
            <div
              key={task.id}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'flex-start',
                padding: '2px 10px',
                fontSize: 10,
                color: 'var(--text-primary)',
                ...MONO,
              }}
            >
              <span style={{ color: statusColor(task.status), flexShrink: 0 }}>
                {statusIndicator(task.status)}
              </span>
              <span>{task.description}</span>
            </div>
          ))}
        </div>
      )}

      {open && phase.tasks.length === 0 && (
        <div style={{ paddingLeft: 20, paddingBottom: 4, fontSize: 10, color: 'var(--text-dim)', ...MONO }}>
          {t('workspaceState.noTasks')}
        </div>
      )}
    </div>
  )
}

// ── Blocker badge ─────────────────────────────────────────────────────────────

function BlockerBadge({ text }: { text: string }) {
  return (
    <div
      title={text}
      style={{
        display: 'inline-block',
        border: '2px solid var(--warning, #ffb74d)',
        color: 'var(--warning, #ffb74d)',
        fontSize: 9,
        padding: '1px 6px',
        marginRight: 4,
        marginBottom: 4,
        maxWidth: 220,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...MONO,
      }}
    >
      {text}
    </div>
  )
}

// ── WorkspaceStateCard ────────────────────────────────────────────────────────

interface WorkspaceStateCardProps {
  entry: StateEntry
}

export function WorkspaceStateCard({ entry }: WorkspaceStateCardProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(true)
  const ts = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{
      border: '2px solid var(--border)',
      marginBottom: 0,
    }}>
      {/* Header row */}
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          background: 'var(--bg-elevated)',
          border: 'none',
          borderBottom: open ? '2px solid var(--border)' : 'none',
          cursor: 'pointer',
          padding: '4px 10px',
          textAlign: 'left',
          color: 'var(--text-dim)',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          ...MONO,
        }}
      >
        <span style={{ flex: 1 }}>{t('workspaceState.snapshot')}</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{ts}</span>
        <span style={{ marginLeft: 4 }}>{open ? '-' : '+'}</span>
      </button>

      {open && (
        <div>
          {/* Goal */}
          {entry.goal && (
            <div style={{
              padding: '5px 10px',
              borderBottom: 'var(--border-width) solid var(--border)',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--text-primary)',
              ...MONO,
            }}>
              {entry.goal.length > 160 ? entry.goal.slice(0, 157) + '...' : entry.goal}
            </div>
          )}

          {/* Phases */}
          {entry.phases.length > 0 && (
            <div>
              <div style={{
                padding: '3px 10px',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: 'var(--text-dim)',
                background: 'var(--bg-surface)',
                borderBottom: 'var(--border-width) solid var(--border)',
                ...MONO,
              }}>
                {t('workspaceState.phases')}
              </div>
              {entry.phases.map((phase, i) => (
                <PhaseAccordion key={i} phase={phase} />
              ))}
            </div>
          )}

          {/* Blockers */}
          {entry.blockers.length > 0 && (
            <div style={{
              padding: '5px 10px',
              borderTop: entry.phases.length > 0 ? 'var(--border-width) solid var(--border)' : undefined,
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: 'var(--text-dim)',
                marginBottom: 4,
                ...MONO,
              }}>
                {t('workspaceState.blockers')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {entry.blockers.map((b, i) => (
                  <BlockerBadge key={i} text={b} />
                ))}
              </div>
            </div>
          )}

          {/* Decisions */}
          {entry.decisions.length > 0 && (
            <div style={{
              padding: '5px 10px',
              borderTop: 'var(--border-width) solid var(--border)',
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: 'var(--text-dim)',
                marginBottom: 4,
                ...MONO,
              }}>
                {t('workspaceState.decisions')}
              </div>
              {entry.decisions.map((d, i) => (
                <div key={i} style={{
                  display: 'flex',
                  gap: 4,
                  fontSize: 10,
                  color: 'var(--text-primary)',
                  marginBottom: 2,
                  ...MONO,
                }}>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>&gt;</span>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!entry.goal && entry.phases.length === 0 && entry.blockers.length === 0 && entry.decisions.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-dim)', ...MONO }}>
              {t('workspaceState.noData')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
