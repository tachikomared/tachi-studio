// apps/desktop/electron/services/tachi/fanout.ts
//
// MULTI-AGENT FAN-OUT for the TACHI harness — the `spawn_agents` tool's engine.
//
// The harness already had DEPTH-1 delegation (`delegate`): one focused,
// read-only child loop at a time, its trajectory isolated, only its accepted
// summary handed back. Fan-out is that same primitive run WIDE: N bounded child
// sessions in parallel, each with its own context and step budget, results
// returned as an array the parent can reason over.
//
// What this module owns (and why it is a separate, PURE file):
//   - task normalisation of untrusted model input (count cap, prompt cap,
//     workingDir sandbox, tool-mode narrowing);
//   - the CONCURRENCY POOL — min(3, tasks) workers, never more;
//   - the ABORT TREE — one controller linked to the parent signal, so aborting
//     the parent run aborts every in-flight child;
//   - the SPEND-CAP CHECK before EACH child (a fan-out is the one place where a
//     single tool call can multiply spend, so it is checked per child, not once);
//   - the CHILD GATE — read-only children get the fixed read-only allowlist;
//     `full` children run under the PARENT's gate, i.e. the parent's approval
//     scope plus the standard per-tool prompts for anything dangerous. Either
//     way a child can never spawn or delegate (breadth + depth are both capped);
//   - the CHILD EVENT FORWARDER — the same "surface reconnects, keep the
//     trajectory private" rule `delegate` established, extended so tool activity
//     also surfaces, prefixed with the child index (`[2] read`).
//
// runChild is INJECTED so this file stays free of the loop/electron graph and
// is unit-testable with a mocked child runner.

import type { AgentEvent } from '@tachi/core'

/** How a child's tools are gated. */
export type FanoutToolMode = 'readOnly' | 'full'

export interface FanoutTaskSpec {
  prompt: string
  /** Optional child workspace (must resolve INSIDE the parent workspace). */
  workingDir?: string
  tools: FanoutToolMode
}

export type FanoutStatus = 'ok' | 'error' | 'aborted' | 'refused'

export interface FanoutChildResult {
  /** The child's brief (truncated) — so the parent can match result to task. */
  task: string
  status: FanoutStatus
  /** The child's accepted complete() summary, its final text, or the failure. */
  summary: string
  /** Workspace-relative paths the child wrote/edited (`full` children only). */
  filesTouched?: string[]
}

export interface FanoutChildRun {
  /** 1-based child index (matches the `[n]` event prefix the user sees). */
  index: number
  spec: FanoutTaskSpec
  /** Resolved absolute workspace for this child. */
  workspaceRoot: string
  /** Child signal — aborted when the parent run aborts. */
  signal: AbortSignal
  /** Pre-wired forwarder: surfaces the child's trail to the parent run view. */
  onEvent: (e: AgentEvent) => void
  /** Pre-wired gate for this child's tool mode. */
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean | string>
}

export interface FanoutDeps {
  /** The parent run's workspace — the sandbox root for child workingDirs. */
  workspaceRoot: string
  /** Parent abort signal; aborting it aborts every child. */
  signal: AbortSignal
  /** Parent event sink (the run view). */
  onEvent: (e: AgentEvent) => void
  /** The parent's permission gate — reused verbatim by `full` children. */
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean | string>
  /** Run ONE child session. Must resolve (never reject) for a clean result. */
  runChild: (run: FanoutChildRun) => Promise<void>
  /**
   * Spend-cap probe, consulted BEFORE each child starts. Returning
   * `{allowed:false}` refuses that child (and, in practice, every later one)
   * instead of multiplying spend past the user's 30-day budget.
   */
  checkSpend?: () => Promise<{ allowed: boolean; reason?: string }>
  /** Requested worker count; clamped to [1, FANOUT_MAX_CONCURRENT]. */
  maxConcurrent?: number
  /** Path resolver for a child workingDir; return null to reject it. */
  resolveWorkingDir?: (raw: string) => string | null
}

/** Breadth backstop — one fan-out may not exceed this many children. */
export const FANOUT_MAX_TASKS = 8
/** Never more than this many children run at once (spend + machine load). */
export const FANOUT_MAX_CONCURRENT = 3
/** Per-child step ceiling — children are bounded by construction. */
export const FANOUT_CHILD_MAX_STEPS = 30
/** Longest prompt one child brief may carry. */
const PROMPT_MAX = 4000

/**
 * Tools a READ-ONLY fan-out child may use. Deliberately a superset of
 * `delegate`'s allowlist (a research child benefits from the code-graph
 * lookups) but still strictly non-mutating, non-networked and non-recursive.
 */
export const FANOUT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'glob',
  'blast_radius', 'trace_path', 'get_architecture',
  'find_definition', 'find_references', 'find_callers',
  'expand_compacted', 'complete', 'todo_write',
])

/**
 * Tools NO child may ever call, whatever its mode. Depth is already capped by
 * the caller (children run at recursionDepth 1, where the spawn/delegate tools
 * are not even registered); this is the second, independent lock.
 */
