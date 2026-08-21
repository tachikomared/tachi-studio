// apps/desktop/src/components/Sparkline.tsx
//
// btop-style inline sparkline rendered as a compact SVG polyline.
//
// Design notes:
//   - SVG polyline rather than Unicode braille: SVG scales cleanly at any pixel
//     density, clips exactly to the requested width x height, and is trivially
//     styled with var(--*) tokens. Braille blocks require exact character-cell
//     math that varies by font renderer; SVG is the crisper choice for the
//     JetBrains Mono brutalist context.
//   - The component is display:inline-block with vertical-align:middle so it
//     can sit inline with monospace label text in a Row or similar container.
//   - No deps. Zero imports outside React.
//
// Props:
//   values  — array of numeric data points (sparse/NaN values are skipped)
//   width   — pixel width of the SVG (default 60)
//   height  — pixel height of the SVG (default 18)
//   color   — stroke color; defaults to var(--accent)
//
// Usage:
//   <Sparkline values={[10, 20, 15, 30, 25]} />
//   <Sparkline values={throughputSamples} width={80} height={20} color="var(--success)" />

import React, { useMemo } from 'react'
import { lttb } from '../utils/lttb'

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
}

// Internal padding so the line does not clip against the SVG edge at peak.
const PAD = 2

export function Sparkline({ values, width = 60, height = 18, color = 'var(--accent)' }: SparklineProps) {
  const points = useMemo(() => {
    // Filter out non-finite values but preserve the original index so horizontal
    // spacing reflects real time gaps rather than compressing missing samples.
    const valid = values.map((v, i) => ({ v, i })).filter(d => Number.isFinite(d.v))
    if (valid.length < 2) return null

    const totalSlots = values.length - 1   // denominator for x-mapping
    if (totalSlots < 1) return null

    // Inner drawing area after padding
    const drawW = width  - PAD * 2
    const drawH = height - PAD * 2

    // LTTB downsampling: an SVG polyline can resolve at most ~1 vertex per inner
    // pixel; beyond that, extra vertices are sub-pixel noise that only bloats the
    // points string. Downsample (shape-preserving — peaks survive) once there is
    // more than ~2x the inner-pixel budget of data. {x,y} form keeps the
    // original index in x so horizontal spacing is unchanged.
    const budget = Math.max(3, Math.floor(drawW))
    const drawn = valid.length > budget * 2
      ? lttb(valid.map(d => ({ x: d.i, y: d.v })), budget)
      : valid.map(d => ({ x: d.i, y: d.v }))

    const minV = Math.min(...drawn.map(d => d.y))
    const maxV = Math.max(...drawn.map(d => d.y))
    const rangeV = maxV - minV || 1        // guard against flat line (all equal)

    return drawn.map(({ x: i, y: v }) => {
      const x = PAD + (i / totalSlots) * drawW
      // y=0 is top in SVG; invert so higher value = higher on screen.
      const y = PAD + drawH - ((v - minV) / rangeV) * drawH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }, [values, width, height])

  if (!points) {
    // Not enough data: render a flat dim line as a placeholder.
    const midY = (height / 2).toFixed(1)
    return (
      <svg
        width={width}
        height={height}
        style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
        aria-hidden="true"
      >
        <line
          x1={PAD}
          y1={midY}
          x2={width - PAD}
          y2={midY}
          stroke="var(--border)"
          strokeWidth={1}
        />
      </svg>
    )
  }

  return (
    <svg
      width={width}
      height={height}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      aria-hidden="true"
    >
      {/* Subtle filled area below the line — low-opacity tint of the line color */}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
