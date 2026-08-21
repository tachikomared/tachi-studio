// apps/desktop/electron/services/swarm-executor.ts
//
// Audit H1 (option a): the bridge that makes the Swarm tab actually RUN agents
// instead of only coordinating. gnap (the git-files coordination layer) and the
// parallel-agent/worktree subsystem previously didn't know about each other —
// gnap's claimTask/startRun/completeRun had zero callers. This module connects
// them:
//
//   claimTask  → parallelAgents.createTask (git worktree on a task branch)
//              → startRun  → run the harness IN the worktree
//              → completeRun (result + commits)  → updateTaskState 'done'
//
// Run-state writes land in .gnap/runs/*.json, which the SwarmPage `watch()`
// already mirrors onto the board — so tiles reflect running/completed without a
// separate Runs view.
//
// Scope: the TACHI first-party harness is dispatched in-process (no sidecar
// lifecycle). openclaude/darksol via the swarm executor are a follow-up.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '@tachi/core'
import { createGnapClient } from './gnap-client'
import { parallelAgents } from './parallel-agent-manager'
import { runTachiSession } from './tachi/loop'
import { checkAgentToolEgress } from './egress-policy'
import { classifyUnattendedTool } from './unattended-gate'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
import { buildSwarmRunPlan } from './swarm-plan'

const execFileAsync = promisify(execFile)

export type SwarmHarness = 'tachi'

export interface SwarmRunResult {
  ok: boolean
  runId?: string
  reason?: string
  commits?: string[]
}

/** List commit shas the agent made on the worktree branch (since `baseSha`). */
async function commitsSince(worktreePath: string, baseSha: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'log', `${baseSha}..HEAD`, '--format=%H'], { maxBuffer: 1024 * 1024 })
    return stdout.split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return [] }
}
async function headSha(worktreePath: string): Promise<string> {
  try { const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']); return stdout.trim() }
  catch { return '' }
}

/**
 * Claim a gnap task and run it end-to-end. The board reflects state via gnap
 * run files (picked up by the existing watch()). Returns a coarse result; live
 * agent output is streamed on `swarm:run-event` for the feed.
 */
export async function runSwarmTask(opts: {
  repoPath: string
  taskId:   string
  agentId:  string
  harness?: SwarmHarness
  win:      BrowserWindow | null
}): Promise<SwarmRunResult> {
  const { repoPath, taskId, agentId, win } = opts
  const harness = opts.harness ?? 'tachi'
  if (harness !== 'tachi') {
    return { ok: false, reason: `The swarm executor currently supports the "tachi" harness only (got "${harness}").` }
  }
  const gnap = createGnapClient()

  const tasks = await gnap.listTasks(repoPath)
  const task = tasks.find(t => t.id === taskId)
  if (!task) return { ok: false, reason: `Task ${taskId} not found in ${repoPath}.` }

  // 1. Claim (advisory git-files lock; aborts if a peer already holds it).
  const claim = await gnap.claimTask(repoPath, taskId, agentId)
  if (!claim.ok) return { ok: false, reason: claim.reason ?? 'Task is already claimed by another agent.' }

  const plan = buildSwarmRunPlan(task)
  const pushEvent = (e: AgentEvent): void => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('swarm:run-event', { taskId, runId: plan.runId, event: e })
    }
  }

  // 2. Provision an isolated git worktree on a task branch.
  let worktreePath: string
  try {
    const created = await parallelAgents.createTask({ name: plan.taskName, projectRoot: repoPath, branchPrefix: 'swarm' })
    worktreePath = created.task.workingDir
  } catch (err) {
    const reason = `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`
    await gnap.updateTaskState(repoPath, taskId, 'ready', agentId).catch(() => {})
    return { ok: false, reason }
  }

  const baseSha = await headSha(worktreePath)
  const startedAt = new Date().toISOString()
  await gnap.startRun(repoPath, { id: plan.runId, task: taskId, agent: agentId, state: 'running', started_at: startedAt, attempt: 1 })

  // 3. Run the harness in the worktree. PRIVATE MODE egress is gated like
  //    agent:send, AND — since this runs UNATTENDED (no human prompt) — the
  //    unattended gate hard-denies destructive shell + protected-path writes
  //    (audit 2026-06-12 dim 4+6: this path previously gated egress only).
  const ctrl = new AbortController()
  const gate = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    const egress = checkAgentToolEgress(name, input)
    if (!egress.allowed) { pushEvent({ type: 'error', message: `[PRIVATE MODE] ${name} blocked: ${egress.reason ?? 'denied'}` }); return false }
    const u = classifyUnattendedTool(name, input, { workingDir: worktreePath })
    if (!u.allowed) { pushEvent({ type: 'error', message: `[swarm] ${name} blocked: ${u.reason ?? 'denied'}` }); return false }
    return true
  }
  let lastText = ''
  try {
    await runTachiSession({
      workspaceRoot: worktreePath,
      task: plan.prompt,
      signal: ctrl.signal,
      onEvent: (e) => { if (e.type === 'text') lastText = e.text ?? lastText; pushEvent(e) },
      gate,
      privateMode: getCurrentPrivacyMode() === 'private',
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await gnap.completeRun(repoPath, plan.runId, { state: 'failed', finished_at: new Date().toISOString(), error }).catch(() => {})
    return { ok: false, runId: plan.runId, reason: error }
  }

  // 4. Record the run's commits + mark the task done.
  const commits = await commitsSince(worktreePath, baseSha)
  await gnap.completeRun(repoPath, plan.runId, {
    state: 'completed',
    finished_at: new Date().toISOString(),
    result: lastText.slice(0, 4000),
    commits,
  })
  await gnap.updateTaskState(repoPath, taskId, 'review', agentId).catch(() => {})
  return { ok: true, runId: plan.runId, commits }
}
