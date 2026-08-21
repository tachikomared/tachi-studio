// apps/desktop/src/utils/runStats.ts
//
// Pure rollup of run-log entries for the Observability "Recent runs" header
// (STEAL 2026-06-21 #11, CodexMonitor usage snapshot). No IPC/state — fed the
// entries window.tachi.cost.recentRuns() returns.

export interface RunLogLite {
  ts: number
  outcome: 'done' | 'error' | 'abort'
  durationMs: number
}

export interface RunWindowStats {
  runs: number
  ok: number
  errored: number
  aborted: number
  /** Percentage of runs that ended 'done', rounded; 0 when no runs. */
  okPct: number
  /** Mean durationMs across the window; 0 when no runs. */
  avgDurationMs: number
}

const DAY_MS = 86_400_000

export function runStats(entries: RunLogLite[], nowMs: number, windowDays: number): RunWindowStats {
  const since = nowMs - windowDays * DAY_MS
  const win = entries.filter(e => e.ts >= since)
  const runs = win.length
  if (runs === 0) return { runs: 0, ok: 0, errored: 0, aborted: 0, okPct: 0, avgDurationMs: 0 }
  let ok = 0, errored = 0, aborted = 0, totalMs = 0
  for (const e of win) {
    if (e.outcome === 'done') ok++
    else if (e.outcome === 'error') errored++
    else aborted++
    totalMs += e.durationMs
  }
  return {
    runs, ok, errored, aborted,
    okPct: Math.round((ok / runs) * 100),
    avgDurationMs: Math.round(totalMs / runs),
  }
}
