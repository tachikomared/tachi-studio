// apps/desktop/src/pages/nodes/canvas/nodeTypes/SkillNode.tsx
//
// Repurposed from "Skill" → "Permission". Each tile constrains what an
// upstream agent is allowed to do: read-only, read+edit, full, or specific
// extensions (web-search etc).
//
// Color hints at risk level so a quick scan tells you which agents are
// running unrestricted:
//   read-only  → success (green, safe)
//   edit       → warning (yellow, mutates state)
//   full       → danger  (red, can run shell)
//   web-search → accent  (neutral capability extension)
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiSkillNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'
import { QuickAddPlus } from '../QuickAddPlus'

// Map permission-tier id → semantic color used for border/handle/header.
function colorForTier(skillId: string): string {
  if (skillId === 'read-only')  return 'var(--success)'
  if (skillId === 'edit')       return 'var(--warning)'
  if (skillId === 'full')       return 'var(--danger, #ff5252)'
  if (skillId === 'web-search') return 'var(--accent)'
  return 'var(--success)' // fallback for legacy "skill" saves
}

export function SkillNode({ id, data }: NodeProps<TachiSkillNode>) {
  const { t } = useTranslation('nodes')
  const deleteNode = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)
  const color = colorForTier(data.skillId ?? 'read-only')

  const nodeStyle: React.CSSProperties = {
    position: 'relative',
    background: 'var(--bg-surface)',
    border: `2px solid ${color}`,
    fontFamily: 'JetBrains Mono, monospace',
    minWidth: 170,
    boxShadow: `4px 4px 0 ${color}`,
  }

  const headerStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderBottom: `2px solid ${color}`,
    background: color,
    color: 'var(--bg-base)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  }

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>permission</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag"
            title={t('node.delete')}
            aria-label={t('node.delete')}
            style={{
              width: 16, height: 16, padding: 0,
              border: 'var(--border-width) solid var(--bg-base)',
              background: 'transparent', color: 'var(--bg-base)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800,
              lineHeight: 1, cursor: 'pointer',
            }}
          >×</button>
        )}
      </div>
      <div style={{ padding: '8px 10px' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }}>
          {data.label}
        </span>
        {data.description && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginTop: 2, fontStyle: 'italic' }}>
            {data.description}
          </span>
        )}
        {Array.isArray(data.allowedTools) && data.allowedTools.length > 0 && (
          <div style={{
            marginTop: 6,
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
          }}>
            {data.allowedTools.map(tool => (
              <span
                key={tool}
                style={{
                  fontSize: 9,
                  padding: '1px 4px',
                  border: `var(--border-width) solid ${color}`,
                  color,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'lowercase',
                }}
              >{tool}</span>
            ))}
          </div>
        )}
      </div>
      {/* Role/permission nodes connect to agents in EITHER direction (role->agent
          or agent->role), so expose both source and target handles. The compiler
          resolves the link regardless of direction. */}
      <EightHandles role="both" color={color} />
      {/* Twenty-style hover "+" — add + auto-connect a node below this one. */}
      <QuickAddPlus sourceId={id} color={color} />
    </div>
  )
}