export const CHILD_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(['spawn_agents', 'delegate'])

// ── Input normalisation ───────────────────────────────────────────────────────

export interface NormalizedFanout {
  tasks: FanoutTaskSpec[]
  maxConcurrent: number
}

/**
 * Narrow untrusted model input into a bounded task list. Returns an error
 * STRING (handed straight to the model) when the call is unusable.
 */
export function normalizeFanoutInput(raw: unknown): { ok: true; value: NormalizedFanout } | { ok: false; error: string } {
  const obj = (raw ?? {}) as { tasks?: unknown; maxConcurrent?: unknown }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return { ok: false, error: 'spawn_agents needs a non-empty "tasks" array, e.g. {"tasks":[{"prompt":"…"}]}.' }
  }
  if (obj.tasks.length > FANOUT_MAX_TASKS) {
    return { ok: false, error: `spawn_agents accepts at most ${FANOUT_MAX_TASKS} tasks per call (got ${obj.tasks.length}) — split the work or do some of it yourself.` }
  }
  const tasks: FanoutTaskSpec[] = []
  for (const [i, entry] of obj.tasks.entries()) {
    const e = (entry ?? {}) as { prompt?: unknown; workingDir?: unknown; tools?: unknown }
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
    if (!prompt) return { ok: false, error: `Task ${i + 1} has no "prompt". Every sub-agent needs a complete, self-contained brief.` }
    tasks.push({
      prompt: prompt.slice(0, PROMPT_MAX),
      ...(typeof e.workingDir === 'string' && e.workingDir.trim() ? { workingDir: e.workingDir.trim() } : {}),
      // Anything other than an explicit "full" is read-only: the safe default
      // is the one an under-specified model call lands on.
      tools: e.tools === 'full' ? 'full' : 'readOnly',
    })
  }
  const requested = typeof obj.maxConcurrent === 'number' && Number.isFinite(obj.maxConcurrent)
    ? Math.trunc(obj.maxConcurrent)
    : FANOUT_MAX_CONCURRENT
  const maxConcurrent = Math.max(1, Math.min(FANOUT_MAX_CONCURRENT, requested, tasks.length))
  return { ok: true, value: { tasks, maxConcurrent } }
}

// ── Child plumbing ────────────────────────────────────────────────────────────

/**
 * The gate one child runs behind.
 *
 * readOnly → a fixed allowlist, no prompts, no side effects.
 * full     → the PARENT's gate: the fan-out was approved once at the parent
 *            level, and anything dangerous inside a child still hits the normal
 *            per-tool permission flow (protected paths, destructive shell, …).
 * Either mode hard-denies re-entrant spawning.
 */
export function buildChildGate(
  spec: FanoutTaskSpec,
  parentGate: (name: string, args: Record<string, unknown>) => Promise<boolean | string>,
): (name: string, args: Record<string, unknown>) => Promise<boolean | string> {
  return async (name, args) => {
    if (CHILD_FORBIDDEN_TOOLS.has(name)) {
      return 'A sub-agent cannot spawn more sub-agents — finish this task yourself and report back.'
    }
    if (spec.tools === 'readOnly') {
      return FANOUT_READONLY_TOOLS.has(name)
        ? true
        : `This sub-agent is READ-ONLY — "${name}" is not available. Report what you found instead.`
    }
    return parentGate(name, args)
  }
}

/** Capture of one child's outcome, filled by the forwarder as events arrive. */
interface ChildCapture {
  text: string
  summary: string
  pendingSummary: string
  files: Set<string>
  errored: string
}

function newCapture(): ChildCapture {
  return { text: '', summary: '', pendingSummary: '', files: new Set(), errored: '' }
}

/**
 * Forward a child's events into the parent run view.
 *
 * Extends the rule `delegate` established (its trajectory is private; a
 * reconnect IS surfaced, because "why has this been quiet for 30s" is the
 * parent UI's job to answer) with the tool trail, prefixed by the child index
 * so a fan-out reads as N nested lanes rather than one interleaved mess. The
 * child's TEXT stays private — only its final result is reported, which is the
 * whole point of running it in its own context.
 */
export function makeChildEventForwarder(
  index: number,
  onEvent: (e: AgentEvent) => void,
  capture: ChildCapture,
): (e: AgentEvent) => void {
  const tag = `[${index}] `
  return (e: AgentEvent) => {
    if (e.type === 'reconnect' || e.type === 'reconnect-resolved') { onEvent(e); return }
    if (e.type === 'text') { capture.text += e.text; return }
    if (e.type === 'error') { if (!capture.errored) capture.errored = e.message; return }
    if (e.type === 'tool-call') {
      if (e.name === 'complete') {
        try { capture.pendingSummary = String((JSON.parse(e.input) as { summary?: unknown }).summary ?? '') } catch { /* text fallback */ }
      } else if (e.name === 'write' || e.name === 'edit') {
        try {
          const p = (JSON.parse(e.input) as { path?: unknown }).path
          if (typeof p === 'string' && p.trim()) capture.files.add(p.trim())
        } catch { /* unparseable input — no path to record */ }
      }
      onEvent({ type: 'tool-call', name: `${tag}${e.name}`, input: e.input })
      return
    }
    if (e.type === 'tool-done') {
      // Adopt the summary only once complete() was ACCEPTED, so a rejected or
      // placeholder summary never leaks up as the child's result.
      if (e.name === 'complete' && /marked complete/i.test(e.output ?? '')) capture.summary = capture.pendingSummary
      onEvent({ type: 'tool-done', name: `${tag}${e.name}`, output: e.output, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}) })
      return
    }
    // 'done' / 'user-text' / 'fusion-panel' stay inside the child: a child's
    // terminal event must never look like the PARENT run finishing.
  }
}

