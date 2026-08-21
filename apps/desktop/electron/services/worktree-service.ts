// apps/desktop/electron/services/worktree-service.ts
//
// Port of johannesjo/parallel-code's `electron/ipc/git.ts` worktree manager,
// adapted for Windows-first operation.
//
// What it does:
//   - `createWorktree`: `git worktree add -b <branch> <path>` from HEAD (or
//     a caller-supplied base branch). Creates `<repoRoot>/.worktrees/<branch>`.
//     Optionally symlinks selected sibling directories (`node_modules`,
//     `.env`, etc.) into the new worktree so a fresh checkout doesn't need
//     to re-install dependencies.
//   - `removeWorktree`: `git worktree remove --force` with a retry ladder for
//     transient locks on Windows (PNPM / antivirus often hold an exclusive
//     handle on `node_modules` briefly after a process exits). Falls back
//     to `git worktree prune` + best-effort `git branch -D`.
//
// Windows-critical bits:
//   - `fs.symlinkSync` type defaults to `'file'` on POSIX but on Windows
//     `'junction'` is required for directories to work WITHOUT Developer
//     Mode (`'dir'` symlinks need elevation; `'junction'` does not).
//     Junctions only work for absolute paths and only on the same volume —
//     we use absolute paths everywhere so this is fine.
//   - We refuse symlink "names" with `/`, `\`, or `..` so callers can't
//     escape the worktree via this surface.
//   - `.claude` is intentionally skipped from symlink candidates — each
//     parallel task gets its own per-worktree claude session.

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  statSync,
  appendFileSync,
  readFileSync,
  cpSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { parseGtrConfig, resolveCopyList, type ParsedGtrConfig } from './util/gtrconfig'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000
const REMOVAL_RETRY_DELAYS_MS = [0, 500, 1500, 3000]

/** Names we refuse to symlink, regardless of what the caller asked for. */
const SYMLINK_BLOCKLIST = new Set([
  '.claude',
  '.git',
  '.worktrees',
])

export interface CreateWorktreeOpts {
  projectRoot: string
  branchName:  string
  /** Optional base ref (branch name, tag, or commit). Defaults to HEAD. */
  baseBranch?: string
  /** Dir/file names (relative to projectRoot) to symlink into the worktree. */
  symlinkDirs?: string[]
}

export interface WorktreeCreateResult {
  worktreePath: string
  branchName:   string
  warnings:     string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface GitExecError extends Error {
  stdout?: string
  stderr?: string
}

async function git(
  repoPath: string,
  args: string[],
  opts: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { allowFailure = false, timeoutMs = GIT_TIMEOUT_MS } = opts
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Belt-and-suspenders: avoid credential prompts on headless invocations.
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

/**
 * Reject names with directory separators or parent-traversal so callers can't
 * escape projectRoot via the symlink-name surface.
 */
function isSafeSymlinkName(name: string): boolean {
  if (!name) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name === '..' || name.startsWith('..')) return false
  if (SYMLINK_BLOCKLIST.has(name)) return false
  return true
}

/**
 * Symlink type appropriate for the current platform + entry kind.
 *   - Windows + directory → 'junction' (works without Developer Mode)
 *   - Windows + file      → 'file'
 *   - POSIX   + directory → 'dir'
 *   - POSIX   + file      → 'file'
 */
function symlinkType(isDir: boolean): 'file' | 'dir' | 'junction' {
  if (process.platform === 'win32') {
    return isDir ? 'junction' : 'file'
  }
  return isDir ? 'dir' : 'file'
}

/**
 * Append entries to `.git/info/exclude` so files we drop into the worktree
 * (steps.json, claude session dirs, etc.) don't appear in diffs.
 *
 * `.git/info/exclude` is the per-clone equivalent of `.gitignore` that
 * doesn't get committed. parallel-code's original uses the same approach.
 */
export function addToGitInfoExclude(worktreePath: string, patterns: string[]): void {
  // For a worktree, .git is a *file* (with `gitdir:` pointing into the main
  // .git/worktrees/<id> dir), not a directory. The info/exclude file we want
  // to write is in the *main* .git directory. Easiest correct path: ask git.
  try {
    // Synchronous; tiny; fine. We're in IPC handlers, not the render loop.
    const stdout = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 5_000,
    })
    const gitCommonDir = stdout.trim()
    if (!gitCommonDir) return
    // gitCommonDir is relative to cwd OR absolute (depends on git version);
    // resolve against the worktreePath if relative.
    const commonDir = gitCommonDir.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(gitCommonDir)
      ? gitCommonDir
      : join(worktreePath, gitCommonDir)
    const excludePath = join(commonDir, 'info', 'exclude')
    if (!existsSync(dirname(excludePath))) {
      mkdirSync(dirname(excludePath), { recursive: true })
    }
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    const newLines: string[] = []
    for (const pattern of patterns) {
      if (!existing.split(/\r?\n/).includes(pattern)) {
        newLines.push(pattern)
      }
    }
    if (newLines.length > 0) {
      const prefix = existing.endsWith('\n') || existing === '' ? '' : '\n'
      appendFileSync(excludePath, prefix + newLines.join('\n') + '\n', 'utf8')
    }
  } catch {
    // Best-effort — diffs showing steps.json are mildly annoying but not fatal.
  }
}

