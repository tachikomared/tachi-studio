// apps/desktop/electron/services/swarm-plan.ts
//
// Pure bridge logic for the Swarm executor (audit H1a), kept import-light (only
// crypto + a type-only GnapTask import) so it is unit-testable without electron,
// git, a worktree, or a harness. swarm-executor.ts consumes this.

import { randomUUID } from 'crypto'
import type { GnapTask } from './gnap-client'

export interface SwarmRunPlan {
  /** The branch-name seed handed to parallelAgents.createTask (it slugifies). */
  taskName: string
  /** The prompt the harness runs, built from the task's title + description. */
  prompt: string
  /** A fresh gnap run id. */
  runId: string
}

/**
 * Derive the run plan (task name, harness prompt, run id) from a gnap task.
 * Side-effect-free; `idgen` is injectable for deterministic tests.
 */
export function buildSwarmRunPlan(
  task: Pick<GnapTask, 'id' | 'title' | 'desc'>,
  idgen: () => string = randomUUID,
): SwarmRunPlan {
  const title = (task.title ?? '').trim() || `Task ${task.id}`
  const desc  = (task.desc ?? '').trim()
  const prompt = desc
    ? `${title}\n\n${desc}\n\nComplete this task. Commit your work in this worktree when done.`
    : `${title}\n\nComplete this task. Commit your work in this worktree when done.`
  return { taskName: title, prompt, runId: `run-${idgen()}` }
}
