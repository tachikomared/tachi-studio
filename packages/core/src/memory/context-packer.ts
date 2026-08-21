// packages/core/src/memory/context-packer.ts
//
// Read-time context packer for recalled memory items under a character budget.
// Lives in @tachi/core so BOTH the renderer and the Electron main process can
// import it (it started in apps/desktop/src/utils, which main can't reach).
//
// CLEAN-ROOM re-implementation of the algorithm described in the Memoh research
// (memohai/Memoh is AGPL-3.0 — this is an independent TypeScript implementation
// of the IDEA, NOT a port of their Go code). Goal: turn a scored list of
// recalled items into a bounded prompt region that maximizes useful coverage
// AND keeps the strongest items where models actually read them.
//
// Four phases:
//   1. Greedy add the highest-scored items at a per-item character cap, until
//      the target count or the total budget is hit.
//   2. If still under the target count, compress already-selected items toward
//      a floor to free budget for one more item.
//   3. Redistribute any leftover budget by re-expanding kept items back up to
//      the per-item cap, in rank order.
//   4. Anti "lost-in-the-middle" reorder: place the strongest items at BOTH the
//      head and the tail so they don't sink into the ignored middle.
//
// Pure + zero-dependency. Caller supplies items already scored (higher = better).
// Consumers: agent workspace-memory injection (agent.ipc P6 read-back) and any
// future recall surface.

export interface PackItem {
  /** The item text (a recalled memory line, fact, or summary). */
  text: string
  /** Relevance score, higher = more relevant. Drives ordering + keep decisions. */
  score?: number
}

export interface PackOptions {
  /** Desired number of items in the packed output. Default 6. */
  targetItems?: number
  /** Hard cap on total characters across all packed items. Default 1800. */
  maxTotalChars?: number
  /** An item is never trimmed below this many characters. Default 80. */
  minItemChars?: number
  /** An item is never kept longer than this many characters. Default 360. */
  maxItemChars?: number
}

export interface PackResult {
  /** Packed item texts in final (anti-lost-in-the-middle) order. */
  items: string[]
  /** Total characters across the packed items. */
  totalChars: number
}

const DEFAULTS = { targetItems: 6, maxTotalChars: 1800, minItemChars: 80, maxItemChars: 360 }

/** Trim to at most `n` chars, preferring a word boundary, adding an ellipsis. */
function clip(text: string, n: number): string {
  const t = text.trim()
  if (n <= 0) return ''
  if (t.length <= n) return t
  if (n <= 1) return t.slice(0, n)
  const cut = t.slice(0, n - 1)
  const sp = cut.lastIndexOf(' ')
  const body = sp > n * 0.6 ? cut.slice(0, sp) : cut
  return body.trimEnd() + '…'
}

export function packContext(items: PackItem[], options: PackOptions = {}): PackResult {
  const { targetItems, maxTotalChars, minItemChars, maxItemChars } = { ...DEFAULTS, ...options }

  // Highest score first; stable for equal scores (preserve input order).
  const ranked = items
    .filter(it => it.text && it.text.trim().length > 0)
    .map((it, i) => ({ it, i }))
    .sort((a, b) => ((b.it.score ?? 0) - (a.it.score ?? 0)) || (a.i - b.i))
    .map(x => x.it)

  if (ranked.length === 0) return { items: [], totalChars: 0 }

  // Each chosen entry carries its OWN source text, so phase 3 re-expands from the
  // correct original even when phase 1/2 skipped lower-priority items (chosen is
  // NOT index-aligned with `ranked`).
  const chosen: Array<{ text: string; src: string }> = []
  const used = () => chosen.reduce((a, c) => a + c.text.length, 0)

  // Phase 1 — greedy add at the per-item cap.
  for (const it of ranked) {
    if (chosen.length >= targetItems) break
    const piece = clip(it.text, maxItemChars)
    if (used() + piece.length <= maxTotalChars) {
      chosen.push({ text: piece, src: it.text })
      continue
    }
    // Phase 2 — compress what we have to the floor, then try to fit this one.
    if (chosen.length > 0) {
      for (const c of chosen) {
        if (c.text.length > minItemChars) c.text = clip(c.text, minItemChars)
      }
      const room = maxTotalChars - used()
      if (room >= minItemChars) {
        const smaller = clip(it.text, Math.min(room, maxItemChars))
        if (smaller.length >= minItemChars) chosen.push({ text: smaller, src: it.text })
      }
    }
  }

  // Phase 3 — redistribute leftover budget by re-expanding kept items, each from
  // its OWN source, in rank order.
  for (const c of chosen) {
    const leftover = maxTotalChars - used()
    if (leftover <= 0) break
    const src = c.src.trim()
    if (src.length <= c.text.length) continue
    c.text = clip(src, Math.min(c.text.length + leftover, maxItemChars))
  }

  // Phase 4 — anti "lost-in-the-middle": strongest items at both ends.
  // Even ranks (0,2,4…) form the head; odd ranks (1,3,5…) form the reversed tail.
  const head: string[] = []
  const tail: string[] = []
  chosen.forEach((c, idx) => (idx % 2 === 0 ? head : tail).push(c.text))
  const ordered = [...head, ...tail.reverse()]

  return { items: ordered, totalChars: ordered.reduce((a, s) => a + s.length, 0) }
}