// ─── .gtrconfig: per-project copy-files + lifecycle hooks ───────────────────────

/**
 * Load and parse `<projectRoot>/.gtrconfig` if present. Returns null when no
 * config file exists (the common case) so callers can skip all gtrconfig work.
 * Read errors degrade to null — a malformed/unreadable config must never block
 * worktree creation.
 */
function loadGtrConfig(projectRoot: string): ParsedGtrConfig | null {
  const configPath = join(projectRoot, '.gtrconfig')
  if (!existsSync(configPath)) return null
  try {
    return parseGtrConfig(readFileSync(configPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Copy each declared, existing `.gtrconfig` file from the project root into the
 * fresh worktree, preserving its relative path (creating parent dirs as needed).
 * Returns one warning per file that could not be copied; copy failures are
 * non-fatal. resolveCopyList stays pure (predicate-injected); the fs reads live
 * here.
 */
function copyGtrFiles(projectRoot: string, worktreePath: string, copy: string[]): string[] {
  const warnings: string[] = []
  const existing = resolveCopyList(copy, projectRoot, (rel) => existsSync(join(projectRoot, rel)))
  for (const rel of existing) {
    const src = join(projectRoot, rel)
    const dst = join(worktreePath, rel)
    try {
      mkdirSync(dirname(dst), { recursive: true })
      // recursive handles a declared directory; force overwrites a file git may
      // have already materialised from a tracked version.
      cpSync(src, dst, { recursive: true, force: true })
    } catch (err) {
      warnings.push(`gtrconfig copy failed for ${rel}: ${(err as Error).message}`)
    }
  }
  return warnings
}

/**
 * Run lifecycle-hook shell commands (postCreate / preRemove) with cwd = the
 * worktree. Best-effort: every command runs, individual failures (non-zero exit,
 * spawn error, timeout) are collected as warnings and never thrown — a failing
 * hook must not fail worktree creation or removal. Commands are full shell lines
 * (e.g. "pnpm install"), so we invoke the platform shell.
 */
async function runHooks(label: string, cwd: string, commands: string[]): Promise<string[]> {
  const warnings: string[] = []
  const [shell, shellArgs]: [string, string[]] =
    process.platform === 'win32' ? ['cmd', ['/c']] : ['sh', ['-c']]
  for (const cmd of commands) {
    if (!cmd.trim()) continue
    try {
      await execFileAsync(shell, [...shellArgs, cmd], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (err) {
      warnings.push(`${label} hook failed (${cmd}): ${(err as Error).message}`)
    }
  }
  return warnings
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new git worktree under `<projectRoot>/.worktrees/<branchName>`.
 *
 * Returns the absolute path and the actual branch name created. If the caller
 * supplied a `branchName` that already exists, the function will fail rather
 * than silently reusing it (so the caller can disambiguate with a fresh suffix).
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeCreateResult> {
  const { projectRoot, branchName, baseBranch, symlinkDirs = [] } = opts

  if (!existsSync(projectRoot)) {
    throw new Error(`projectRoot does not exist: ${projectRoot}`)
  }

  // Validate that projectRoot is a git repo. Fails fast with a clear message
  // rather than letting `git worktree` produce a confusing one.
  await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])

  const worktreesRoot = join(projectRoot, '.worktrees')
  if (!existsSync(worktreesRoot)) {
    mkdirSync(worktreesRoot, { recursive: true })
  }
  const worktreePath = join(worktreesRoot, branchName)

  if (existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}`)
  }

  // `git worktree add -b <branch> <path> [<base>]`
  // If baseBranch is omitted, git uses HEAD.
  const args = ['worktree', 'add', '-b', branchName, worktreePath]
  if (baseBranch && baseBranch.trim()) args.push(baseBranch.trim())
  await git(projectRoot, args)

  // Symlink shared dirs. Each failure becomes a warning rather than aborting
  // the whole create — a missing `node_modules` shouldn't prevent worktree
  // creation entirely.
  const warnings: string[] = []
  for (const name of symlinkDirs) {
    if (!isSafeSymlinkName(name)) {
      warnings.push(`skipped symlink with unsafe name: ${name}`)
      continue
    }
    const src = join(projectRoot, name)
    const dst = join(worktreePath, name)
    if (!existsSync(src)) {
      warnings.push(`symlink source not found: ${name}`)
      continue
    }
    if (existsSync(dst)) {
      warnings.push(`symlink destination already present (skipped): ${name}`)
      continue
    }
    let isDir = false
    try {
      isDir = statSync(src).isDirectory()
    } catch (err) {
      warnings.push(`stat failed for ${name}: ${(err as Error).message}`)
      continue
    }
    try {
      symlinkSync(src, dst, symlinkType(isDir))
    } catch (err) {
      warnings.push(`symlink failed for ${name}: ${(err as Error).message}`)
    }
  }

  // Drop a .git/info/exclude entry for our .claude/steps.json file so the
  // user doesn't see a phantom untracked file in their diff once the agent
  // starts writing steps. The worktree's own .git is a *file* pointer; the
  // info/exclude lives in the main repo's .git/worktrees/<id>/info/exclude
  // for per-worktree excludes — addToGitInfoExclude resolves the right path.
  addToGitInfoExclude(worktreePath, ['.claude/steps.json'])

  // Apply per-project `.gtrconfig`: copy declared untracked files (.env, local
  // configs) into the fresh worktree and run postCreate bootstrap hooks. Both
  // are best-effort — copy/hook failures surface as warnings, never aborting
  // creation (a missing .env or a failed `pnpm install` shouldn't orphan the
  // already-created worktree).
  const gtrConfig = loadGtrConfig(projectRoot)
  if (gtrConfig) {
    warnings.push(...copyGtrFiles(projectRoot, worktreePath, gtrConfig.copy))
    warnings.push(...await runHooks('postCreate', worktreePath, gtrConfig.postCreate))
  }

  return { worktreePath, branchName, warnings }
}

export interface RemoveWorktreeOpts {
  projectRoot:  string
  worktreePath: string
  branchName?:  string  // when provided, also tries to delete the branch with -D
}

export interface WorktreeRemoveResult {
  removed:        boolean
  branchDeleted:  boolean
  warnings:       string[]
}

/**
 * Remove a worktree with retry-on-busy. Windows-specific: PNPM, vite, jest,
 * antivirus, and explorer.exe routinely hold a handle open on `node_modules`
 * subdirs for a few hundred ms after the process exits — naive `rmSync` fails
 * with EBUSY. We retry the `git worktree remove` a few times, then fall back
 * to `git worktree prune` and try to delete the branch separately.
 */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<WorktreeRemoveResult> {
  const { projectRoot, worktreePath, branchName } = opts
  const warnings: string[] = []
  let removed = false

  // preRemove hooks run against the still-present worktree before git tears it
  // down (cwd = worktree). Best-effort: failures become warnings and never
  // block removal.
  if (existsSync(worktreePath)) {
    const gtrConfig = loadGtrConfig(projectRoot)
    if (gtrConfig && gtrConfig.preRemove.length > 0) {
      warnings.push(...await runHooks('preRemove', worktreePath, gtrConfig.preRemove))
    }
  }

  for (const delay of REMOVAL_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    const { stderr } = await git(
      projectRoot,
      ['worktree', 'remove', '--force', worktreePath],
      { allowFailure: true },
    )
    if (!existsSync(worktreePath)) {
      removed = true
      break
    }
    if (stderr) warnings.push(`worktree remove: ${stderr.trim()}`)
  }

  if (!removed) {
    // Last-ditch: prune lets git forget about the worktree even if the dir
    // is still on disk; the user can clean it up manually after rebooting.
    await git(projectRoot, ['worktree', 'prune'], { allowFailure: true })
    warnings.push(`worktree directory still present after retries: ${worktreePath}`)
  }

  let branchDeleted = false
  if (branchName) {
    const { stdout, stderr } = await git(
      projectRoot,
      ['branch', '-D', branchName],
      { allowFailure: true },
    )
    // git emits "Deleted branch <name> (was <sha>)." on stdout for success.
    if (/^Deleted branch/i.test(stdout.trim())) {
      branchDeleted = true
    } else if (stderr) {
      warnings.push(`branch delete: ${stderr.trim()}`)
    }
  }

  return { removed, branchDeleted, warnings }
}

// ─── Branch-name slugification ────────────────────────────────────────────────

/**
 * Slugify a free-form task name into a git-safe branch suffix. Mirrors the
 * parallel-code convention: lower-case, hyphen-separated, ASCII-only.
 */
export function slugifyBranchName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'task'
}

/** Short id suffix (~30 bits of entropy is plenty for per-session uniqueness). */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}
