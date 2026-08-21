// apps/desktop/src/pages/chat/SourceChips.tsx
//
// RAG SOURCE CITATIONS (USER-PAINS T20 / top-10 #6). When an answer was grounded
// in the chat's attached knowledge folder, the assistant message carries the
// exact chunks the local MiniLM index returned. This renders them as a row of
// brutalist chips — file name + line range — under the reply. Clicking a chip
// expands the EXACT retrieved text (nothing paraphrased, nothing re-fetched) so
// "where did that come from?" is one click, and offers REVEAL to open the file
// in the OS explorer via the existing shell IPC.
//
// Renders null when there are no citations, so every ordinary message is
// visually unchanged.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
// Runtime value → deep subpath (renderer convention: only TYPES come from the
// barrel, so the whole core index never lands in the renderer bundle).
import { citationLabel, type RagCitation } from '@tachi/core/src/rag/citations'

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 7px',
  border: '2px solid var(--border)',
  background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
  color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const actionBtnStyle: React.CSSProperties = {
  padding: '1px 6px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

export function SourceChips({ citations }: { citations?: RagCitation[] }): React.ReactElement | null {
  const { t } = useTranslation('chat')
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  if (!citations || citations.length === 0) return null
  const open = openIndex !== null ? citations[openIndex] : undefined

  return (
    <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          title={t('sources.hint', { defaultValue: 'Retrieved from the attached folder — click a source to see the exact text' })}
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
            userSelect: 'none',
          }}
        >
          {t('sources.label', { defaultValue: 'Sources' })} ({citations.length})
        </span>
        {citations.map((c, i) => (
          <button
            key={`${c.path}:${c.startLine}`}
            type="button"
            onClick={() => setOpenIndex(prev => (prev === i ? null : i))}
            aria-expanded={openIndex === i}
            title={t('sources.chipTitle', {
              defaultValue: '{{path}} · lines {{start}}-{{end}} · match {{score}}',
              path: c.path,
              start: c.startLine,
              end: c.endLine,
              score: c.score.toFixed(2),
            })}
            style={chipStyle(openIndex === i)}
          >
            <span style={{ color: 'var(--accent)' }}>{openIndex === i ? '▾' : '▸'}</span>
            {citationLabel(c)}
          </button>
        ))}
      </div>

      {open && (
        <div
          style={{
            marginTop: 4,
            border: '2px solid var(--border)',
            background: 'var(--bg-inset)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '3px 8px',
              borderBottom: '2px solid var(--border)',
              fontSize: 10,
              color: 'var(--text-dim)',
            }}
          >
            <span style={{ wordBreak: 'break-all' }}>{open.path}</span>
            <span>
              {t('sources.lines', { defaultValue: 'lines {{start}}-{{end}}', start: open.startLine, end: open.endLine })}
            </span>
            <span>{t('sources.match', { defaultValue: 'match {{score}}', score: open.score.toFixed(2) })}</span>
            <span style={{ flex: 1 }} />
            {open.absPath && (
              <button
                type="button"
                style={actionBtnStyle}
                title={open.absPath}
                onClick={() => { window.tachi.shell.revealInFolder(open.absPath).catch(() => { /* file moved/deleted */ }) }}
              >
                {t('sources.openFile', { defaultValue: 'Reveal file' })}
              </button>
            )}
          </div>
          <pre
            style={{
              margin: 0,
              padding: '6px 8px',
              maxHeight: 220,
              overflow: 'auto',
              fontSize: 11,
              lineHeight: 1.5,
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {open.text}
          </pre>
        </div>
      )}
    </div>
  )
}
