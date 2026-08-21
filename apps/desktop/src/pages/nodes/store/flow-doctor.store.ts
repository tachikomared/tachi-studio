// apps/desktop/src/pages/nodes/store/flow-doctor.store.ts
//
// NODES-RESEARCH #4 — orchestrates the self-healing template check. It ties the
// PURE analyzer (flow-doctor.ts) and the IMPURE gatherer (flow-doctor-env.ts) to
// the live canvas, and holds the per-flow session-scoped dismissal so the REPAIR
// banner never nags: once the user clicks "OPEN ANYWAY" for a flow, that flow
// stays quiet for the rest of the session even as the doctor re-runs on focus.
//
// `run()` is the single entry point — the load seams (template open / flow
// switch / import) and the banner's focus/visibility re-check all call it. It is
// async and strictly fail-open (a gather/analyze throw yields zero issues), and
// it guards against a stale async result overwriting a flow the user has since
// switched away from.

import { create } from 'zustand'
import { useNodesStore } from './nodes.store'
import { analyzeFlow, type FlowIssue } from '../flow-doctor'
import { gatherFlowEnv } from '../flow-doctor-env'

interface FlowDoctorState {
  /** Flow name the current `issues` were computed for (stale-async guard). */
  flowName: string | null
  /** Semantic issues found in the current flow (empty = healthy / unchecked). */
  issues: FlowIssue[]
  /** Flow names the user dismissed via "OPEN ANYWAY" (session-scoped). */
  dismissed: Record<string, true>
  /** Re-run the doctor against the CURRENT canvas. Fail-open; stale-guarded. */
  run: () => Promise<void>
  /** Dismiss the banner for the current flow (persists for the session). */
  dismissCurrent: () => void
}

export const useFlowDoctorStore = create<FlowDoctorState>((set) => ({
  flowName: null,
  issues: [],
  dismissed: {},

  async run() {
    const before = useNodesStore.getState()
    const flowName = before.flowName
    const env = await gatherFlowEnv(before.nodes).catch(() => ({}))
    // If the canvas switched to a different flow while we were gathering, drop
    // this result — the banner for the new flow will be produced by its own run.
    const now = useNodesStore.getState()
    if (now.flowName !== flowName) return
    let issues: FlowIssue[]
    try {
      issues = analyzeFlow(now.nodes, now.edges, env)
    } catch {
      issues = [] // analyzer is pure + defensive, but never let it block a load
    }
    set({ flowName, issues })
  },

  dismissCurrent() {
    const fn = useNodesStore.getState().flowName
    set((s) => ({ dismissed: { ...s.dismissed, [fn]: true } }))
  },
}))

/** Fire-and-forget doctor re-check — call at every load seam. */
export function runFlowDoctor(): void {
  void useFlowDoctorStore.getState().run()
}
