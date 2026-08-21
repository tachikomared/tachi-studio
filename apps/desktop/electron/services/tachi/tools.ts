// apps/desktop/electron/services/tachi/tools.ts
//
// The TACHI core toolset (the "narrow waist"): read, write, edit, bash, grep,
// glob. These are plain async functions — NOT AI SDK tools with `execute`.
// The loop (loop.ts) intentionally drives execution itself so it can gate each
// call through TachiDesk's permission/egress/role machinery BEFORE the side
// effect (pre-emptive, unlike the post-hoc sidecar gates).
//
// All file paths resolve through resolveInside() against the session
// workspaceRoot — the same sandbox the in-process MCP server uses. bash runs
// via a shell but its command is classified (safety.ts) and egress-checked by
// the caller; here we only enforce cwd + output caps + timeout.

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { applyEdit, signalCompact, buildCodeGraph, blastRadius, tracePath, summarizeArchitecture, parseExportedSymbols, parseDefinitions, parseImportBindings, isSourceFile, CompactedStore, queryCompacted, compactionReceipt, elisionNotice, type CcrQueryMode } from '@tachi/core'
import { extractCalls } from './call-graph'
import { resolveInside } from '../../mcp/sandbox'
import { detectExecFailure } from '../util/exec-failure'
import { isDestructiveCommand } from '../destructive-commands'

export interface ToolContext {
  workspaceRoot: string
  /** Session store of full tool outputs for CCR reversible compaction (expand_compacted). */
  compacted?: CompactedStore
  /** Session-scoped background bash tasks (bash {background:true}) — killed at session end. */
  bgTasks?: Map<string, BgTask>
}

export interface ToolResult {
  /** Model-facing text (already truncated/compacted). */
  output: string
  /** True when the tool failed; output carries the error message. */
  isError: boolean
}

const READ_MAX_BYTES = 256 * 1024
const BASH_TIMEOUT_MS = 120_000
const BASH_MAX_BUFFER = 1024 * 1024 // 1 MiB capture cap

function ok(output: string): ToolResult { return { output, isError: false } }
function err(message: string): ToolResult { return { output: message, isError: true } }

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`${key} must be a string`)
  return v
}
function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number') throw new Error(`${key} must be a number`)
  return v
}

// ── read ────────────────────────────────────────────────────────────────────
function toolRead(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const abs = resolveInside(ctx.workspaceRoot, str(args, 'path'))
  if (!existsSync(abs)) return err(`File not found: ${args.path}`)
  const st = statSync(abs)
  if (st.isDirectory()) {
    const entries = readdirSync(abs, { withFileTypes: true })
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
    return ok(`Directory ${args.path} (${entries.length} entries):\n${entries.join('\n')}`)
  }
  const buf = readFileSync(abs)
  const truncated = buf.length > READ_MAX_BYTES
  const text = (truncated ? buf.subarray(0, READ_MAX_BYTES) : buf).toString('utf8')
  const offset = Math.max(0, Math.floor(optNum(args, 'offset') ?? 0))
  const limit = Math.max(1, Math.floor(optNum(args, 'limit') ?? 2000))
  const allLines = text.split('\n')
  const slice = allLines.slice(offset, offset + limit)
  // cat -n style numbering for orientation (edits address by content, not number).
  const numbered = slice.map((l, i) => `${String(offset + i + 1).padStart(6)}\t${l}`).join('\n')
  const more = offset + limit < allLines.length
    ? `\n[... ${allLines.length - (offset + limit)} more lines — read with offset=${offset + limit} ...]`
    : ''
  const byteNote = truncated ? `\n[... file exceeds ${READ_MAX_BYTES} bytes; tail not shown ...]` : ''
  return ok(numbered + more + byteNote)
}

