// apps/desktop/src/pages/agent/DiffCard.tsx
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export const FILE_WRITE_TOOLS = /^(edit|write|multiedit|str_replace|str_replace_based_edit_tool|text_editor|developer__text_editor|create_file|file_write|bash)$/i

export function DiffCard({ name, diff }: { name: string; diff: string }) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const lines = diff.split('\n')

  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      overflow: 'hidden', background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-inset)', cursor: 'pointer',
      }} onClick={() => setExpanded(e => !e)}>
        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{t('diff.label')}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', flex: 1 }}>
          {name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length} +  {lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length} −
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 4 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {/* Diff lines */}
      {expanded && (
        <div style={{
          overflowY: 'auto', maxHeight: 300,
          padding: '4px 0', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
        }}>
          {lines.map((line, i) => {
            const bg = line.startsWith('+') && !line.startsWith('+++')
              ? 'rgba(74,222,128,0.08)'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'rgba(255,82,82,0.08)'
                : line.startsWith('@@')
                  ? 'rgba(107,56,212,0.08)'
                  : 'transparent'
            const color = line.startsWith('+') && !line.startsWith('+++')
              ? 'var(--success)'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'var(--danger)'
                : line.startsWith('@@')
                  ? 'var(--accent)'
                  : 'var(--text-muted)'
            return (
              <div key={i} style={{ padding: '0 10px', background: bg, color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line || ' '}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