// ── The fan-out ───────────────────────────────────────────────────────────────

/**
 * Run every task as a bounded child session, at most `maxConcurrent` at a time,
 * and return one result per task IN INPUT ORDER. Never throws: a child that
 * fails becomes an `error` result, an aborted run becomes `aborted` results,
 * and a child refused by the spend cap becomes `refused`.
 */
export async function runFanout(input: NormalizedFanout, deps: FanoutDeps): Promise<FanoutChildResult[]> {
  const { tasks, maxConcurrent } = input
  const results: FanoutChildResult[] = tasks.map(t => ({ task: t.prompt.slice(0, 200), status: 'error', summary: '(not started)' }))

  // ABORT TREE: one controller for the whole fan-out, chained to the parent
  // signal. Every child gets `tree.signal`, so a parent abort tears the whole
  // subtree down; the fan-out can also abort itself without touching the parent.
  const tree = new AbortController()
  const onParentAbort = (): void => tree.abort()
  if (deps.signal.aborted) tree.abort()
  else deps.signal.addEventListener('abort', onParentAbort, { once: true })

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= tasks.length) return
      const spec = tasks[i]
      const index = i + 1

      if (tree.signal.aborted) {
        results[i] = { task: spec.prompt.slice(0, 200), status: 'aborted', summary: 'The run was aborted before this sub-agent started.' }
        continue
      }

      // SPEND CAP — before EACH child, not once for the fan-out.
      if (deps.checkSpend) {
        let verdict: { allowed: boolean; reason?: string }
        try { verdict = await deps.checkSpend() } catch { verdict = { allowed: true } }
        if (!verdict.allowed) {
          results[i] = { task: spec.prompt.slice(0, 200), status: 'refused', summary: verdict.reason ?? 'Refused: the LLM spend cap was reached.' }
          continue
        }
      }

      // Child workspace: default to the parent's; an explicit one must resolve
      // inside it (the resolver is the sandbox — it returns null on escape).
      let workspaceRoot = deps.workspaceRoot
      if (spec.workingDir) {
        const resolved = deps.resolveWorkingDir ? deps.resolveWorkingDir(spec.workingDir) : null
        if (!resolved) {
          results[i] = { task: spec.prompt.slice(0, 200), status: 'refused', summary: `Refused: workingDir "${spec.workingDir}" is outside this workspace.` }
          continue
        }
        workspaceRoot = resolved
      }

      const capture = newCapture()
      try {
        await deps.runChild({
          index,
          spec,
          workspaceRoot,
          signal: tree.signal,
          onEvent: makeChildEventForwarder(index, deps.onEvent, capture),
          gate: buildChildGate(spec, deps.gate),
        })
      } catch (e) {
        capture.errored = capture.errored || (e as Error)?.message || String(e)
      }

      const files = [...capture.files]
      const answer = (capture.summary || capture.text).trim()
      if (tree.signal.aborted) {
        results[i] = { task: spec.prompt.slice(0, 200), status: 'aborted', summary: answer || 'Aborted before this sub-agent reported.', ...(files.length ? { filesTouched: files } : {}) }
      } else if (!answer && capture.errored) {
        results[i] = { task: spec.prompt.slice(0, 200), status: 'error', summary: capture.errored, ...(files.length ? { filesTouched: files } : {}) }
      } else {
        results[i] = {
          task: spec.prompt.slice(0, 200),
          status: answer ? 'ok' : 'error',
          summary: answer || '(the sub-agent returned no result)',
          ...(files.length ? { filesTouched: files } : {}),
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(maxConcurrent, tasks.length)) }, () => worker()))
  } finally {
    deps.signal.removeEventListener('abort', onParentAbort)
  }
  return results
}

/** Render fan-out results as the tool's string output for the model. */
export function formatFanoutResults(results: readonly FanoutChildResult[]): string {
  const head = `${results.length} sub-agent(s) finished: ${results.filter(r => r.status === 'ok').length} ok, ${results.filter(r => r.status !== 'ok').length} not ok.`
  const body = results.map((r, i) => {
    const files = r.filesTouched?.length ? `\nfiles: ${r.filesTouched.join(', ')}` : ''
    return `── agent ${i + 1} [${r.status.toUpperCase()}] ──\ntask: ${r.task}${files}\n${r.summary}`
  }).join('\n\n')
  return `${head}\n\n${body}`
}