// ── write ───────────────────────────────────────────────────────────────────
function toolWrite(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const abs = resolveInside(ctx.workspaceRoot, str(args, 'path'))
  const content = str(args, 'content')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  const rel = relative(ctx.workspaceRoot, abs).split(sep).join('/')
  return ok(`Wrote ${content.length} chars to ${rel}`)
}

// ── edit ──────────────────────────────────────────────────────────────────────
function toolEdit(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const abs = resolveInside(ctx.workspaceRoot, str(args, 'path'))
  const oldString = str(args, 'oldString')
  const newString = str(args, 'newString')
  const exists = existsSync(abs)
  const content = exists ? readFileSync(abs, 'utf8') : ''
  const res = applyEdit(content, oldString, newString)
  if (!res.ok) {
    const hint =
      res.reason === 'multiple-matches' ? ' Include more surrounding context in oldString to make it unique.'
      : res.reason === 'not-found' ? ' The oldString was not found — read the file again and copy the exact text.'
      : res.reason === 'disproportionate' ? ' The closest match was implausibly large; narrow oldString.'
      : ''
    return err(`Edit failed (${res.reason}): ${res.detail}.${hint}`)
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, res.content, 'utf8')
  const rel = relative(ctx.workspaceRoot, abs).split(sep).join('/')
  return ok(`Edited ${rel} (${res.strategy} match)`)
}

// ── bash hardening ────────────────────────────────────────────────────────────
// bash is an arbitrary shell, not an OS sandbox (audit 2026-06-12, dimension 6).
// Three defense-in-depth layers below the cwd-jail / timeout / output-cap that
// were already here: (1) scrub the inherited env so process.env secrets (API
// keys) never reach the child; (2) kill the whole process TREE on timeout, not
// just the shell (grandchildren outlive proc.kill()); (3) hard-deny a small set
// of catastrophic commands before spawning.

/**
 * Build a MINIMAL allow-listed env for the child. We intentionally do NOT
 * inherit process.env — it carries provider API keys, wallet material and other
 * secrets. Only the variables needed for a shell + binaries to resolve are
 * forwarded; everything else is dropped.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const isWin = process.platform === 'win32'
  const allow = isWin
    ? ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'TERM']
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  return env
}

/**
 * Kill the whole process tree rooted at `proc`. A plain proc.kill() only signals
 * the shell, leaving any children/grandchildren (e.g. a spawned node/python)
 * running. On Windows we use `taskkill /T /F`; on POSIX the child is launched in
 * its own process group (detached) so we can signal the negative pid.
 */
function killTree(proc: import('node:child_process').ChildProcess): void {
  const pid = proc.pid
  if (pid === undefined) { try { proc.kill() } catch { /* already gone */ } return }
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* best effort */ }
    return
  }
  // POSIX: negative pid signals the whole group. Fall back to the bare pid.
  try { process.kill(-pid, 'SIGKILL') } catch {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

// ── background bash tasks ─────────────────────────────────────────────────────
// 2026 table stakes: the agent can start a LONG-RUNNING command (dev server,
// watch build) and keep working — bash {background:true} returns immediately
// with a task id; bash_output tails the ring buffer; bash_kill stops the tree.
// Tasks are session-scoped (ToolContext) and killed by killAllBgTasks at
// session end so nothing outlives the run.

export interface BgTask {
  proc: import('node:child_process').ChildProcess
  buf: string
  done: boolean
  exitCode: number | null
  command: string
}

const BG_BUF_CAP = 64 * 1024

function bgKillTree(proc: import('node:child_process').ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGKILL')
    }
  } catch { /* already gone */ }
}

/** Kill every background task of a session (loop calls this on completion/abort). */
export function killAllBgTasks(ctx: ToolContext): void {
  for (const t of ctx.bgTasks?.values() ?? []) {
    if (!t.done) bgKillTree(t.proc)
  }
  ctx.bgTasks?.clear()
}

