// apps/desktop/src/pages/nodes/canvas/DeletableEdge.tsx
//
// Custom ReactFlow edge that renders a small × button at the midpoint when
// the edge is selected or hovered. Click → remove the edge from the store.
//
// We prefer a click-on-edge → × button over keyboard-only delete because new
// users don't discover the "click + Delete" gesture; the visible button is
// brutalist-honest about the affordance.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import { useNodesStore } from '../store/nodes.store'

export function DeletableEdge(props: EdgeProps) {
  const { t } = useTranslation('nodes')
  const {
    id,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    selected,
    style,
    markerEnd,
  } = props

  const deleteEdge = useNodesStore(s => s.deleteEdge)
  const [hover, setHover] = useState(false)

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  })

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
      />

      {/* Invisible-but-clickable wide hitbox so users don't have to land on
          the 2px stroke. ReactFlow renders this as part of the edge group;
          it inherits selection on click. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />

      {(selected || hover) && (
        <EdgeLabelRenderer>
          <button
            onClick={(e) => { e.stopPropagation(); deleteEdge(id) }}
            className="nodrag nopan"
            title={t('edge.removeConnection')}
            aria-label={t('edge.removeConnection')}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              width: 18,
              height: 18,
              padding: 0,
              border: '2px solid var(--accent)',
              background: 'var(--bg-base)',
              color: 'var(--accent)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1,
              cursor: 'pointer',
              boxShadow: '2px 2px 0 var(--border)',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >×</button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
