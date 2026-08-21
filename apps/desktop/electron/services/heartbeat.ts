// apps/desktop/electron/services/heartbeat.ts
//
// Sidecar heartbeat transition tracker (STEAL 2026-06-21 #5, checkcle
// notification_monitor). The sidecar health-poll already drives a per-slot
// circuit breaker; this adds the missing piece — a NATIVE NOTIFICATION when a
// sidecar's status actually CHANGES (up→down = likely crash, down→up = recovery)
// rather than on every probe. Pure + dependency-free; the wiring lives in
// sidecar-manager.healthCheckSidecar.

export type HeartbeatStatus = 'up' | 'down'

export interface HeartbeatResult {
  status: HeartbeatStatus
  /** true only when status differs from the previous observation (not the baseline). */
  transitioned: boolean
  /** Consecutive failed probes (0 when up) — useful for backoff/escalation. */
  consecutiveFailures: number
}

interface SlotState {
  status: HeartbeatStatus
  fails: number
  seen: boolean
}

export class HeartbeatTracker {
  private state = new Map<string, SlotState>()

  /** Record a probe result; returns whether it crossed an up/down boundary. */
  record(id: string, healthy: boolean): HeartbeatResult {
    const prev = this.state.get(id)
    const status: HeartbeatStatus = healthy ? 'up' : 'down'
    const fails = healthy ? 0 : (prev?.fails ?? 0) + 1
    // The first observation establishes a baseline silently — a never-started
    // sidecar shouldn't fire a "down" notification on the very first poll.
    const transitioned = prev?.seen === true && prev.status !== status
    this.state.set(id, { status, fails, seen: true })
    return { status, transitioned, consecutiveFailures: fails }
  }

  /** Current known status, or null if never observed. */
  statusOf(id: string): HeartbeatStatus | null {
    return this.state.get(id)?.status ?? null
  }
}
