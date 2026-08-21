// apps/desktop/src/pages/agent/ToolGroupSummary.tsx
//
// Collapses ≥3 consecutive tool calls into a single breathing-badge summary.
// Click to expand into the individual ToolCallBlocks.
//
// Brutalist: 2px borders, JetBrains Mono, no border-radius, semantic CSS vars.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToolCallBlock } from './ToolCallBlock'
import type { ToolBlock } from './pairToolEvents'

interface ToolGroupSummaryProps {
  tools: ToolBlock[]
}

// Build a compact human-readable summary of the group:
//   "Read×3, Edit×2, Bash"
function buildSummary(tools: ToolBlock[]): string {
  // Normalize each tool to its family label
  const familyLabel = (name: string): string => {
    const n = name.toLowerCase()
    if (/^(read|cat|view|open|read_file|view_file)/.test(n)) return 'Read'
    if (/^(write|create|write_file|create_file)/.test(n)) return 'Write'
    if (/^(edit|patch|update|replace|str_replace|multiedit)/.test(n)) return 'Edit'
    if (/^(bash|shell|run_command|execute|cmd)/.test(n)) return 'Bash'
    if (/^(grep|search|find|ripgrep)/.test(n)) return 'Search'
    if (/^(ls|list|glob|tree)/.test(n)) return 'List'
    if (/^(fetch|webfetch|http)/.test(n)) return 'Fetch'
    return name
  }

  // Count occurrences of each family label (preserving insertion order)
  const counts = new Map<string, number>()
  for (const t of tools) {
    const label = familyLabel(t.name)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  // Format: "Read×3, Edit×2, Bash"
  const parts: string[] = []
  for (const [label, count] of counts) {
    parts.push(count > 1 ? `${label}x${count}` : label)
  }
  return parts.join(', ')
}

export function ToolGroupSummary({ tools }: ToolGroupSummaryProps) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const anyRunning = tools.some(t => t.running)
  const summary = buildSummary(tools)

  return (
    <div
      style={{
        border: '2px solid var(--border)',
        background: 'var(--bg-elevated)',
        fontFamily: 'JetBrains Mono, monospace',
        marginBottom: 4,
      }}
    >
      {/* Badge row */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        {/* Breathing dot */}
        <span
          className={anyRunning ? 'tachi-breath' : undefined}
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            border: '2px solid var(--accent)',
            background: anyRunning ? 'var(--accent)' : 'transparent',
            flexShrink: 0,
          }}
          title={anyRunning ? t('toolGroup.someRunning') : undefined}
        />

        {/* Tool count chip */}
        <span
          style={{
            padding: '2px 8px',
            background: 'var(--accent)',
            color: '#000',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {t('toolGroup.count', { count: tools.length })}
        </span>

        {/* Summary */}
        <span
          style={{
            flex: 1,
            fontSize: 11,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={summary}
        >
          {summary}
        </span>

        {/* Expand toggle */}
        <span
          style={{
            width: 16,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 14,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {expanded ? '−' : '+'}
        </span>
      </button>

      {/* Expanded tool list */}
      {expanded && (
        <div
          className="tachi-wedge-down"
          style={{
            borderTop: '2px solid var(--border)',
            padding: '6px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            background: 'var(--bg-surface)',
          }}
        >
          {tools.map(tool => (
            <ToolCallBlock
              key={tool.id}
              name={tool.name}
              input={tool.input}
              output={tool.output}
              running={tool.running}
              aborted={tool.aborted}
              durationMs={tool.durationMs}
              progress={tool.progress}
            />
          ))}
        </div>
      )}
    </div>
  )
}
