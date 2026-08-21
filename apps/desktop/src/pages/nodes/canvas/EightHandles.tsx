// apps/desktop/src/pages/nodes/canvas/EightHandles.tsx
//
// Sprint A · A4 — eight invisible connection handles per node.
//
// Adapted from alookai/alook (Apache-2.0) — they place a handle at each of
// the 8 cardinal+ordinal positions (N, NE, E, SE, S, SW, W, NW) and rely on
// `connectionMode="loose"` so a single handle can serve both source and
// target roles. The user just drags from one node to another without picking
// a side, and we auto-route in `onConnect` (in nodes.store) to the closest
// pair based on the node geometry.
//
// Handles are invisible by default and fade in on parent hover via a CSS
// class added by the node component. The hover affordance is purely visual
// — the underlying pickable areas are always present, so drag-from-anywhere
// works whether or not the user sees the dots.
//
// Each node uses a single Source-only / Target-only / Both role depending
// on its place in the data flow (provider → agent → permission).

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position } from '@xyflow/react'
import { ERR_HANDLE_ID } from './errorBranch'

// 8 positions × { offset along node side as a fraction (0..1) } —
// ReactFlow accepts `style={{ top, left, right, bottom }}` for fine placement.
//
// We expose three positions per side instead of just one. The handle IDs
// encode position and role so onConnect can identify them in store.
//
// Naming: `<side>-<index>` where index ∈ { 0, 1, 2 } (start | center | end).
// The 8 distinct positions are: N0/N1/N2 (top), E0/E1/E2 (right),
// S0/S1/S2 (bottom), W0/W1/W2 (left) — but we use just one mid-side
// handle for "anchored" rendering and one corner handle per corner =
// 8 total: N, NE, E, SE, S, SW, W, NW.
type Spot = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'

interface SpotLayout {
  position: Position
  style:    React.CSSProperties
}

const LAYOUT: Record<Spot, SpotLayout> = {
  N:  { position: Position.Top,    style: { left: '50%' } },
  NE: { position: Position.Top,    style: { left: '90%' } },
  E:  { position: Position.Right,  style: { top:  '50%' } },
  SE: { position: Position.Bottom, style: { left: '90%' } },
  S:  { position: Position.Bottom, style: { left: '50%' } },
  SW: { position: Position.Bottom, style: { left: '10%' } },
  W:  { position: Position.Left,   style: { top:  '50%' } },
  NW: { position: Position.Top,    style: { left: '10%' } },
}

