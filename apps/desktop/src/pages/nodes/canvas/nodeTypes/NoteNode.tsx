// apps/desktop/src/pages/nodes/canvas/nodeTypes/NoteNode.tsx
//
// NODES-RESEARCH #7 — sticky NOTE node. A brutalist annotation tile for
// sectioning / labelling the canvas: a tinted sticky with editable multiline
// text and NO run semantics. It carries no handles, never wires into a flow,
// is skipped by Run-all / chains / cost estimation, and sits BEHIND other nodes
// (the node's top-level zIndex is set to -1 in the store on create) so it reads
// as a background label. Resizable via @xyflow/react's NodeResizer — the node's
// top-level width/height persist through the flow round-trip automatically.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { TachiNoteNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { nodesInsideNote } from '../noteGroup'

/**
 * Tint presets. Each maps a key (stored in data.color) to a brutalist accent
 * border + a low-mix tinted background derived from the theme's accent vars, so
 * notes stay theme-aware (light/dark) with no hard-coded colours. Clicking the
 * header swatch cycles through these in order.
 */
export interface NoteTint {
  key: string
  border: string
  bg: string
}
export const NOTE_TINTS: readonly NoteTint[] = [
  { key: 'amber', border: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning) 16%, var(--bg-surface))' },
  { key: 'blue',  border: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 16%, var(--bg-surface))' },
  { key: 'green', border: 'var(--success)', bg: 'color-mix(in srgb, var(--success) 16%, var(--bg-surface))' },
  { key: 'pink',  border: 'var(--danger)',  bg: 'color-mix(in srgb, var(--danger) 16%, var(--bg-surface))' },
]
/** Ordered tint keys — the default (index 0) is used when data.color is unset. */
export const NOTE_TINT_KEYS: readonly string[] = NOTE_TINTS.map(t => t.key)

function tintFor(color: string | undefined): NoteTint {
  return NOTE_TINTS.find(t => t.key === color) ?? NOTE_TINTS[0]!
}
/** The tint key one step after `color` (wraps) — powers the swatch cycle. */
function nextTintKey(color: string | undefined): string {
  const i = Math.max(0, NOTE_TINTS.findIndex(t => t.key === (color ?? NOTE_TINTS[0]!.key)))
  return NOTE_TINTS[(i + 1) % NOTE_TINTS.length]!.key
}

export function NoteNode({ id, data, selected }: NodeProps<TachiNoteNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)

  // NODES-RESEARCH #7 (parenting groups): how many nodes this note currently
  // carries. A selector returning the plain count re-renders only when it flips
  // across a change (not on every store tick). Drives the ⚓ header indicator +
  // the drag-hint tooltip; the actual carry happens in FlowCanvas's drag handlers.
  const memberCount = useNodesStore(s => {
    const note = s.nodes.find(n => n.id === id)
    return note ? nodesInsideNote(note, s.nodes).length : 0
  })

  const text = typeof data.text === 'string' ? data.text : ''
  const tint = tintFor(typeof data.color === 'string' ? data.color : undefined)

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    minWidth: 120,
    minHeight: 80,
    display: 'flex',
    flexDirection: 'column',
    background: tint.bg,
    border: `2px solid ${tint.border}`,
    boxShadow: `4px 4px 0 ${tint.border}`,
    fontFamily: 'JetBrains Mono, monospace',
    boxSizing: 'border-box',
  }
  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
    padding: '3px 6px', borderBottom: `2px solid ${tint.border}`, flexShrink: 0,
  }
  const microLabel: React.CSSProperties = {
    fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
    color: 'var(--text-dim)',
  }

  return (
    <>
      {/* Freeform resize — controls only show when the note is selected (which
          also elevates it above other nodes so the handles are reachable). */}
      <NodeResizer
        isVisible={!!selected}
        color={tint.border}
        minWidth={120}
        minHeight={80}
        handleStyle={{ width: 8, height: 8, borderRadius: 0, background: tint.border }}
        lineStyle={{ borderColor: tint.border }}
      />

      <div
        style={containerStyle}
        title={memberCount > 0
          ? t('noteNode.dragHint', { defaultValue: 'Drag moves the nodes inside this note too. Hold Alt to move only the note.' })
          : undefined}
      >
        <div style={headerStyle}>
          <button
            onClick={(e) => { e.stopPropagation(); updateNodeData(id, { color: nextTintKey(data.color) }) }}
            className="nodrag"
            title={t('noteNode.cycleColor', { defaultValue: 'Change color' })}
            aria-label={t('noteNode.cycleColor', { defaultValue: 'Change color' })}
            style={{
              width: 14, height: 14, padding: 0, flexShrink: 0,
              border: '2px solid var(--text-dim)', background: tint.border, cursor: 'pointer',
            }}
          />
          <span style={microLabel}>{t('noteNode.badge', { defaultValue: 'NOTE' })}</span>
          {/* NODES-RESEARCH #7: ⚓ = this note currently anchors ≥1 node; they
              ride with it on drag (Alt-drag to move only the note). */}
          {memberCount > 0 && (
            <span
              title={t('noteNode.anchor', { count: memberCount, defaultValue: 'Anchors {{count}} node(s) — they move with this note' })}
              aria-label={t('noteNode.anchor', { count: memberCount, defaultValue: 'Anchors {{count}} node(s) — they move with this note' })}
              style={{ ...microLabel, color: tint.border, fontSize: 10 }}
            >⚓{memberCount}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{
              width: 14, height: 14, padding: 0, flexShrink: 0,
              border: '2px solid var(--text-dim)', background: 'transparent', color: 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer',
            }}
          >×</button>
        </div>

        <textarea
          className="nodrag nowheel"
          value={text}
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          placeholder={t('noteNode.placeholder', { defaultValue: 'Sticky note — jot a label, a to-do, or context. Not part of the run.' })}
          style={{
            flex: 1, width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            border: 'none', background: 'transparent', color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11, lineHeight: 1.4, resize: 'none', outline: 'none',
          }}
        />
      </div>
    </>
  )
}
