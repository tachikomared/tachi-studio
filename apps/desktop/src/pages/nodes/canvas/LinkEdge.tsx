// apps/desktop/src/pages/nodes/canvas/LinkEdge.tsx
//
// Replaces DeletableEdge as the default edge type. Adds:
//   1. Same hover/select × delete button at the midpoint as DeletableEdge.
//   2. A small "edit label" button (pencil affordance) next to it — click opens
//      EdgeSidecar anchored to the midpoint.
//   3. If edge.data.instruction is set, renders the first 20 chars as a label
//      badge on the edge path via EdgeLabelRenderer.
//
// Adapted from alookai/alook link-edge.tsx (MIT).

import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from '@xyflow/react'
import { useNodesStore } from '../store/nodes.store'
import { useNodesRunStore } from '../../../store/nodesRun.store'
import { EdgeSidecar } from './EdgeSidecar'
import { ERR_HANDLE_ID } from './errorBranch'
import { edgeRunChip, edgeRunTooltip } from './edgeRunInfo'

// EDGE RUN-INFO: below this zoom the mid-edge chips are hidden — at a far-out
// "whole graph" zoom they'd be unreadable clutter, so we only surface them once
// the user is close enough to read them.
const RUN_INFO_MIN_ZOOM = 0.5

export function LinkEdge(props: EdgeProps) {
  const { t } = useTranslation('nodes')
  const {
    id,
    source,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    sourceHandleId,
    selected,
    style,
    markerEnd,
    data,
  } = props

  // NODES-RESEARCH #6: an edge dragged from a node's ERROR output ('err') is an
  // ERROR-EDGE — paint it red + dashed so failure routing is visible on canvas.
  // Uses var(--error) with a --danger fallback (this build's semantic red).
  const isError = sourceHandleId === ERR_HANDLE_ID
  const errorColor = 'var(--error, var(--danger))'
  const ctlAccent = isError ? errorColor : 'var(--accent)'

  const deleteEdge        = useNodesStore(s => s.deleteEdge)
  const setEdgeInstruction = useNodesStore(s => s.setEdgeInstruction)

  // ── EDGE RUN-INFO (derived, never persisted) ────────────────────────────────
  // The size of the data flowing along this wire = the SOURCE node's last output
  // (or its error, for an error-edge). Selecting PRIMITIVES (a length, a boolean)
  // keeps each subscription Object.is-stable, so an edge only re-renders when its
  // own source's output size / error / running state actually changes.
  const srcOutLen = useNodesStore(s => {
    const n = s.nodes.find(x => x.id === source)
    const lo = (n?.data as { lastOutput?: unknown } | undefined)?.lastOutput
    return typeof lo === 'string' ? lo.length : 0
  })
  const srcErrLen = useNodesStore(s => {
    const n = s.nodes.find(x => x.id === source)
    const le = (n?.data as { lastError?: unknown } | undefined)?.lastError
    return typeof le === 'string' ? le.length : 0
  })
  // The whole graph re-renders on every zoom tick otherwise — select the boolean
  // threshold so edges only re-render when crossing it, not on every wheel step.
  const zoomOk = useStore(s => s.transform[2] >= RUN_INFO_MIN_ZOOM)
  // True while THIS edge's source node is the one currently executing → animate
  // its dashes so the data-flow direction is visible as the run advances.
  const sourceRunning = useNodesRunStore(s => s.activeNodeId != null && s.activeNodeId === source)

  const runChip = edgeRunChip({ isError, hasError: srcErrLen > 0, outLen: srcOutLen })

  const [hover,      setHover]      = useState(false)
  const [sidecarOpen, setSidecarOpen] = useState(false)

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  })

  const instruction = typeof data?.instruction === 'string' ? data.instruction : ''
  const badge       = instruction.trim().length > 0 ? instruction.slice(0, 20) : null

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    deleteEdge(id)
  }, [deleteEdge, id])

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setSidecarOpen(v => !v)
  }, [])

  const handleSave = useCallback((text: string) => {
    setEdgeInstruction(id, text)
    setSidecarOpen(false)
  }, [setEdgeInstruction, id])

  const showControls = selected || hover

  // Base edge style: error-edges paint red + dashed; while the source node is
  // running, ANY edge out of it gets marching-ants dashes so the data-flow
  // direction is visible. Inline style wins over the canvas' `.react-flow__edge-
  // path` rule; the dash MOTION is applied via the `.tachi-edge-flow` class
  // (globals.css) so it honours prefers-reduced-motion.
  const baseEdgeStyle: React.CSSProperties = isError
    ? { ...style, stroke: errorColor, strokeWidth: 2, strokeDasharray: '6 3' }
    : { ...style }
  if (sourceRunning) {
    baseEdgeStyle.stroke = isError ? errorColor : 'var(--accent)'
    baseEdgeStyle.strokeWidth = 2.5
    baseEdgeStyle.strokeDasharray = '7 5'
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={baseEdgeStyle}
        className={sourceRunning ? 'tachi-edge-flow' : undefined}
      />

      {/* Wide invisible hitbox so the edge is easy to hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />

      {/* Inline badge label — rendered even when not hovered */}
      {badge && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 16}px)`,
              pointerEvents: 'none',
              padding: '1px 5px',
              border: `var(--border-width) solid ${isError ? errorColor : 'var(--border)'}`,
              background: 'var(--bg-elevated)',
              color: isError ? errorColor : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              maxWidth: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {badge}{instruction.length > 20 ? '…' : ''}
          </span>
        </EdgeLabelRenderer>
      )}

      {/* EDGE RUN-INFO chip — the size of the data that flowed along this wire
          (or 'ERR' for an error-edge that carried an error). Rendered only when
          non-empty AND the zoom is close enough to read it. Sits just BELOW the
          midpoint so it never collides with the instruction badge (above) or the
          hover controls (centered). Inert (pointerEvents:none). */}
      {runChip && zoomOk && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan"
            title={edgeRunTooltip(runChip, runChip.danger ? srcErrLen : srcOutLen)}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 16}px)`,
              pointerEvents: 'none',
              padding: '0 4px',
              border: `var(--border-width) solid ${runChip.danger ? errorColor : 'var(--border)'}`,
              background: 'var(--bg-base)',
              color: runChip.danger ? errorColor : 'var(--text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: '0.06em',
              lineHeight: 1.7,
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
            }}
          >
            {runChip.text}
          </span>
        </EdgeLabelRenderer>
      )}

      {/* Controls: × delete + pencil edit */}
      {showControls && (
        <EdgeLabelRenderer>
          {/* Delete button — identical to DeletableEdge */}
          <button
            onClick={handleDelete}
            className="nodrag nopan"
            title={t('edge.removeConnection')}
            aria-label={t('edge.removeConnection')}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX + 12}px, ${labelY}px)`,
              pointerEvents: 'all',
              width: 18,
              height: 18,
              padding: 0,
              border: `2px solid ${ctlAccent}`,
              background: 'var(--bg-base)',
              color: ctlAccent,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1,
              cursor: 'pointer',
              boxShadow: '2px 2px 0 var(--border)',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            x
          </button>

          {/* Edit label button */}
          <button
            onClick={handleEditClick}
            className="nodrag nopan"
            title={t('edge.editLabel')}
            aria-label={t('edge.editLabel')}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX - 12}px, ${labelY}px)`,
              pointerEvents: 'all',
              width: 18,
              height: 18,
              padding: 0,
              border: `2px solid ${sidecarOpen ? 'var(--warning)' : 'var(--border)'}`,
              background: sidecarOpen ? 'var(--warning)' : 'var(--bg-base)',
              color: sidecarOpen ? '#000' : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
              cursor: 'pointer',
              boxShadow: '2px 2px 0 var(--border)',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            e
          </button>

          {/* Inline EdgeSidecar popover */}
          {sidecarOpen && (
            <EdgeSidecar
              x={labelX}
              y={labelY}
              initialValue={instruction}
              onSave={handleSave}
              onClose={() => setSidecarOpen(false)}
            />
          )}
        </EdgeLabelRenderer>
      )}
    </>
  )
}
