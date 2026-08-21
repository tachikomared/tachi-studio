// apps/desktop/src/pages/nodes/canvas/nodeTypes/SubflowNode.tsx
//
// NODES-RESEARCH #8 — SUBFLOWS v1 (VISUAL COLLAPSE ONLY). A proxy tile that
// stands in for a set of collapsed child nodes. `collapseSelectionToSubflow`
// hides the children (and their edges) and drops this box at the selection
// centroid; the edges are only HIDDEN, never re-wired, so Run-all still executes
// the collapsed nodes normally. The card shows an editable group label, an
// "N NODES" count chip, and an EXPAND button that restores the children.
//
// Deliberately has NO connection handles — it is a grouping affordance, not a
// data-flow node (mirrors the sticky NoteNode's no-run, no-wire contract).
import React from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiSubflowNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'

const COLOR = 'var(--accent)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', width: 210, background: 'var(--bg-surface)',
  border: `2px solid ${COLOR}`, boxShadow: `4px 4px 0 ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', boxSizing: 'border-box',
}
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }
const labelInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 7px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, outline: 'none',
}
const chipStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
  padding: '2px 6px', border: `2px solid ${COLOR}`, color: COLOR,
  fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap',
}
const expandBtnStyle: React.CSSProperties = {
  marginLeft: 'auto', height: 22, padding: '0 10px',
  border: `2px solid ${COLOR}`, background: 'transparent', color: COLOR,
  fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
  letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
}

export function SubflowNode({ id, data }: NodeProps<TachiSubflowNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const expandSubflow  = useNodesStore(s => s.expandSubflow)

  const label = typeof data.label === 'string' ? data.label : ''
  const count = Array.isArray(data.childIds) ? data.childIds.length : 0

  return (
    <div style={nodeStyle}>
      <div style={headerStyle}>
        <span>{t('subflowNode.badge', { defaultValue: 'Subflow' })}</span>
      </div>

      <div style={bodyStyle}>
        <input
          className="nodrag"
          value={label}
          onChange={(e) => updateNodeData(id, { label: e.target.value })}
          placeholder={t('subflowNode.labelPlaceholder', { defaultValue: 'Subflow' })}
          aria-label={t('subflowNode.labelAria', { defaultValue: 'Subflow label' })}
          style={labelInputStyle}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={chipStyle}>{t('subflowNode.count', { n: count, defaultValue: '{{n}} nodes' })}</span>
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); expandSubflow(id) }}
            title={t('subflowNode.expandTitle', { defaultValue: 'Expand — restore the collapsed nodes and their connections' })}
            style={expandBtnStyle}
          >
            {t('subflowNode.expand', { defaultValue: 'Expand' })}
          </button>
        </div>

        <div style={{ fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)' }}>
          {t('subflowNode.hint', { defaultValue: 'Collapsed group. The hidden nodes still run with the flow.' })}
        </div>
      </div>
    </div>
  )
}
