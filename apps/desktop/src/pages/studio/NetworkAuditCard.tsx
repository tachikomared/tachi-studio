// src/pages/studio/NetworkAuditCard.tsx
//
// Studio card that shows the main-process network audit log.
// Auto-refreshes every 5s while visible.  Category chip-filter, row expand.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NetworkAuditCategory, NetworkAuditEntry } from '../../types/electron'

// ── constants ─────────────────────────────────────────────────────────────────

const ALL_CATEGORIES: NetworkAuditCategory[] = [
  'anthropic', 'openai', 'github', 'openrouter', 'opengateway', 'bankr', 'venice', 'surplus', 'ollama', 'other',
]

const CATEGORY_LABEL: Record<NetworkAuditCategory, string> = {
  anthropic:   'Anthropic',
  openai:      'OpenAI',
  github:      'GitHub',
  openrouter:  'OpenRouter',
  opengateway: 'OpenGateway',
  bankr:       'Bankr',
  venice:      'Venice',
  surplus:     'Surplus',
  ollama:      'Ollama',
  other:       'Other',
}

// Accent hue per category (CSS var fallbacks to accent)
const CATEGORY_COLOR: Record<NetworkAuditCategory, string> = {
  anthropic:   '#d97706',  // amber
  openai:      '#10b981',  // green
  github:      '#6366f1',  // indigo
  openrouter:  '#ec4899',  // pink
  opengateway: '#0ea5e9',  // sky
  bankr:       '#f59e0b',  // yellow
  venice:      '#14b8a6',  // teal
  surplus:     '#a855f7',  // purple
  ollama:      '#8b5cf6',  // violet
  other:       '#6b7280',  // gray
}

// ── helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: number | null): string {
  if (status === null)      return 'var(--text-dim)'
  if (status < 300)         return 'var(--success)'
  if (status < 400)         return 'var(--warning)'
  return 'var(--danger)'
}

function fmtBytes(n: number): string {
  if (n < 0)           return '?'
  if (n === 0)         return '0 B'
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function pathTail(url: string): string {
  try {
    const u = new URL(url)
    const p = u.pathname
    // Keep only the last two path segments to fit the row width.
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 0) return '/'
    if (parts.length <= 2)  return '/' + parts.join('/')
    return '/…/' + parts.slice(-2).join('/')
  } catch {
    return url.slice(0, 40)
  }
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}

// ── sub-components ────────────────────────────────────────────────────────────

interface ChipProps {
  label:    string
  color:    string
  active:   boolean
  count?:   number
  onClick:  () => void
}

function Chip({ label, color, active, count, onClick }: ChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:        '1px 7px',
        border:         `2px solid ${active ? color : 'var(--border)'}`,
        background:     active ? `${color}22` : 'var(--bg-elevated)',
        color:          active ? color : 'var(--text-muted)',
        fontFamily:     'JetBrains Mono, monospace',
        fontSize:        9,
        fontWeight:      700,
        cursor:         'pointer',
        textTransform:  'uppercase',
        letterSpacing:  '0.06em',
        whiteSpace:     'nowrap',
        userSelect:     'none',
      }}
    >
      {label}{count != null ? ` (${count})` : ''}
    </button>
  )
}

interface RowProps {
  entry:     NetworkAuditEntry
  expanded:  boolean
  onToggle:  () => void
}

