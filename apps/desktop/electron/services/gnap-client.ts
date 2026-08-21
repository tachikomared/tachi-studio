// apps/desktop/electron/services/gnap-client.ts
//
// gnap (https://github.com/farol-team/gnap) is a pure specification: a set of
// JSON file shapes plus a `.gnap/` directory convention inside any git repo.
// Agents coordinate by committing to a shared bare repo. There's no daemon,
// no broker, no API — just files + git's optimistic concurrency.
//
// This service wraps git shell invocations to read/write that state, plus a
// chokidar-free watcher backed by fs.watch on the default-branch ref. It's a
// pure standalone service: no IPC, no UI, no Electron singletons. Callers
// supply a `repoPath` (working tree); pushes target whatever `origin` points
// at — typically a sibling bare repo set up by initSwarm().
//
// Conflict model: the protocol intentionally has no atomic claim primitive.
// Mutations are commit → push → on-reject (non-fast-forward) → pull --rebase
// → retry, up to 3 attempts. `claimTask()` additionally writes an advisory
// `claim: { agent, at, expires_at }` field so peers can detect contention
// before the push round-trip.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { watch as fsWatch, type FSWatcher } from 'fs'
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  access,
} from 'fs/promises'
import { dirname, join, posix as posixPath } from 'path'

const execFileAsync = promisify(execFile)

// ─── Types ────────────────────────────────────────────────────────────────────

export type GnapAgent = {
  id: string
  name: string
  role: string
  type: 'ai' | 'human'
  runtime?: string
  reports_to?: string
  capabilities?: string[]
  heartbeat_sec?: number
  status: 'active' | 'paused' | 'stopped'
}

export type GnapTaskState =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked'
  | 'cancelled'

export type GnapTask = {
  id: string
  title: string
  assigned_to: string[]
  state: GnapTaskState
  created_by: string
  created_at: string
  parent?: string
  desc?: string
  priority?: number
  due?: string
  blocked?: string
  reviewer?: string
  claim?: { agent: string; at: string; expires_at: string }
  comments?: Array<{ author: string; at: string; text: string }>
}

export type GnapRun = {
  id: string
  task: string
  agent: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string
  attempt: number
  finished_at?: string
  tokens?: number
  cost_usd?: number
  result?: unknown
  error?: string
  commits: string[]
  artifacts: string[]
}

export type GnapMessage = {
  id: string
  from: string
  to: string[]
  at: string
  text: string
  type?: string
  channel?: string
  thread?: string
  read_by?: string[]
}

export interface GnapClient {
  initSwarm(repoPath: string, opts?: { protocolVersion?: string }): Promise<void>

  listAgents(repoPath: string): Promise<GnapAgent[]>
  registerAgent(repoPath: string, agent: GnapAgent): Promise<void>
  updateAgentStatus(
    repoPath: string,
    agentId: string,
    status: GnapAgent['status'],
  ): Promise<void>

  listTasks(
    repoPath: string,
    filter?: { state?: GnapTaskState; assignedTo?: string },
  ): Promise<GnapTask[]>
  createTask(repoPath: string, task: GnapTask): Promise<void>
  updateTaskState(
    repoPath: string,
    taskId: string,
    state: GnapTaskState,
    by: string,
  ): Promise<void>
  claimTask(
    repoPath: string,
    taskId: string,
    agentId: string,
    ttlSec?: number,
  ): Promise<{ ok: boolean; reason?: string }>

  startRun(
    repoPath: string,
    run: Omit<GnapRun, 'commits' | 'artifacts'> & {
      commits?: string[]
      artifacts?: string[]
    },
  ): Promise<void>
  completeRun(
    repoPath: string,
    runId: string,
    patch: Partial<GnapRun>,
  ): Promise<void>
  listRuns(repoPath: string, taskId?: string): Promise<GnapRun[]>

  postMessage(repoPath: string, msg: GnapMessage): Promise<void>
  listMessages(
    repoPath: string,
    filter?: { to?: string; unreadBy?: string },
  ): Promise<GnapMessage[]>
  markRead(repoPath: string, msgId: string, agentId: string): Promise<void>

