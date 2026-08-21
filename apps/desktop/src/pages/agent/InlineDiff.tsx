// apps/desktop/src/pages/agent/InlineDiff.tsx
//
// Renders a unified diff for Edit/Write tool calls inside ToolCallBlock.
//
// For Edit tools: uses old_string / new_string from the parsed input.
// For Write tools: shows the new content with a '+' prefix (no old content).
//
// Brutalist: 2px borders, JetBrains Mono, no border-radius, semantic CSS vars.
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { createTwoFilesPatch } from 'diff'

export interface InlineDiffProps {
  /** The tool family: 'edit' or 'write'. */
  family: 'edit' | 'write'
  /** Parsed JSON input object from the tool call. */
  parsedInput: Record<string, unknown>
}

interface DiffLine {
  type: '+' | '-' | ' ' | '@@'
  text: string
}

function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of patch.split('\n')) {
    // Skip file headers (--- / +++ / diff lines)
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ')) continue
    if (raw.startsWith('@@')) {
      lines.push({ type: '@@', text: raw })
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ type: '+', text: raw.slice(1) })
    } else if (raw.startsWith('-')) {
      lines.push({ type: '-', text: raw.slice(1) })
    } else if (raw.startsWith(' ')) {
      lines.push({ type: ' ', text: raw.slice(1) })
    }
    // Blank end-of-file markers ("\ No newline at end of file") — skip.
  }
  return lines
}

export function InlineDiff({ family, parsedInput }: InlineDiffProps) {
  const { t } = useTranslation('agent')
  const lines = useMemo<DiffLine[]>(() => {
    if (family === 'edit') {
      const oldStr = typeof parsedInput.old_string === 'string' ? parsedInput.old_string : ''
      const newStr = typeof parsedInput.new_string === 'string' ? parsedInput.new_string : ''
      if (!oldStr && !newStr) return []
      const patch = createTwoFilesPatch('before', 'after', oldStr, newStr, '', '', { context: 3 })
      return parseUnifiedDiff(patch)
    }

    if (family === 'write') {
      const content = typeof parsedInput.content === 'string' ? parsedInput.content : ''
      if (!content) return []
      // Show new content as all-added lines (no old version available).
      return content.split('\n').map(line => ({ type: '+' as const, text: line }))
    }

    return []
  }, [family, parsedInput])

  if (lines.length === 0) return null

  return (
    <div
      style={{
        borderTop: 'var(--border-width) solid var(--border)',
        background: '#0a0a0a',
      }}
    >
      {/* Section label */}
      <div
        style={{
          padding: '3px 10px',
          borderBottom: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-base)',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {t('diff.label')}
      </div>

      {/* Diff lines */}
      <div
        style={{
          maxHeight: 260,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              background: lineBackground(line.type),
              borderLeft: lineBorder(line.type),
              padding: '0 10px 0 6px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {/* Gutter character */}
            <span
              style={{
                width: 14,
                flexShrink: 0,
                color: lineGutterColor(line.type),
                fontWeight: 700,
                userSelect: 'none',
                textAlign: 'center',
              }}
            >
              {line.type === '@@' ? '' : line.type === ' ' ? '' : line.type}
            </span>
            {/* Line text */}
            <span
              style={{
                flex: 1,
                color: lineTextColor(line.type),
              }}
            >
              {line.type === '@@'
                ? <span style={{ color: 'var(--accent)', fontSize: 10 }}>{line.text}</span>
                : line.text || ' ' /* non-breaking space for empty lines */}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Color helpers ────────────────────────────────────────────────────────────

function lineBackground(type: DiffLine['type']): string {
  switch (type) {
    case '+':  return 'rgba(74,222,128,0.08)'
    case '-':  return 'rgba(248,113,113,0.10)'
    case '@@': return 'rgba(96,165,250,0.06)'
    default:   return 'transparent'
  }
}

function lineBorder(type: DiffLine['type']): string {
  switch (type) {
    case '+':  return '2px solid rgba(74,222,128,0.35)'
    case '-':  return '2px solid rgba(248,113,113,0.35)'
    default:   return '2px solid transparent'
  }
}

function lineGutterColor(type: DiffLine['type']): string {
  switch (type) {
    case '+':  return 'var(--success)'  // green
    case '-':  return 'var(--danger)'   // red
    default:   return 'transparent'
  }
}

function lineTextColor(type: DiffLine['type']): string {
  switch (type) {
    case '+':  return '#a7f3d0'
    case '-':  return '#fca5a5'
    default:   return '#e0e0e0'
  }
}
