// apps/desktop/src/pages/nodes/canvas/nodeTypes/InternetNode.tsx
//
// Internet tool node. Wire it to an agent to grant a `web_fetch` tool (fetch a
// public URL). Egress is gated by the app's egress policy — in PRIVATE MODE
// public fetches are blocked (loopback only).
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiInternetNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--warning)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', minWidth: 180, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }
const subStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block' }

export function InternetNode({ id, data }: NodeProps<TachiInternetNode>) {
  const { t } = useTranslation('nodes')
  const deleteNode = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)

  return (
    <div style={nodeStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className={hover ? 'tachi-node-hover' : undefined}>
      <div style={headerStyle}>
        <span>internet</span>
        {hover && (
          <button onClick={(e) => { e.stopPropagation(); deleteNode(id) }} className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}>×</button>
        )}
      </div>
      <div style={bodyStyle}>
        <span style={labelStyle}>{data.label}</span>
        <span style={subStyle}>{t('internetNode.grants')}</span>
        <span style={{ ...subStyle, color: 'var(--text-dim)', marginTop: 6, fontStyle: 'italic', fontSize: 9 }}>
          {t('internetNode.hint')}
        </span>
      </div>
      <EightHandles role="both" color={COLOR} />
    </div>
  )
}