  watch(
    repoPath: string,
    onEvent: (info: {
      sha: string
      subject: string
      touchedFiles: string[]
    }) => void,
  ): () => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[gnap]'
const DEFAULT_PROTOCOL_VERSION = '1.0'
const DEFAULT_BARE_DIR_SUFFIX = '.gnap-origin.git'
const DEFAULT_CLAIM_TTL_SEC = 300
const PUSH_RETRY_LIMIT = 3

// In-git paths are always POSIX so .gitignore / git internals see a single
// canonical form across Windows and Unix.
const GNAP_DIR = '.gnap'
const PATH_VERSION = posixPath.join(GNAP_DIR, 'version')
const PATH_AGENTS = posixPath.join(GNAP_DIR, 'agents.json')
const DIR_TASKS = posixPath.join(GNAP_DIR, 'tasks')
const DIR_RUNS = posixPath.join(GNAP_DIR, 'runs')
const DIR_MESSAGES = posixPath.join(GNAP_DIR, 'messages')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function logErr(msg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`${LOG_PREFIX} ${msg}: ${detail}`)
}

function nowIso(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, '0')
  return `${prefix}-${ts}-${rand}`
}

function toFsPath(repoPath: string, ...rel: string[]): string {
  // Convert POSIX in-git paths into platform-native filesystem paths.
  // posix.join collapses everything into forward slashes; node's path.join
  // converts forward slashes to backslashes on Windows where needed.
  return join(repoPath, ...rel.flatMap((r) => r.split('/')))
}

// fs/promises has no existsSync analogue; access() rejects when the path is
// missing. Wrap it into a boolean probe so call sites read the same as before.
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  // 2-space indent + trailing newline keeps diffs readable in git log/show.
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

// Treat a shell exec failure as an object with stderr/stdout/code so callers
// can sniff push-reject signatures without `any`-casting.
interface GitExecError extends Error {
  stderr?: string
  stdout?: string
  code?: number | string | null
}

async function git(
  repoPath: string,
  args: string[],
  opts: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { allowFailure = false, timeoutMs = 30_000 } = opts
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // GIT_TERMINAL_PROMPT=0 prevents git from popping a credential prompt on
      // headless invocations. We're talking to a local bare repo via file://,
      // so no auth should be needed anyway, but this is belt-and-suspenders.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { stdout, stderr }
  } catch (err) {
    if (allowFailure) {
      const e = err as GitExecError
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
    throw err
  }
}

function isPushRejected(err: unknown): boolean {
  const e = err as GitExecError
  const blob = `${e?.stderr ?? ''}\n${e?.stdout ?? ''}\n${e?.message ?? ''}`
  // Cover all the strings git uses for non-fast-forward rejections in both
  // older and newer versions.
  return (
    /\[rejected\]/i.test(blob) ||
    /non-fast-forward/i.test(blob) ||
    /failed to push/i.test(blob) ||
    /Updates were rejected/i.test(blob)
  )
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ['symbolic-ref', '--short', 'HEAD'])
  return stdout.trim() || 'main'
}

async function hasRemote(repoPath: string, remote: string): Promise<boolean> {
  const { stdout } = await git(repoPath, ['remote'], { allowFailure: true })
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .includes(remote)
}

/**
 * Commit a set of paths and push to origin with pull/rebase/retry on reject.
 *
 * `mutate` is invoked between attempts so callers can re-read the (possibly
 * rebased) on-disk state and re-apply their change. It MUST be idempotent —
 * after a rebase we may be staring at a newer version of the same file written
 * by a peer, and the caller is expected to merge their intent into that.
 */