function toolBashBackground(ctx: ToolContext, command: string): ToolResult {
  ctx.bgTasks = ctx.bgTasks ?? new Map()
  if ([...ctx.bgTasks.values()].filter(t => !t.done).length >= 4) {
    return err('Too many background tasks (max 4 running). bash_kill one first.')
  }
  const id = `bg-${ctx.bgTasks.size + 1}`
  const proc = spawn(command, {
    cwd: ctx.workspaceRoot,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const task: BgTask = { proc, buf: '', done: false, exitCode: null, command }
  const append = (d: Buffer) => { task.buf = (task.buf + d.toString()).slice(-BG_BUF_CAP) }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  proc.on('error', (e) => { task.buf += `\n[spawn error: ${e.message}]`; task.done = true })
  proc.on('exit', (code) => { task.done = true; task.exitCode = code })
  ctx.bgTasks.set(id, task)
  return ok(`Background task ${id} started (pid ${proc.pid ?? '?'}): \`${command.slice(0, 120)}\`\nPoll it with bash_output {task_id:"${id}"}; stop it with bash_kill {task_id:"${id}"}. It is killed automatically when this session ends.`)
}

function toolBashOutput(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const id = str(args, 'task_id')
  const task = ctx.bgTasks?.get(id)
  if (!task) return err(`No background task "${id}" in this session. Running: ${[...(ctx.bgTasks?.keys() ?? [])].join(', ') || '(none)'}`)
  const tailLines = optNum(args, 'tail_lines') ?? 60
  const lines = task.buf.split('\n')
  const tail = lines.slice(-Math.max(1, Math.min(tailLines, 500))).join('\n')
  const status = task.done ? `EXITED (code ${task.exitCode})` : 'RUNNING'
  return ok(`[${id}] ${status} — \`${task.command.slice(0, 100)}\`\n${tail || '(no output yet)'}`)
}

function toolBashKill(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const id = str(args, 'task_id')
  const task = ctx.bgTasks?.get(id)
  if (!task) return err(`No background task "${id}" in this session.`)
  if (task.done) return ok(`[${id}] already exited (code ${task.exitCode}).`)
  bgKillTree(task.proc)
  task.done = true
  return ok(`[${id}] process tree killed.`)
}

// ── bash ──────────────────────────────────────────────────────────────────────
function toolBash(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const command = str(args, 'command')
  // Hard-deny catastrophic commands BEFORE spawning (conservative — normal dev
  // work like build/test/scoped cleanup is unaffected). This is defense-in-depth,
  // never a substitute for OS isolation.
  const verdict = isDestructiveCommand(command)
  if (verdict.destructive) {
    return Promise.resolve(err(`Refused: this command is blocked as catastrophic (${verdict.reason ?? 'destructive'}). bash is not an OS sandbox; rephrase to a scoped, reversible command.`))
  }
  // Long-running commands detach into a session-scoped background task instead
  // of eating the 120s foreground timeout.
  if (args.background === true) {
    return Promise.resolve(toolBashBackground(ctx, command))
  }
  // Test-only override for the timeout (keeps the production default intact).
  const overrideTimeout = optNum(args, '__timeoutMs')
  const timeoutMs = overrideTimeout !== undefined && overrideTimeout > 0 ? overrideTimeout : BASH_TIMEOUT_MS
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : '/bin/sh'
    const shellArgs = isWin ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
    let out = ''
    let killed = false
    // POSIX: detached gives the child its own process group so killTree can
    // signal the group. Windows has no process groups here — taskkill /T walks
    // the tree by pid, and detached would pop a console window, so leave it off.
    const proc = spawn(shell, shellArgs, {
      cwd: ctx.workspaceRoot,
      windowsHide: true,
      env: scrubbedEnv(),
      detached: !isWin,
    })
    const timer = setTimeout(() => { killed = true; killTree(proc) }, timeoutMs)
    const onData = (d: Buffer) => {
      if (out.length < BASH_MAX_BUFFER) out += d.toString('utf8')
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => { clearTimeout(timer); resolve(err(`bash spawn error: ${e.message}`)) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      // Signal-scored compaction: keep head+tail AND every high-signal line
      // (errors/panics/file:line) — a flat head/tail would drop a mid-log error.
      const capped = signalCompact(out)
      let body = capped.text || '(no output)'
      // CCR (reversible compaction): when signalCompact elided content, keep the
      // FULL output in the session store and point the model at expand_compacted
      // so it can recover the detail without re-running the command. Both paths
      // carry the authoritative do-not-re-run contract (tokenjuice footer) —
      // without it models re-run the command with varied flags chasing the
      // omitted middle.
      if (ctx.compacted && capped.text.length < out.length) {
        const id = ctx.compacted.save(out)
        body += compactionReceipt(id, out.length, capped.text.length)
      } else if (capped.text.length < out.length) {
        body += elisionNotice(out.length, capped.text.length)
      }
      const head = killed
        ? `[command timed out after ${timeoutMs} ms — rerun with a tighter scope]\n`
        : `Exit code: ${code ?? 'null'}\n`
      if (code !== 0 && !killed) { resolve({ output: head + body, isError: true }); return }
      // Belt-and-suspenders for the exit-0 (not-killed) path: a process can print
      // a crash (Go/Rust panic, segfault) to stderr — merged here via 2>&1 — yet a
      // wrapper script still exits 0. Surface the real outcome so the model doesn't
      // treat a silent failure as success.
      if (!killed) {
        const fail = detectExecFailure(capped.text)
        if (fail.failed) {
          resolve({ output: `[exit 0 but output looks like a failure: ${fail.matched}]\n${head}${body}`, isError: true })
          return
        }
      }
      resolve(ok(head + body))
    })
  })
}

