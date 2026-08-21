// apps/desktop/src/utils/lttb.ts
//
// Largest-Triangle-Three-Buckets downsampling. Ported from
// .research-tmp/repos/Pulse/internal/monitoring/lttb.go (87-line Go original):
// equal-width buckets, pick the point per bucket that maximises the triangle
// area against the previously-selected point and the next bucket's average,
// endpoints always preserved.
//
// Reduces a series to ~targetCount points while keeping its visual shape —
// peaks and valleys survive where naive every-Nth sampling would drop them.
// The renderer (Sparkline) uses this so a long run-trace doesn't emit one SVG
// vertex per sample.
//
// Two input shapes are supported and the output mirrors the input shape:
//   - number[]            — y values, x is the implicit index
//   - {x: number; y: number}[]
//
// Contract (matches the Go):
//   - targetCount >= length  -> input returned unchanged (same reference)
//   - targetCount < 3        -> input returned unchanged (can't form buckets)
//   - otherwise              -> exactly targetCount points, first + last kept,
//                               every emitted point is one of the originals.

export type Point = { x: number; y: number }

export function lttb(points: number[], targetCount: number): number[]
export function lttb(points: Point[], targetCount: number): Point[]
export function lttb(points: number[] | Point[], targetCount: number): number[] | Point[] {
  const n = points.length
  // Go: if targetPoints >= n || targetPoints < 3 { return data }
  if (targetCount >= n || targetCount < 3) return points

  const isNum = typeof points[0] === 'number'
  const xOf = (i: number): number => (isNum ? i : (points[i] as Point).x)
  const yOf = (i: number): number => (isNum ? (points[i] as number) : (points[i] as Point).y)

  const result: number[] = []

  // Always keep the first point.
  result.push(0)

  const bucketSize = (n - 2) / (targetCount - 2)
  let prevSelected = 0

  for (let i = 0; i < targetCount - 2; i++) {
    // Current bucket range.
    let bucketStart = Math.floor(i * bucketSize) + 1
    let bucketEnd = Math.floor((i + 1) * bucketSize) + 1
    if (bucketEnd > n - 1) bucketEnd = n - 1

    // Next bucket range — used to compute the "third point" average.
    let nextStart = bucketEnd
    let nextEnd = Math.floor((i + 2) * bucketSize) + 1
    if (nextEnd > n - 1) nextEnd = n - 1
    if (nextStart >= nextEnd) {
      nextEnd = nextStart + 1
      if (nextEnd > n) nextEnd = n
    }

    // Average of the next bucket (the "C" vertex of the triangle).
    let avgX = 0
    let avgY = 0
    const nextCount = nextEnd - nextStart
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += xOf(j)
      avgY += yOf(j)
    }
    avgX /= nextCount
    avgY /= nextCount

    // Previously selected point (the "A" vertex).
    const aX = xOf(prevSelected)
    const aY = yOf(prevSelected)

    // Find the point in the current bucket that maximises the triangle area.
    let maxArea = -1
    let bestIdx = bucketStart
    for (let j = bucketStart; j < bucketEnd; j++) {
      const bX = xOf(j)
      const bY = yOf(j)
      // Twice the triangle area; sign doesn't matter, we compare magnitudes.
      const area = Math.abs((aX - avgX) * (bY - aY) - (aX - bX) * (avgY - aY))
      if (area > maxArea) {
        maxArea = area
        bestIdx = j
      }
    }

    result.push(bestIdx)
    prevSelected = bestIdx
  }

  // Always keep the last point.
  result.push(n - 1)

  // Materialise the picked indices back into the input's shape.
  if (isNum) return result.map(idx => points[idx] as number)
  return result.map(idx => points[idx] as Point)
}
