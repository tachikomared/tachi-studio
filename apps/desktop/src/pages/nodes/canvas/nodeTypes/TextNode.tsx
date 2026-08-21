// apps/desktop/src/pages/nodes/canvas/nodeTypes/TextNode.tsx
//
// Text node — a STATIC text input. Type a topic / brief / context block; the
// text IS the node's output (no model call, no Run). It mirrors into `lastOutput`
// so any downstream node resolves it instantly through `@` / `{{node:<id>}}`
// tokens, through the prompt-plug feeder when wired into a Media node, or as
// upstream context. Use it to tell a Prompt node what to write about, or to drop
// reusable context into many prompts.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiTextNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--success)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 230, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const labelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginBottom: 3,
}
const taStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: 84, padding: '6px 8px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, lineHeight: 1.4, resize: 'vertical',
}
const hintStyle: React.CSSProperties = {
  marginTop: 5, fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)',
}

export function TextNode({ id, data }: NodeProps<TachiTextNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)

  const text = typeof data.text === 'string' ? data.text : ''
  const chars = text.trim().length

  // The text IS the output → mirror into `lastOutput` so the reference system
  // ({{node:<id>}} tokens, the @ picker, and the prompt-plug feeder) resolves it
  // with no Run. outputsFromFlow() reads lastOutput unconditionally.
  const onChange = (v: string) => updateNodeData(id, { text: v, lastOutput: v })

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>text{chars > 0 ? ` · ${chars}` : ''}</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        <label style={labelStyle}>{t('textNode.label')}</label>
        <textarea
          className="nodrag"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('textNode.placeholder')}
          style={taStyle}
        />
        <div style={hintStyle}>
          {t('textNode.hintBefore')}<strong style={{ color: COLOR }}>@</strong>{t('textNode.hintAfter')}
        </div>
      </div>

      {/* Source-only: a Text node feeds downstream nodes (never receives). */}
      <EightHandles role="source" color={COLOR} />
    </div>
  )
}