// ── grep ──────────────────────────────────────────────────────────────────────
function toolGrep(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const pattern = str(args, 'pattern')
  const subPath = (args.path as string | undefined) ?? '.'
  const root = resolveInside(ctx.workspaceRoot, subPath)
  let re: RegExp
  try { re = new RegExp(pattern, 'i') } catch (e) { return err(`Invalid regex: ${(e as Error).message}`) }
  const hits: string[] = []
  const MAX = 200
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build'])
  // Never read secret-bearing files into model context — grep output would leak them.
  const SECRET_FILES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.dockercfg', 'id_rsa', 'id_ed25519'])
  const isSecretFile = (name: string) => name === '.env' || name.startsWith('.env.') || SECRET_FILES.has(name)
  const walk = (dir: string): void => {
    if (hits.length >= MAX) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (hits.length >= MAX) return
      if (isSecretFile(e.name)) continue  // don't grep secrets into model context
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue }
      let content: string
      try {
        const st = statSync(full)
        if (st.size > READ_MAX_BYTES) continue
        content = readFileSync(full, 'utf8')
      } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && hits.length < MAX; i++) {
        if (re.test(lines[i] as string)) {
          const rel = relative(ctx.workspaceRoot, full).split(sep).join('/')
          const text = (lines[i] as string).length > 240 ? (lines[i] as string).slice(0, 240) + '…' : lines[i]
          hits.push(`${rel}:${i + 1}: ${text}`)
        }
      }
    }
  }
  walk(root)
  if (hits.length === 0) return ok(`No matches for /${pattern}/i`)
  const trunc = hits.length >= MAX ? `\n[... results capped at ${MAX} ...]` : ''
  return ok(hits.join('\n') + trunc)
}

