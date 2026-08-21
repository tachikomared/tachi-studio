// apps/desktop/src/pages/nodes/canvas/nodeTypes/McpNode.tsx
//
// MCP tool node. Wire it to an agent to expose a Model-Context-Protocol
// server's tools to that agent. Leave the URL blank to use the app's built-in
// MCP server; or point it at any streamable-http MCP endpoint.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiMcpNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--accent)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', minWidth: 190, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }
const subStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block' }

export function McpNode({ id, data }: NodeProps<TachiMcpNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)
  const url = typeof data.url === 'string' ? data.url : ''

  return (
    <div style={nodeStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className={hover ? 'tachi-node-hover' : undefined}>
      <div style={headerStyle}>
        <span>mcp</span>
        {hover && (
          <button onClick={(e) => { e.stopPropagation(); deleteNode(id) }} className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}>×</button>
        )}
      </div>
      <div style={bodyStyle}>
        <span style={labelStyle}>{data.label}</span>
        <input
          className="nodrag"
          value={url}
          onChange={(e) => updateNodeData(id, { url: e.target.value })}
          placeholder={t('mcpNode.urlPlaceholder')}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 2, padding: '3px 6px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, outline: 'none' }}
        />
        <span style={{ ...subStyle, color: 'var(--text-dim)', marginTop: 6, fontStyle: 'italic', fontSize: 9 }}>
          {t('mcpNode.hint')}
        </span>
      </div>
      <EightHandles role="both" color={COLOR} />
    </div>
  )
}