async function commitAndPush(opts: {
  repoPath: string
  relPaths: string[]
  message: string
  mutate: () => void | Promise<void>
  remote?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const remote = opts.remote ?? 'origin'
  const remoteExists = await hasRemote(opts.repoPath, remote)

  for (let attempt = 1; attempt <= PUSH_RETRY_LIMIT; attempt++) {
    // Re-run the caller's write each loop. On retry it may produce a different
    // result because we just rebased and the file content shifted under us.
    await opts.mutate()

    // Stage explicitly by path; avoid `git add -A` so we never sweep up
    // unrelated changes that happen to be in the working tree.
    await git(opts.repoPath, ['add', '--', ...opts.relPaths])

    // Skip the commit entirely if nothing is staged. This is the common case
    // when mutate() bailed (e.g. claimTask detecting a live peer claim) — we
    // don't want to burn an empty commit and trigger an unnecessary push.
    const staged = await git(
      opts.repoPath,
      ['diff', '--cached', '--name-only', '--', ...opts.relPaths],
      { allowFailure: true },
    )
    if (!staged.stdout.trim()) {
      // Nothing for us to push. Treat as success — peers can still observe
      // our intent from the unchanged file.
      return { ok: true }
    }

    const commit = await git(
      opts.repoPath,
      ['commit', '-m', opts.message],
      { allowFailure: true },
    )
    if (commit.stderr && /error:|fatal:/i.test(commit.stderr)) {
      return { ok: false, reason: `git commit failed: ${commit.stderr.trim()}` }
    }

    if (!remoteExists) {
      // No origin configured — pure-local mode (single-process tests, etc.).
      return { ok: true }
    }

    try {
      const branch = await getCurrentBranch(opts.repoPath)
      await git(opts.repoPath, ['push', remote, `HEAD:${branch}`])
      return { ok: true }
    } catch (err) {
      if (!isPushRejected(err)) {
        return {
          ok: false,
          reason: `git push failed: ${(err as Error).message}`,
        }
      }
      // Non-fast-forward. Try to pull --rebase and loop.
      if (attempt >= PUSH_RETRY_LIMIT) {
        return {
          ok: false,
          reason: `push rejected after ${PUSH_RETRY_LIMIT} attempts (non-fast-forward)`,
        }
      }
      const branch = await getCurrentBranch(opts.repoPath)
      const rebase = await git(
        opts.repoPath,
        ['pull', '--rebase', remote, branch],
        { allowFailure: true },
      )
      if (/CONFLICT|conflict/.test(rebase.stdout + rebase.stderr)) {
        // A real semantic conflict — abort the rebase to leave the working
        // tree in a sane state, then bail. We don't try to resolve here;
        // re-running mutate() after abort would still hit the same conflict.
        await git(opts.repoPath, ['rebase', '--abort'], { allowFailure: true })
        return {
          ok: false,
          reason: 'rebase conflict during push retry',
        }
      }
      // Loop and let mutate() re-apply our change on top of the new HEAD.
    }
  }

  return { ok: false, reason: 'exhausted push retries' }
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

interface AgentsFile {
  agents: GnapAgent[]
}

async function readAgentsFile(repoPath: string): Promise<AgentsFile> {
  return readJson<AgentsFile>(toFsPath(repoPath, PATH_AGENTS), { agents: [] })
}

async function readTaskFile(
  repoPath: string,
  taskId: string,
): Promise<GnapTask | null> {
  const fp = toFsPath(repoPath, DIR_TASKS, `${taskId}.json`)
  if (!(await pathExists(fp))) return null
  try {
    return JSON.parse(await readFile(fp, 'utf8')) as GnapTask
  } catch (err) {
    logErr(`task file ${taskId} unreadable`, err)
    return null
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return []
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

// ─── initSwarm ────────────────────────────────────────────────────────────────

async function initSwarm(
  repoPath: string,
  opts?: { protocolVersion?: string },
): Promise<void> {
  await mkdir(repoPath, { recursive: true })

  // Detect whether this dir is already a git repo. `git rev-parse` exits non-
  // zero when not in a repo, so allowFailure + check on stdout.
  const detect = await git(repoPath, ['rev-parse', '--is-inside-work-tree'], {
    allowFailure: true,
  })
  const isRepo = detect.stdout.trim() === 'true'

  if (!isRepo) {
    // Pick the initial branch name explicitly so we don't depend on the user's
    // init.defaultBranch global config (could be master, main, or trunk).
    await git(repoPath, ['init', '-b', 'main'], { allowFailure: true })
    // Fallback for older git that doesn't support -b on init.
    if (!(await pathExists(join(repoPath, '.git')))) {
      await git(repoPath, ['init'])
      await git(repoPath, ['checkout', '-B', 'main'], { allowFailure: true })
    }
    // Local config only — must not leak into the user's --global config.
    await git(repoPath, ['config', 'user.email', 'gnap@tachidesk.local'])
    await git(repoPath, ['config', 'user.name', 'tachi-gnap'])
  }

  // Layout: version + agents.json + per-kind dirs with .gitkeep so empty dirs
  // round-trip through git (which otherwise drops them).
  await writeFile(
    toFsPath(repoPath, PATH_VERSION),
    `${opts?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION}\n`,
    'utf8',
  )
  if (!(await pathExists(toFsPath(repoPath, PATH_AGENTS)))) {
    await writeJson(toFsPath(repoPath, PATH_AGENTS), { agents: [] })
  }
  for (const dir of [DIR_TASKS, DIR_RUNS, DIR_MESSAGES]) {
    const full = toFsPath(repoPath, dir)
    await mkdir(full, { recursive: true })
    const keep = join(full, '.gitkeep')
    if (!(await pathExists(keep))) await writeFile(keep, '', 'utf8')
  }

  await git(repoPath, [
    'add',
    '--',
    PATH_VERSION,
    PATH_AGENTS,
    posixPath.join(DIR_TASKS, '.gitkeep'),
    posixPath.join(DIR_RUNS, '.gitkeep'),
    posixPath.join(DIR_MESSAGES, '.gitkeep'),
  ])

  // Only commit if there's something staged — re-running initSwarm on an
  // already-initialized repo should be a no-op rather than producing an empty
  // commit on every call.
  const status = await git(repoPath, ['status', '--porcelain'])
  if (status.stdout.trim()) {
    await git(repoPath, ['commit', '-m', 'gnap: init swarm'])
  }
}

// ─── Agents ───────────────────────────────────────────────────────────────────

async function listAgents(repoPath: string): Promise<GnapAgent[]> {
  return (await readAgentsFile(repoPath)).agents
}

async function registerAgent(repoPath: string, agent: GnapAgent): Promise<void> {
  const res = await commitAndPush({
    repoPath,
    relPaths: [PATH_AGENTS],
    message: `${agent.id}: register agent`,
    mutate: async () => {
      const file = await readAgentsFile(repoPath)
      // Upsert by id so re-registering refreshes status/capabilities without
      // duplicating the entry.
      const idx = file.agents.findIndex((a) => a.id === agent.id)
      if (idx >= 0) file.agents[idx] = agent
      else file.agents.push(agent)
      await writeJson(toFsPath(repoPath, PATH_AGENTS), file)
    },
  })
  if (!res.ok) throw new Error(`registerAgent: ${res.reason ?? 'unknown error'}`)
}

async function updateAgentStatus(
  repoPath: string,
  agentId: string,
  status: GnapAgent['status'],
): Promise<void> {
  const res = await commitAndPush({
    repoPath,
    relPaths: [PATH_AGENTS],
    message: `${agentId}: status=${status}`,
    mutate: async () => {
      const file = await readAgentsFile(repoPath)
      const a = file.agents.find((x) => x.id === agentId)
      if (!a) throw new Error(`agent ${agentId} not found`)
      a.status = status
      await writeJson(toFsPath(repoPath, PATH_AGENTS), file)
    },
  })
  if (!res.ok)
    throw new Error(`updateAgentStatus: ${res.reason ?? 'unknown error'}`)
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

async function listTasks(
  repoPath: string,
  filter?: { state?: GnapTaskState; assignedTo?: string },
): Promise<GnapTask[]> {
  const dir = toFsPath(repoPath, DIR_TASKS)
  const files = await listJsonFiles(dir)
  const out: GnapTask[] = []
  for (const f of files) {
    try {
      const t = JSON.parse(await readFile(join(dir, f), 'utf8')) as GnapTask
      if (filter?.state && t.state !== filter.state) continue
      if (filter?.assignedTo && !t.assigned_to.includes(filter.assignedTo))
        continue
      out.push(t)
    } catch (err) {
      logErr(`listTasks: failed to parse ${f}`, err)
    }
  }
  return out
}

async function createTask(repoPath: string, task: GnapTask): Promise<void> {
  const rel = posixPath.join(DIR_TASKS, `${task.id}.json`)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${task.created_by}: create task ${task.id}`,
    mutate: async () => {
      await writeJson(toFsPath(repoPath, rel), task)
    },
  })
  if (!res.ok) throw new Error(`createTask: ${res.reason ?? 'unknown error'}`)
}

async function updateTaskState(
  repoPath: string,
  taskId: string,
  state: GnapTaskState,
  by: string,
): Promise<void> {
  const rel = posixPath.join(DIR_TASKS, `${taskId}.json`)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${by}: task ${taskId} -> ${state}`,
    mutate: async () => {
      // Re-read on every attempt so a concurrent edit doesn't clobber unrelated
      // fields when we re-apply our state change.
      const t = await readTaskFile(repoPath, taskId)
      if (!t) throw new Error(`task ${taskId} not found`)
      t.state = state
      await writeJson(toFsPath(repoPath, rel), t)
    },
  })
  if (!res.ok) throw new Error(`updateTaskState: ${res.reason ?? 'unknown error'}`)
}

async function claimTask(
  repoPath: string,
  taskId: string,
  agentId: string,
  ttlSec: number = DEFAULT_CLAIM_TTL_SEC,
): Promise<{ ok: boolean; reason?: string }> {
  const rel = posixPath.join(DIR_TASKS, `${taskId}.json`)
  // Pre-flight: a live claim by someone else short-circuits before we even
  // touch git. This is best-effort — a peer could claim between this check
  // and our push — but it avoids burning push retries on the common case.
  const existing = await readTaskFile(repoPath, taskId)
  if (!existing) return { ok: false, reason: 'task not found' }
  if (existing.claim) {
    const expiresMs = Date.parse(existing.claim.expires_at)
    if (
      Number.isFinite(expiresMs) &&
      expiresMs > Date.now() &&
      existing.claim.agent !== agentId
    ) {
      return {
        ok: false,
        reason: `claimed by ${existing.claim.agent} until ${existing.claim.expires_at}`,
      }
    }
  }

  let lastReason: string | undefined
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${agentId}: claim task ${taskId}`,
    mutate: async () => {
      const t = await readTaskFile(repoPath, taskId)
      if (!t) throw new Error(`task ${taskId} not found`)
      // Re-check after rebase — the peer may have just claimed it.
      if (t.claim) {
        const expiresMs = Date.parse(t.claim.expires_at)
        if (
          Number.isFinite(expiresMs) &&
          expiresMs > Date.now() &&
          t.claim.agent !== agentId
        ) {
          lastReason = `claimed by ${t.claim.agent} until ${t.claim.expires_at}`
          // Throwing here cancels the current attempt; commitAndPush will catch
          // it from the next git add (no-op), then push (no-op). To make this
          // semantic cleaner we instead leave the file unchanged and let the
          // commit be a no-op with --allow-empty. Bail by returning early.
          return
        }
      }
      const now = Date.now()
      t.claim = {
        agent: agentId,
        at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlSec * 1000).toISOString(),
      }
      t.state = 'in_progress'
      if (!t.assigned_to.includes(agentId)) t.assigned_to.push(agentId)
      await writeJson(toFsPath(repoPath, rel), t)
    },
  })

  if (!res.ok) return { ok: false, reason: res.reason }

  // After a successful push, confirm we actually own the claim. Two reasons
  // this matters:
  //   1. mutate() may have bailed because of a live peer claim (no field
  //      written) — push succeeds but our claim isn't there.
  //   2. We pulled a peer's claim during rebase that fenced us out.
  const final = await readTaskFile(repoPath, taskId)
  if (!final?.claim || final.claim.agent !== agentId) {
    return {
      ok: false,
      reason:
        lastReason ??
        (final?.claim
          ? `claim taken by ${final.claim.agent}`
          : 'claim not present after push'),
    }
  }
  return { ok: true }
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

async function startRun(
  repoPath: string,
  run: Omit<GnapRun, 'commits' | 'artifacts'> & {
    commits?: string[]
    artifacts?: string[]
  },
): Promise<void> {
  const full: GnapRun = {
    ...run,
    commits: run.commits ?? [],
    artifacts: run.artifacts ?? [],
  }
  const rel = posixPath.join(DIR_RUNS, `${full.id}.json`)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${full.agent}: start run ${full.id}`,
    mutate: () => writeJson(toFsPath(repoPath, rel), full),
  })
  if (!res.ok) throw new Error(`startRun: ${res.reason ?? 'unknown error'}`)
}

async function completeRun(
  repoPath: string,
  runId: string,
  patch: Partial<GnapRun>,
): Promise<void> {
  const rel = posixPath.join(DIR_RUNS, `${runId}.json`)
  const fp = toFsPath(repoPath, rel)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `complete run ${runId}`,
    mutate: async () => {
      if (!(await pathExists(fp))) throw new Error(`run ${runId} not found`)
      const current = JSON.parse(await readFile(fp, 'utf8')) as GnapRun
      const next: GnapRun = { ...current, ...patch, id: current.id }
      if (!next.finished_at) next.finished_at = nowIso()
      await writeJson(fp, next)
    },
  })
  if (!res.ok) throw new Error(`completeRun: ${res.reason ?? 'unknown error'}`)
}