// ── glob ──────────────────────────────────────────────────────────────────────
function toolGlob(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const pattern = str(args, 'pattern')
  // Translate a simple glob (**, *, ?) to a regex over workspace-relative POSIX paths.
  const reStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '[^/]') + '$'
  let re: RegExp
  try { re = new RegExp(reStr) } catch (e) { return err(`Invalid glob: ${(e as Error).message}`) }
  const matches: string[] = []
  const MAX = 300
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build'])
  const walk = (dir: string): void => {
    if (matches.length >= MAX) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (matches.length >= MAX) return
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue }
      const rel = relative(ctx.workspaceRoot, full).split(sep).join('/')
      if (re.test(rel)) matches.push(rel)
    }
  }
  walk(ctx.workspaceRoot)
  if (matches.length === 0) return ok(`No files match ${pattern}`)
  const trunc = matches.length >= MAX ? `\n[... capped at ${MAX} ...]` : ''
  return ok(matches.sort().join('\n') + trunc)
}

// ── blast_radius (read-only static analysis) ──────────────────────────────────
// "What breaks if I touch this file?" — a code-dependency graph + reverse-BFS
// (RAG decision REVISIT 2026-06-22: for code we use agentic search + a fresh
// import graph, NOT a stale vector index). Builds the graph on demand from the
// workspace's TS/JS source; fine for normal repos (a few hundred–few thousand
// files of regex+BFS is fast), cached later if a giant monorepo needs it.

const GRAPH_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage'])
const GRAPH_MAX_FILES = 4000

/**
 * Tracked source files via `git ls-files` — the project's REAL source, which
 * automatically excludes untracked clones and ignored trees (.research-tmp,
 * .claude worktrees, node_modules). null when this isn't a git repo / git is
 * unavailable, so the caller falls back to a filesystem walk.
 */
function gitTrackedSourceFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const paths = out.split('\0').filter(Boolean).filter(isSourceFile)
    return paths.length > 0 ? paths : null
  } catch { return null }
}

function collectSourceFiles(root: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  const push = (rel: string, abs: string): void => {
    try { if (statSync(abs).size <= READ_MAX_BYTES) files.push({ path: rel, text: readFileSync(abs, 'utf8') }) }
    catch { /* skip unreadable / tracked-but-deleted */ }
  }

  // Prefer git: index exactly the repo's tracked source — never vendored clones.
  const tracked = gitTrackedSourceFiles(root)
  if (tracked) {
    for (const rel of tracked) { if (files.length >= GRAPH_MAX_FILES) break; push(rel, join(root, rel)) }
    return files
  }

  // Fallback (not a git repo): FS walk, skipping vendor + dot directories.
  const walk = (dir: string): void => {
    if (files.length >= GRAPH_MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= GRAPH_MAX_FILES) return
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!GRAPH_SKIP.has(e.name) && !e.name.startsWith('.')) walk(full); continue }
      const rel = relative(root, full).split(sep).join('/')
      if (isSourceFile(rel)) push(rel, full)
    }
  }
  walk(root)
  return files
}

function toolBlastRadius(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const abs = resolveInside(ctx.workspaceRoot, str(args, 'path'))
  const rel = relative(ctx.workspaceRoot, abs).split(sep).join('/')
  const maxDepth = optNum(args, 'maxDepth')
  const files = collectSourceFiles(ctx.workspaceRoot)
  if (!files.some(f => f.path === rel)) {
    return ok(`${rel} is not an indexed source file (only .ts/.tsx/.js/.jsx/.mjs/.cjs under the workspace are graphed). Nothing to report.`)
  }
  const graph = buildCodeGraph(files)
  const affected = blastRadius(graph, rel, maxDepth !== undefined ? { maxDepth } : {})
  if (affected.length === 0) {
    return ok(`No file imports ${rel} (directly or transitively). Editing it has no internal blast radius.`)
  }
  const CAP = 200
  const shown = affected.slice(0, CAP)
  const trunc = affected.length > CAP ? `\n[... ${affected.length - CAP} more ...]` : ''
  return ok(`${affected.length} file(s) transitively import ${rel} — an edit here could affect:\n${shown.join('\n')}${trunc}`)
}

