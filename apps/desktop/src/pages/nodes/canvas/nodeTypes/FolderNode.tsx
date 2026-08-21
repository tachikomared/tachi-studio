// apps/desktop/src/pages/nodes/canvas/nodeTypes/FolderNode.tsx
//
// Folder (workspace) tool node. Wire it to an agent to give that agent a
// sandboxed working directory — its file tools (granted by a Role node) can
// only read/write inside this path.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiFolderNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--success)'

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

export function FolderNode({ id, data }: NodeProps<TachiFolderNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)
  const path = typeof data.path === 'string' ? data.path : ''

  const choose = async () => {
    try {
      const picked = await window.tachi.agent.pickFolder()
      if (picked) updateNodeData(id, { path: picked })
    } catch { /* user cancelled */ }
  }

  return (
    <div style={nodeStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className={hover ? 'tachi-node-hover' : undefined}>
      <div style={headerStyle}>
        <span>{t('folderNode.header')}</span>
        {hover && (
          <button onClick={(e) => { e.stopPropagation(); deleteNode(id) }} className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}>×</button>
        )}
      </div>
      <div style={bodyStyle}>
        <span style={labelStyle}>{data.label}</span>
        <span style={{ ...subStyle, color: COLOR, wordBreak: 'break-all', marginBottom: 6 }}>
          {path ? path : t('folderNode.noFolder')}
        </span>
        <button onClick={choose} className="nodrag" title={t('folderNode.pickTitle')}
          style={{ width: '100%', padding: '4px 6px', border: `2px solid ${COLOR}`, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer' }}>
          {path ? t('folderNode.change') : t('folderNode.choose')}
        </button>
        <span style={{ ...subStyle, color: 'var(--text-dim)', marginTop: 6, fontStyle: 'italic', fontSize: 9 }}>
          {t('folderNode.hint')}
        </span>
      </div>
      <EightHandles role="both" color={COLOR} />
    </div>
  )
}
