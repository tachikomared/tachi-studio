// apps/desktop/src/pages/swarm/runHistory.ts
//
// Pure helpers for the SwarmHistory view (STEAL 2026-06-21 #15, CodexMonitor):
// turn the live `runs` slice into a past-run history list. No React, no IPC, so
// the ordering/formatting logic is unit-testable on its own. (Named distinctly
// from the SwarmHistory.tsx component to avoid a case-only filename clash.)

import type { GnapRun } from '../../types/electron'

const TERMINAL: ReadonlySet<GnapRun['state']> = new Set(['completed', 'failed', 'cancelled'])

function runTime(r: GnapRun): number {
  const d = Date.parse(r.finished_at || r.started_at || '')
  return Number.isNaN(d) ? 0 : d
}

/** Completed/failed/cancelled runs only, newest-first (by finish, else start). */
export function sortRunsForHistory(runs: GnapRun[]): GnapRun[] {
  return runs.filter((r) => TERMINAL.has(r.state)).slice().sort((a, b) => runTime(b) - runTime(a))
}

/** Wall-clock duration of a finished run as "42s" / "2m 5s", or null if unfinished. */
export function formatRunDuration(r: GnapRun): string | null {
  if (!r.finished_at) return null
  const ms = Date.parse(r.finished_at) - Date.parse(r.started_at)
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