function toolTracePath(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const rel = (p: string): string => relative(ctx.workspaceRoot, resolveInside(ctx.workspaceRoot, p)).split(sep).join('/')
  const fromRel = rel(str(args, 'from'))
  const toRel = rel(str(args, 'to'))
  const files = collectSourceFiles(ctx.workspaceRoot)
  const have = new Set(files.map(f => f.path))
  if (!have.has(fromRel)) return ok(`${fromRel} is not an indexed source file (only .ts/.tsx/.js/.jsx/.mjs/.cjs under the workspace are graphed).`)
  if (!have.has(toRel)) return ok(`${toRel} is not an indexed source file.`)
  const path = tracePath(buildCodeGraph(files), fromRel, toRel)
  if (!path) return ok(`${fromRel} does not import ${toRel} (directly or transitively) — no dependency path.`)
  if (path.length === 1) return ok(`${fromRel} and ${toRel} are the same file.`)
  return ok(`${fromRel} depends on ${toRel} via ${path.length - 1} hop(s):\n${path.join('\n  → ')}`)
}

function toolGetArchitecture(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const topHubs = optNum(args, 'topHubs') ?? 15
  const files = collectSourceFiles(ctx.workspaceRoot)
  if (files.length === 0) return ok('No graphed source files under the workspace.')
  const summary = summarizeArchitecture(buildCodeGraph(files), { topHubs })
  const textByPath = new Map(files.map(f => [f.path, f.text]))
  const cap = (xs: string[], n: number): string => `${xs.slice(0, n).join(', ')}${xs.length > n ? `, … (+${xs.length - n})` : ''}`
  const lines: string[] = [`${summary.fileCount} source file(s), ${summary.edgeCount} internal import edge(s).`]
  if (summary.hubs.length > 0) {
    lines.push('', 'Hub files (most depended-upon — understand these first):')
    for (const h of summary.hubs) {
      const exps = parseExportedSymbols(textByPath.get(h.path) ?? '')
      lines.push(`  ${h.path} (imported by ${h.importedBy})${exps.length ? ` — exports ${cap(exps, 8)}` : ''}`)
    }
  }
  if (summary.entryPoints.length > 0) lines.push('', `Entry points (imported by nobody): ${cap(summary.entryPoints, 20)}`)
  if (summary.orphans.length > 0) lines.push('', `Isolated files (no imports, no importers): ${cap(summary.orphans, 20)}`)
  return ok(lines.join('\n'))
}

function toolFindDefinition(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const name = str(args, 'name')
  const files = collectSourceFiles(ctx.workspaceRoot)
  const hits: { path: string; line: number; kind: string; exported: boolean }[] = []
  for (const f of files) {
    for (const d of parseDefinitions(f.text)) {
      if (d.name === name) hits.push({ path: f.path, line: d.line, kind: d.kind, exported: d.exported })
    }
  }
  if (hits.length === 0) {
    return ok(`No top-level definition of "${name}" found in the ${files.length} graphed source files. (Only module-level function/class/const/let/var/interface/type/enum declarations are indexed — use grep for class members or usages.)`)
  }
  const CAP = 50
  const shown = hits.slice(0, CAP).map(h => `${h.path}:${h.line}  ${h.exported ? 'export ' : ''}${h.kind} ${name}`)
  const trunc = hits.length > CAP ? `\n[... ${hits.length - CAP} more ...]` : ''
  return ok(`${hits.length} definition(s) of "${name}":\n${shown.join('\n')}${trunc}`)
}

function toolFindReferences(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const name = str(args, 'name')
  const files = collectSourceFiles(ctx.workspaceRoot)
  const hits: { path: string; source: string }[] = []
  for (const f of files) {
    for (const b of parseImportBindings(f.text)) {
      if (b.imported === name || b.local === name) { hits.push({ path: f.path, source: b.source }); break }
    }
  }
  if (hits.length === 0) {
    return ok(`No file imports a symbol named "${name}". (Import-level references only — use grep for in-body usages, or find_definition for where it's declared.)`)
  }
  const CAP = 100
  const shown = hits.slice(0, CAP).map(h => `${h.path} — imports "${name}" from ${h.source}`)
  const trunc = hits.length > CAP ? `\n[... ${hits.length - CAP} more ...]` : ''
  return ok(`${hits.length} file(s) import "${name}":\n${shown.join('\n')}${trunc}`)
}