const SPOTS: Spot[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

// ─── Styles ──────────────────────────────────────────────────────────────────
//
// Hidden by default; the parent node toggles `.tachi-node-hover` on hover
// to fade us in.  Pointer-events stay enabled even when invisible so the
// connection target remains clickable — the dot itself just isn't drawn.

const baseHandleStyle = (color: string): React.CSSProperties => ({
  width:       12,
  height:      12,
  background:  color,
  border:      '2px solid var(--bg-base)',
  borderRadius: 0,
  opacity:     0,
  transition:  'opacity 120ms ease-out',
  // pointerEvents stays default ('all') so users can drag from anywhere on
  // the perimeter even before the visible affordance fades in.
})

interface EightHandlesProps {
  /** ReactFlow handle role: source-only, target-only, or both (one of each at each spot). */
  role:  'source' | 'target' | 'both'
  /** Handle accent — typically matches the node's border color. */
  color: string
}

export function EightHandles({ role, color }: EightHandlesProps) {
  return (
    <>
      {SPOTS.map(spot => {
        const layout = LAYOUT[spot]
        const style  = { ...baseHandleStyle(color), ...layout.style }
        if (role === 'both') {
          // Render BOTH a source and a target so the spot accepts incoming
          // and outgoing connections. ReactFlow needs distinct handle ids per
          // node, so we encode the role into the id.
          return (
            <React.Fragment key={spot}>
              <Handle
                id={`${spot}-src`}
                type="source"
                position={layout.position}
                style={style}
                className="tachi-handle-8"
              />
              <Handle
                id={`${spot}-tgt`}
                type="target"
                position={layout.position}
                style={style}
                className="tachi-handle-8"
              />
            </React.Fragment>
          )
        }
        return (
          <Handle
            key={spot}
            id={`${spot}-${role === 'source' ? 'src' : 'tgt'}`}
            type={role}
            position={layout.position}
            style={style}
            className="tachi-handle-8"
          />
        )
      })}
      {/*
        Local <style> tag activates handle visibility when the parent node
        is hovered. Scoped via .tachi-node-hover ancestor selector so it
        doesn't bleed onto handle-painting elsewhere.
      */}
      <style>{`
        .tachi-node-hover .tachi-handle-8 { opacity: 1 !important; }
      `}</style>
    </>
  )
}

// ─── Auto-routing helper ─────────────────────────────────────────────────────
//
// Given two node bounding rects, pick the (sourceSpot, targetSpot) pair whose
// world positions are closest. This is what onConnect calls after the user
// finishes dragging — we ignore whichever handle they happened to grab and
// replace the connection with the geometrically-shortest pairing.
//
// Why this matters: with 8 invisible handles, the user effectively drags
// "from anywhere on the source to anywhere on the target". We don't want
// ugly edge crossings — picking the closest spots gives clean routing for
// free without ELK or other layout libraries.

interface NodeRect { x: number; y: number; w: number; h: number }

function spotWorldPos(rect: NodeRect, spot: Spot): { x: number; y: number } {
  const { x, y, w, h } = rect
  switch (spot) {
    case 'N':  return { x: x + w / 2, y }
    case 'NE': return { x: x + w * 0.9, y }
    case 'E':  return { x: x + w,     y: y + h / 2 }
    case 'SE': return { x: x + w * 0.9, y: y + h }
    case 'S':  return { x: x + w / 2, y: y + h }
    case 'SW': return { x: x + w * 0.1, y: y + h }
    case 'W':  return { x,             y: y + h / 2 }
    case 'NW': return { x: x + w * 0.1, y }
  }
}

/**
 * Pick the closest source/target spot pair for two nodes.
 * Returns the corresponding handle IDs.
 */
export function nearestHandlePair(srcRect: NodeRect, tgtRect: NodeRect): {
  sourceHandle: string
  targetHandle: string
} {
  let best = { src: 'E' as Spot, tgt: 'W' as Spot, d: Number.POSITIVE_INFINITY }
  for (const s of SPOTS) {
    const sp = spotWorldPos(srcRect, s)
    for (const t of SPOTS) {
      const tp = spotWorldPos(tgtRect, t)
      const dx = sp.x - tp.x
      const dy = sp.y - tp.y
      const d  = dx * dx + dy * dy
      if (d < best.d) best = { src: s, tgt: t, d }
    }
  }
  return {
    sourceHandle: `${best.src}-src`,
    targetHandle: `${best.tgt}-tgt`,
  }
}

/** Approximate bounding rect — provider/agent/permission nodes are all roughly
 *  this size. Used when we don't have a measured DOM rect handy. */
export const APPROX_NODE_RECT = { w: 180, h: 84 } as const

// ─── ErrorHandle (NODES-RESEARCH #6) ──────────────────────────────────────────
//
// The extra ERROR source handle every runnable node (prompt/agent/media) renders
// in addition to its normal plugs. It is:
//   - id 'err' (ERR_HANDLE_ID) — the fixed id the run loop + edge styling match on
//   - a SOURCE (error text flows OUT of the failed node into the wired handler)
//   - small + var(--error)-colored (falls back to --danger, the theme's semantic
//     red, since this build aliases red as --danger) + corner-placed (bottom-right)
//   - invisible until the parent node is hovered, exactly like the 8 handles
//     (its own `.tachi-node-hover .tachi-handle-err` rule mirrors tachi-handle-8)
//
// Dragging FROM it makes an ERROR-EDGE; the store's onConnect preserves the 'err'
// sourceHandle (it never gets rewritten by the geometric auto-router), LinkEdge
// paints such edges red, and Run-all routes the error text through them.

/** Small red ERROR output handle, corner-placed, hover-revealed. */
export function ErrorHandle({ title }: { title?: string }) {
  const { t } = useTranslation('nodes')
  const tip = title ?? t('errorBranch.handleTooltip', {
    defaultValue: 'Error output — wire to a node that should run only when this node fails',
  })
  return (
    <>
      <Handle
        id={ERR_HANDLE_ID}
        type="source"
        position={Position.Right}
        className="tachi-handle-err"
        title={tip}
        style={{
          width: 10,
          height: 10,
          // Bottom-right corner — clear of the E (50%) / SE (bottom) handles and
          // of the media node's `out` plug (top: 26).
          top: '86%',
          background: 'var(--error, var(--danger))',
          border: '2px solid var(--bg-base)',
          borderRadius: 0,
          opacity: 0,
          transition: 'opacity 120ms ease-out',
        }}
      />
      <style>{`.tachi-node-hover .tachi-handle-err { opacity: 1 !important; }`}</style>
    </>
  )
}
