// apps/desktop/src/pages/swarm/FeedPane.tsx
//
// Right pane of the SwarmPage. Two stacked sections in a single
// time-sorted (descending) feed view:
//   1. Commit feed — each row is a sha + subject + first touched path.
//   2. Messages — each row is `from -> to: text` with timestamp.
//
// Commits and messages live in separate arrays in the store but render
// here interleaved by timestamp so the user sees the actual chronology
// of what's happening in the swarm.

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SwarmEvent, SwarmMessage } from '../../store/swarm.store'

interface FeedPaneProps {
  feed:     SwarmEvent[]
  messages: SwarmMessage[]
}

// A discriminated union row for the interleaved view.
type FeedRow =
  | { kind: 'commit';  ts: number; sha: string;     subject: string; touchedFiles: string[] }
  | { kind: 'message'; ts: number; from: string;    to: string[];    text: string;    id: string }

function tsOfMessage(m: SwarmMessage): number {
  // Messages carry an ISO `at`. Fall back to 0 for malformed values so they
  // sink to the bottom rather than throwing.
  const parsed = Date.parse(m.at)
  return Number.isFinite(parsed) ? parsed : 0
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

function fmtAge(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 0)              return 'now'
  if (delta < 60_000)         return `${Math.floor(delta / 1000)}s`
  if (delta < 3_600_000)      return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000)     return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

export function FeedPane({ feed, messages }: FeedPaneProps) {
  const { t } = useTranslation('swarm')
  // Build a single sorted list once per render. Commits use their `at`
  // (local epoch ms when received), messages parse their ISO timestamp.
  const rows = useMemo<FeedRow[]>(() => {
    const commitRows: FeedRow[] = feed.map((e) => ({
      kind:         'commit',
      ts:           e.at,
      sha:          e.sha,
      subject:      e.subject,
      touchedFiles: e.touchedFiles,
    }))
    const messageRows: FeedRow[] = messages.map((m) => ({
      kind: 'message',
      ts:   tsOfMessage(m),
      from: m.from,
      to:   m.to,
      text: m.text,
      id:   m.id,
    }))
    return [...commitRows, ...messageRows].sort((a, b) => b.ts - a.ts)
  }, [feed, messages])

  return (
    <div style={{
      width:         320,
      flexShrink:    0,
      borderLeft:    '2px solid var(--border)',
      background:    'var(--bg-base)',
      display:       'flex',
      flexDirection: 'column',
      overflow:      'hidden',
      fontFamily:    'JetBrains Mono, monospace',
    }}>
      {/* Pane header */}
      <div style={{
        padding:       '8px 12px',
        borderBottom:  '2px solid var(--border)',
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color:         'var(--text-muted)',
        display:       'flex',
        gap:           12,
        flexShrink:    0,
      }}>
        <span>{t('feed.header')}</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
          {t('feed.counts', { commits: feed.length, messages: messages.length })}
        </span>
      </div>

      {/* Stream */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows.length === 0 && (
          <div style={{
            padding:    12,
            fontSize:   11,
            color:      'var(--text-dim)',
            lineHeight: 1.5,
          }}>
            {t('feed.empty')}
          </div>
        )}

        {rows.map((row) => {
          if (row.kind === 'commit') {
            return (
              <div
                key={`c:${row.sha}`}
                style={{
                  padding:      '8px 12px',
                  borderBottom: 'var(--border-width) solid var(--border)',
                  display:      'flex',
                  flexDirection: 'column',
                  gap:          2,
                }}
              >
                <div style={{
                  display:    'flex',
                  alignItems: 'center',
                  gap:        6,
                  fontSize:   10,
                  color:      'var(--text-muted)',
                }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                    {shortSha(row.sha)}
                  </span>
                  <span style={{ flex: 1 }}>{t('feed.commit')}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{fmtAge(row.ts)}</span>
                </div>
                <div style={{
                  fontSize:   11,
                  color:      'var(--text-primary)',
                  wordBreak:  'break-word',
                }}>
                  {row.subject || t('feed.noSubject')}
                </div>
                {row.touchedFiles.length > 0 && (
                  <div style={{
                    fontSize: 9,
                    color:    'var(--text-dim)',
                    lineHeight: 1.5,
                  }}>
                    {row.touchedFiles.slice(0, 3).map((f) => (
                      <div key={f} style={{
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace:   'nowrap',
                      }}>
                        · {f}
                      </div>
                    ))}
                    {row.touchedFiles.length > 3 && (
                      <div>{t('feed.moreFiles', { count: row.touchedFiles.length - 3 })}</div>
                    )}
                  </div>
                )}
              </div>
            )
          }
          // message row
          return (
            <div
              key={`m:${row.id}`}
              style={{
                padding:      '8px 12px',
                borderBottom: 'var(--border-width) solid var(--border)',
                background:   'var(--bg-elevated)',
                display:      'flex',
                flexDirection: 'column',
                gap:          2,
              }}
            >
              <div style={{
                display:    'flex',
                alignItems: 'center',
                gap:        6,
                fontSize:   10,
                color:      'var(--text-muted)',
              }}>
                <span style={{ color: 'var(--warning, #f59e0b)', fontWeight: 700 }}>
                  {t('feed.msg')}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.from} -&gt; {row.to.join(', ') || '*'}
                </span>
                <span style={{ color: 'var(--text-dim)' }}>{fmtAge(row.ts)}</span>
              </div>
              <div style={{
                fontSize:   11,
                color:      'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak:  'break-word',
              }}>
                {row.text}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