function toolFindCallers(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const name = str(args, 'name')
  const files = collectSourceFiles(ctx.workspaceRoot)
  const hits: { path: string; callerFn: string | null; line: number }[] = []
  for (const f of files) {
    if (!f.text.includes(name)) continue // cheap pre-filter — only AST-parse files that mention it
    let calls
    try { calls = extractCalls(f.text, f.path) } catch { continue } // a parse error must never break the tool
    for (const c of calls) {
      if (c.callee === name) hits.push({ path: f.path, callerFn: c.callerFn, line: c.line })
    }
  }
  if (hits.length === 0) {
    return ok(`No call sites of "${name}()" found in the ${files.length} graphed source files. (Resolves free + method calls by name; use find_references for imports, grep for other usages.)`)
  }
  const CAP = 100
  const shown = hits.slice(0, CAP).map(h => `${h.path}:${h.line} — ${h.callerFn ? `${h.callerFn}() calls ${name}()` : `top-level call to ${name}()`}`)
  const trunc = hits.length > CAP ? `\n[... ${hits.length - CAP} more ...]` : ''
  return ok(`${hits.length} call site(s) of "${name}()":\n${shown.join('\n')}${trunc}`)
}

function toolExpandCompacted(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  if (!ctx.compacted) return ok('No compacted-output store is available in this session.')
  const id = str(args, 'id')
  // CCR query modes (steal: OmniRoute ccrQuery): grep/head/tail/lines/stats are
  // far cheaper than paging; queryCompacted validates the mode itself, owns the
  // unknown-id message, and keeps 'full' identical to the old paged behaviour.
  const rawMode = args.mode
  const mode = typeof rawMode === 'string' ? (rawMode as CcrQueryMode) : undefined
  return ok(queryCompacted(ctx.compacted, id, {
    mode,
    offset: optNum(args, 'offset'),
    limit: optNum(args, 'limit'),
    start: optNum(args, 'start'),
    end: optNum(args, 'end'),
    pattern: typeof args.pattern === 'string' ? args.pattern : undefined,
    maxMatches: optNum(args, 'max_matches'),
  }))
}

// ── dispatch ────────────────────────────────────────────────────────────────
export const TACHI_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'blast_radius', 'trace_path', 'get_architecture', 'find_definition', 'find_references', 'find_callers', 'expand_compacted', 'bash_output', 'bash_kill'] as const
export type TachiToolName = typeof TACHI_TOOL_NAMES[number]

/** Execute a TACHI tool. Never throws — failures come back as { isError: true }. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read':  return toolRead(ctx, args)
      case 'write': return toolWrite(ctx, args)
      case 'edit':  return toolEdit(ctx, args)
      case 'bash':  return await toolBash(ctx, args)
      case 'grep':  return toolGrep(ctx, args)
      case 'glob':  return toolGlob(ctx, args)
      case 'blast_radius': return toolBlastRadius(ctx, args)
      case 'trace_path': return toolTracePath(ctx, args)
      case 'get_architecture': return toolGetArchitecture(ctx, args)
      case 'find_definition': return toolFindDefinition(ctx, args)
      case 'find_references': return toolFindReferences(ctx, args)
      case 'find_callers': return toolFindCallers(ctx, args)
      case 'expand_compacted': return toolExpandCompacted(ctx, args)
      case 'bash_output': return toolBashOutput(ctx, args)
      case 'bash_kill': return toolBashKill(ctx, args)
      default:      return err(`Unknown tool: ${name}`)
    }
  } catch (e) {
    return err(`${name} error: ${(e as Error).message}`)
  }
}