async function listRuns(repoPath: string, taskId?: string): Promise<GnapRun[]> {
  const dir = toFsPath(repoPath, DIR_RUNS)
  const files = await listJsonFiles(dir)
  const out: GnapRun[] = []
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(join(dir, f), 'utf8')) as GnapRun
      if (taskId && r.task !== taskId) continue
      out.push(r)
    } catch (err) {
      logErr(`listRuns: failed to parse ${f}`, err)
    }
  }
  return out
}

// ─── Messages ─────────────────────────────────────────────────────────────────

async function postMessage(repoPath: string, msg: GnapMessage): Promise<void> {
  const id = msg.id || genId('msg')
  const full: GnapMessage = { ...msg, id }
  const rel = posixPath.join(DIR_MESSAGES, `${id}.json`)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${full.from}: post message ${id}`,
    mutate: () => writeJson(toFsPath(repoPath, rel), full),
  })
  if (!res.ok) throw new Error(`postMessage: ${res.reason ?? 'unknown error'}`)
}

async function listMessages(
  repoPath: string,
  filter?: { to?: string; unreadBy?: string },
): Promise<GnapMessage[]> {
  const dir = toFsPath(repoPath, DIR_MESSAGES)
  const files = await listJsonFiles(dir)
  const out: GnapMessage[] = []
  for (const f of files) {
    try {
      const m = JSON.parse(await readFile(join(dir, f), 'utf8')) as GnapMessage
      if (filter?.to && !m.to.includes(filter.to)) continue
      if (filter?.unreadBy && m.read_by?.includes(filter.unreadBy)) continue
      out.push(m)
    } catch (err) {
      logErr(`listMessages: failed to parse ${f}`, err)
    }
  }
  return out
}

async function markRead(
  repoPath: string,
  msgId: string,
  agentId: string,
): Promise<void> {
  const rel = posixPath.join(DIR_MESSAGES, `${msgId}.json`)
  const fp = toFsPath(repoPath, rel)
  const res = await commitAndPush({
    repoPath,
    relPaths: [rel],
    message: `${agentId}: read ${msgId}`,
    mutate: async () => {
      if (!(await pathExists(fp))) throw new Error(`message ${msgId} not found`)
      const m = JSON.parse(await readFile(fp, 'utf8')) as GnapMessage
      const read = new Set(m.read_by ?? [])
      read.add(agentId)
      m.read_by = Array.from(read)
      await writeJson(fp, m)
    },
  })
  if (!res.ok) throw new Error(`markRead: ${res.reason ?? 'unknown error'}`)
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

function watch(
  repoPath: string,
  onEvent: (info: {
    sha: string
    subject: string
    touchedFiles: string[]
  }) => void,
): () => void {
  // We use Node's built-in fs.watch on `.git/HEAD` and the resolved branch
  // ref. chokidar would be nicer but isn't a declared dependency, and the
  // surface we need to monitor is exactly two files — well within fs.watch's
  // sweet spot. Whenever either changes we resolve HEAD's current commit and,
  // if it differs from the last seen sha, emit.
  const headFile = join(repoPath, '.git', 'HEAD')
  let lastSha: string | null = null
  const watchers: FSWatcher[] = []
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const sha = (
        await git(repoPath, ['rev-parse', 'HEAD'], { allowFailure: true })
      ).stdout.trim()
      if (!sha || sha === lastSha) return
      lastSha = sha
      const log = await git(
        repoPath,
        ['log', '-1', '--name-only', '--format=%H%n%s', sha],
        { allowFailure: true },
      )
      // git log -1 --name-only --format prints:
      //   <sha>\n<subject>\n\n<file>\n<file>\n
      // Splitting on \n and trimming empties yields [sha, subject, ...files].
      const lines = log.stdout.split(/\r?\n/).filter((l) => l.length > 0)
      const [shaLine, subject, ...touchedFiles] = lines
      if (!shaLine) return
      onEvent({ sha: shaLine, subject: subject ?? '', touchedFiles })
    } catch (err) {
      logErr('watch tick failed', err)
    }
  }

  // Prime with the current sha so the first real change fires rather than
  // re-emitting whatever commit existed when we started watching.
  void tick().catch(() => {
    /* tick already swallows */
  })

  // Async existence probe so we don't block the event loop, but the watcher
  // registration itself is fire-and-forget — `watch()` still returns its
  // synchronous teardown closure immediately. The `stopped` guard ensures a
  // late-resolving probe doesn't attach a watcher after teardown.
  const watchSafe = async (path: string): Promise<void> => {
    if (stopped) return
    if (!(await pathExists(path))) return
    if (stopped) return
    try {
      const w = fsWatch(path, () => {
        // Debounce-ish: fs.watch fires twice on some platforms per write.
        // tick() is idempotent (gated by lastSha) so this is harmless.
        void tick()
      })
      w.on('error', (err) => logErr(`fs.watch error on ${path}`, err))
      watchers.push(w)
    } catch (err) {
      logErr(`failed to watch ${path}`, err)
    }
  }

  // Watch HEAD itself (changes on branch checkout) and the packed-refs file
  // (changes when refs get packed). The branch tip file is also watched
  // because most local commits update refs/heads/<branch> directly.
  void watchSafe(headFile)
  void watchSafe(join(repoPath, '.git', 'packed-refs'))
  // Best-effort branch ref. We don't await — if the repo is mid-init the
  // ref may not exist yet, and we'll fall back to HEAD/packed-refs signals.
  void getCurrentBranch(repoPath)
    .then((branch) => {
      const refPath = join(repoPath, '.git', 'refs', 'heads', branch)
      void watchSafe(refPath)
    })
    .catch(() => {
      /* repo may not be initialized; HEAD watcher will catch the first commit */
    })

  return () => {
    stopped = true
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
    watchers.length = 0
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGnapClient(): GnapClient {
  return {
    initSwarm,
    listAgents,
    registerAgent,
    updateAgentStatus,
    listTasks,
    createTask,
    updateTaskState,
    claimTask,
    startRun,
    completeRun,
    listRuns,
    postMessage,
    listMessages,
    markRead,
    watch,
  }
}

// Exposed for callers that want to suffix bare-repo naming uniformly.
export const GNAP_DEFAULT_BARE_DIR_SUFFIX = DEFAULT_BARE_DIR_SUFFIX
