// apps/desktop/src/pages/nodes/canvas/nodeTypes/UnknownNode.tsx
//
// Unknown node — the SELF-HEALING fallback tile (NODES-RESEARCH #3). When a flow
// is loaded whose node carries a `type` this build doesn't register, sanitizeFlow
// remaps it to 'unknown', stashing the real type in data.originalType and keeping
// every other field verbatim. This card makes the situation legible: the node is
// PRESERVED (its data round-trips losslessly on save/export) but INERT (skipped
// by runs — it's not one of the runnable node types). Its 8 handles stay live so
// the surrounding wiring keeps rendering.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiUnknownNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--warning)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 220, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const titleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--text-primary)', lineHeight: 1.3, wordBreak: 'break-word',
}
const labelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginTop: 8, marginBottom: 3,
}
const originalStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: COLOR,
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  padding: '3px 6px', display: 'inline-block', maxWidth: '100%',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const hintStyle: React.CSSProperties = {
  marginTop: 8, fontSize: 8, lineHeight: 1.5, color: 'var(--text-dim)',
}

export function UnknownNode({ id, data }: NodeProps<TachiUnknownNode>) {
  const { t } = useTranslation('nodes')
  const deleteNode = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)

  const originalType = typeof data.originalType === 'string' && data.originalType
    ? data.originalType
    : '—'

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>unknown</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        <div style={titleStyle}>{t('unknownNode.title', { defaultValue: 'Unknown node' })}</div>
        <label style={labelStyle}>{t('unknownNode.originalTypeLabel', { defaultValue: 'Original type' })}</label>
        <span style={originalStyle} title={originalType}>{originalType}</span>
        <div style={hintStyle}>
          {t('unknownNode.hint', { defaultValue: "This node type isn't registered in this build. Its data is preserved and it's skipped when the flow runs." })}
        </div>
      </div>

      {/* Keep both roles live so the node's existing wiring still renders. */}
      <EightHandles role="both" color={COLOR} />
    </div>
  )
}