function AuditRow({ entry, expanded, onToggle }: RowProps) {
  const { t } = useTranslation('studio')
  const sc  = statusColor(entry.status)
  const cat = CATEGORY_COLOR[entry.category]

  return (
    <>
      <div
        onClick={onToggle}
        style={{
          padding:       '4px 12px',
          borderBottom:  'var(--border-width) solid var(--border)',
          display:       'flex',
          alignItems:    'center',
          gap:            8,
          cursor:        'pointer',
          background:    expanded ? 'var(--bg-elevated)' : undefined,
        }}
      >
        {/* status dot */}
        <span style={{
          width: 7, height: 7, background: sc, flexShrink: 0,
          border: `var(--border-width) solid ${sc}55`,
        }} />

        {/* method */}
        <span style={{
          fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
          width: 34, flexShrink: 0,
        }}>{entry.method}</span>

        {/* host */}
        <span style={{
          fontSize: 10, color: 'var(--text-primary)',
          fontWeight: 600, flexShrink: 0,
          maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{entry.host}</span>

        {/* path tail */}
        <span style={{
          flex: 1, fontSize: 9, color: 'var(--text-dim)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{pathTail(entry.url)}</span>

        {/* duration */}
        <span style={{
          fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right', width: 50,
        }}>{entry.durationMs}ms</span>

        {/* category chip */}
        <span style={{
          fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
          color: cat, border: `var(--border-width) solid ${cat}55`, padding: '1px 5px',
          background: `${cat}11`, flexShrink: 0,
        }}>{entry.category}</span>
      </div>

      {expanded && (
        <div style={{
          padding:      '6px 12px 10px',
          borderBottom: '2px solid var(--border)',
          background:   'var(--bg-inset)',
          fontSize:     10,
          fontFamily:   'JetBrains Mono, monospace',
          display:      'grid',
          gridTemplateColumns: 'auto 1fr',
          gap:          '2px 12px',
          color:        'var(--text-muted)',
        }}>
          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.url')}</span>
          <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{entry.url}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.status')}</span>
          <span style={{ color: sc }}>{entry.status ?? t('audit.detail.networkError')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.duration')}</span>
          <span>{entry.durationMs} ms</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.reqSize')}</span>
          <span>{fmtBytes(entry.bytesOut)}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.resSize')}</span>
          <span>{fmtBytes(entry.bytesIn)}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.time')}</span>
          <span>{entry.startedAt}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('audit.detail.category')}</span>
          <span style={{ color: cat }}>{entry.category}</span>
        </div>
      )}
    </>
  )
}

// ── Card shell (matches StudioPage's local Card component in style) ────────────

function Card({ title, action, children }: {
  title:    string
  action?:  React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div style={{
      border:          'var(--border-width) solid var(--border)',
      background:      'var(--bg-surface)',
      boxShadow:       'var(--shadow-hard)',
      display:         'flex',
      flexDirection:   'column',
      minHeight:       0,
    }}>
      <div style={{
        padding:        '8px 12px',
        borderBottom:   'var(--border-width) solid var(--border)',
        fontSize:        10,
        fontWeight:      700,
        letterSpacing:  '0.1em',
        color:          'var(--text-muted)',
        textTransform:  'uppercase',
        display:        'flex',
        alignItems:     'center',
        gap:             8,
      }}>
        <span style={{ flex: 1 }}>{title}</span>
        {action}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {children}
      </div>
    </div>
  )
}

// ── Btn helper ────────────────────────────────────────────────────────────────

function Btn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding:       '2px 8px',
        border:        `2px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background:    'var(--bg-elevated)',
        color:         danger ? 'var(--danger)' : 'var(--text-muted)',
        fontFamily:    'JetBrains Mono, monospace',
        fontSize:       9,
        fontWeight:     700,
        cursor:        'pointer',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >{label}</button>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function NetworkAuditCard() {
  const { t } = useTranslation('studio')
  const [entries,   setEntries]   = useState<NetworkAuditEntry[]>([])
  const [filter,    setFilter]    = useState<NetworkAuditCategory | null>(null)
  const [expandedId, setExpanded] = useState<number | null>(null)
  const [loading,   setLoading]   = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    window.tachi.networkAudit.list(500)
      .then(setEntries)
      .catch(() => {/* swallow */})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    timerRef.current = setInterval(load, 5_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [load])

  const handleClear = () => {
    window.tachi.networkAudit.clear()
      .then(() => setEntries([]))
      .catch(() => {/* swallow */})
  }

  // count per category
  const counts = entries.reduce<Partial<Record<NetworkAuditCategory, number>>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1
    return acc
  }, {})

  const visible = filter ? entries.filter(e => e.category === filter) : entries
  // Newest first
  const sorted  = [...visible].reverse()

  // Categories that have at least one entry
  const activeCategories = ALL_CATEGORIES.filter(c => (counts[c] ?? 0) > 0)

  const headerLabel = t('audit.title', { count: entries.length })

  return (
    <Card
      title={headerLabel}
      action={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {loading && <span style={{ fontSize: 8, color: 'var(--text-dim)', textTransform: 'none' }}>{t('audit.loading')}</span>}
          <span style={{ fontSize: 8, color: 'var(--success)' }}>{t('audit.live')}</span>
          <Btn label={t('audit.reload')} onClick={load} />
          <Btn label={t('audit.clear')}  onClick={handleClear} danger />
        </div>
      }
    >
      {/* ── Plain-English explainer ──────────────────────────────────────
          This card is mostly for power users debugging "is my key being
          used?" / "why is this slow?" — a one-liner up top so a first-time
          user knows what they're looking at before scrolling rows of GETs. */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-inset)',
        fontSize: 11,
        color: 'var(--text-muted)',
        lineHeight: 1.5,
      }}>
        {t('audit.explainer')}
      </div>
      {/* filter chips */}
      {activeCategories.length > 0 && (
        <div style={{
          padding:      '6px 12px',
          borderBottom: 'var(--border-width) solid var(--border)',
          display:      'flex',
          flexWrap:     'wrap',
          gap:           4,
        }}>
          <Chip
            label={t('audit.filterAll')}
            color="var(--accent)"
            active={filter === null}
            count={entries.length}
            onClick={() => setFilter(null)}
          />
          {activeCategories.map(cat => (
            <Chip
              key={cat}
              label={cat === 'other' ? t('audit.category.other') : CATEGORY_LABEL[cat]}
              color={CATEGORY_COLOR[cat]}
              active={filter === cat}
              count={counts[cat]}
              onClick={() => setFilter(f => f === cat ? null : cat)}
            />
          ))}
        </div>
      )}

      {/* empty state */}
      {sorted.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>
          {entries.length === 0
            ? t('audit.emptyNone')
            : t('audit.emptyFilter')}
        </div>
      )}

      {/* rows */}
      {sorted.map(entry => (
        <AuditRow
          key={entry.id}
          entry={entry}
          expanded={expandedId === entry.id}
          onToggle={() => setExpanded(id => id === entry.id ? null : entry.id)}
        />
      ))}
    </Card>
  )
}
