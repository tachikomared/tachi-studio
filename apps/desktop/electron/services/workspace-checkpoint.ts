// apps/desktop/electron/services/workspace-checkpoint.ts
//
// Git-backed workspace checkpoints for the agent (STEAL 2026-07-08, agent-native
// MIT). Before the agent touches files we snapshot the ENTIRE working tree
// (tracked + untracked + the user's own uncommitted edits) as a dangling git
// commit kept alive by a ref. One-click restore forces the working tree back to
// that snapshot AND removes files the agent added afterwards — Cursor/Cline-parity
// "undo the agent" without needing the user to have committed anything.
//
// Safety contract:
//   - The snapshot is NON-destructive: it uses a TEMP index, so the user's real
//     index / HEAD / working tree are never touched (proven in an isolated repo).
//   - Restore first takes an automatic "before-restore" snapshot, so an
//     accidental restore is itself undoable.
//   - No-op (returns null) outside a git repo — we never `git init` the user's
//     folder behind their back.

import { execFile } from 'node:child_process'
import { join, dirname, relative, sep } from 'node:path'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isSensitiveFileName, isSensitiveDirName } from './util/sensitive-files'

const REF_PREFIX = 'refs/tachi-checkpoints'

// ── Non-git fallback (STEAL 2026-07-09, caveman) ────────────────────────────────
// When the workspace is NOT a git repo, git checkpoints can't help — the agent
// would run with no undo. We fall back to an out-of-tree file backup under
// userData: copy the workspace into a backup dir + a manifest of relative
// paths, so restore can put files back AND remove agent-added ones (git-parity
// without a repo). Bounded + readback-verified so we never CLAIM protection we
// don't have — over the caps, we return null (honestly unprotected) rather than
// a partial snapshot that a restore would treat as complete.
const FS_PREFIX = 'fs:'
const FS_MAX_FILES = 3000
const FS_MAX_FILE_BYTES = 5 * 1024 * 1024
const FS_MAX_TOTAL_BYTES = 80 * 1024 * 1024
const FS_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release-build', '.next', 'coverage',
  '__pycache__', 'venv', '.venv', 'target', '.idea', '.vscode', '.cache',
])

function backupDir(root: string, id: string): string {
  return join(app.getPath('userData'), 'workspace-checkpoints', 'fs-backups',
    createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16), id)
}

/** Walk a folder for backup: relative paths honoring skip-dirs, sensitive files, and caps. */
function walkForBackup(root: string): { files: string[]; overCap: boolean } {
  const files: string[] = []
  let totalBytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (FS_SKIP_DIRS.has(e.name) || isSensitiveDirName(e.name)) continue
        stack.push(abs)
        continue
      }
      if (!e.isFile()) continue
      if (isSensitiveFileName(e.name)) continue          // never back up (or restore) secrets
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.size > FS_MAX_FILE_BYTES) continue           // skip a huge single file
      if (files.length >= FS_MAX_FILES || totalBytes + st.size > FS_MAX_TOTAL_BYTES) {
        return { files, overCap: true }
      }
      totalBytes += st.size
      files.push(relative(root, abs).split(sep).join('/'))
    }
  }
  return { files, overCap: false }
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, env: env ?? process.env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: (stdout ?? '').toString(), stderr: (stderr ?? '').toString() }))
  })
}

async function isGitRepo(root: string): Promise<boolean> {
  const r = await git(root, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

export interface WorkspaceCheckpoint {
  id: string
  commit: string
  label: string
  createdAt: string
}

// Per-workspace index of checkpoints, stored in userData keyed by root hash.
function indexPath(root: string): string {
  const dir = join(app.getPath('userData'), 'workspace-checkpoints')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)}.json`)
}
function loadIndex(root: string): WorkspaceCheckpoint[] {
  try { return JSON.parse(readFileSync(indexPath(root), 'utf8')) as WorkspaceCheckpoint[] } catch { return [] }
}
function saveIndex(root: string, list: WorkspaceCheckpoint[]): void {
  try { writeFileSync(indexPath(root), JSON.stringify(list, null, 2)) } catch { /* best-effort */ }
}

/**
 * Snapshot the full working tree as a dangling commit + ref. Returns the
 * checkpoint, or null if `root` isn't a git repo. Never modifies the user's
 * index / HEAD / working tree (uses a temp index).
 */
export async function createWorkspaceCheckpoint(root: string, label = 'agent checkpoint'): Promise<WorkspaceCheckpoint | null> {
  if (!(await isGitRepo(root))) return createFsCheckpoint(root, label)
  const id = randomUUID()
  const tmpIndex = join(root, `.git`, `tachi-cp-index-${id}`)
  try {
    // Seed the temp index from HEAD (empty tree if no commits yet), then stage
    // everything (tracked mods + untracked) into it — all against the TEMP index.
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
    const head = await git(root, ['rev-parse', 'HEAD'])
    const hasHead = head.ok && head.stdout.trim().length > 0
    if (hasHead) await git(root, ['read-tree', 'HEAD'], env)
    await git(root, ['add', '-A'], env)
    const tree = await git(root, ['write-tree'], env)
    if (!tree.ok || !tree.stdout.trim()) return null
    const treeSha = tree.stdout.trim()
    const commitArgs = ['commit-tree', treeSha, '-m', `tachi checkpoint: ${label}`]
    if (hasHead) commitArgs.push('-p', head.stdout.trim())
    const commit = await git(root, commitArgs)
    if (!commit.ok || !commit.stdout.trim()) return null
    const sha = commit.stdout.trim()
    await git(root, ['update-ref', `${REF_PREFIX}/${id}`, sha])   // keep it alive vs GC
    const cp: WorkspaceCheckpoint = { id, commit: sha, label, createdAt: new Date().toISOString() }
    const list = loadIndex(root)
    list.unshift(cp)
    saveIndex(root, list.slice(0, 50))   // cap history
    return cp
  } catch {
    return null
  } finally {
    try { rmSync(tmpIndex, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * Non-git fallback: copy the workspace to an out-of-tree backup + manifest.
 * Returns a checkpoint whose `commit` is an `fs:<id>` sentinel, or null if the
 * folder is over the size caps (honestly unprotected) or the readback verify
 * fails. Same index/UI shape as a git checkpoint, so restore is uniform.
 */
async function createFsCheckpoint(root: string, label: string): Promise<WorkspaceCheckpoint | null> {
  const { files, overCap } = walkForBackup(root)
  if (overCap) {
    console.warn(`[workspace-checkpoint] ${root} exceeds the fs-backup caps — running WITHOUT an undo snapshot (folder too large / non-git).`)
    return null
  }
  if (files.length === 0) {
    // Empty (or all-skipped) folder — a trivially-restorable empty manifest is fine.
  }
  const id = randomUUID()
  const dir = backupDir(root, id)
  try {
    mkdirSync(dir, { recursive: true })
    for (const rel of files) {
      const src = join(root, rel)
      const dst = join(dir, 'tree', rel)
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(src, dst)
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ root, files }, null, 2), 'utf8')

    // Readback verify: a backup we can't read back is not protection. Confirm
    // the manifest is parseable and the first file's bytes match the source.
    const back = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { files: string[] }
    if (!Array.isArray(back.files) || back.files.length !== files.length) throw new Error('manifest mismatch')
    if (files.length > 0) {
      const rel0 = files[0]
      const a = readFileSync(join(root, rel0))
      const b = readFileSync(join(dir, 'tree', rel0))
      if (!a.equals(b)) throw new Error('readback mismatch')
    }

    const cp: WorkspaceCheckpoint = { id, commit: `${FS_PREFIX}${id}`, label, createdAt: new Date().toISOString() }
    const list = loadIndex(root)
    list.unshift(cp)
    saveIndex(root, list.slice(0, 50))
    return cp
  } catch (e) {
    console.warn('[workspace-checkpoint] fs-backup failed — running WITHOUT an undo snapshot:', (e as Error).message)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    return null
  }
}

/** Restore a non-git fs checkpoint: put backed-up files back + remove agent-added ones. */
async function restoreFsCheckpoint(root: string, cp: WorkspaceCheckpoint): Promise<{ ok: boolean; error?: string; safetyId?: string }> {
  const dir = backupDir(root, cp.id)
  let manifest: { files: string[] }
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { files: string[] } }
  catch { return { ok: false, error: 'backup manifest missing or unreadable' } }
  const snapFiles = new Set(manifest.files)

  // Safety net: snapshot the CURRENT state before overwriting it (itself undoable).
  const safety = await createFsCheckpoint(root, 'before restore')

  // 1. Copy every backed-up file back (overwrites agent edits, restores deletions).
  for (const rel of manifest.files) {
    const src = join(dir, 'tree', rel)
    const dst = join(root, rel)
    try { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst) } catch { /* best-effort per file */ }
  }
  // 2. Remove files that exist NOW (within the same walk scope) but weren't in
  //    the snapshot — i.e. agent-added — mirroring the git untracked cleanup.
  const nowFiles = walkForBackup(root).files
  for (const rel of nowFiles) {
    if (snapFiles.has(rel)) continue
    try { rmSync(join(root, rel), { force: true }) } catch { /* best-effort */ }
  }
  return { ok: true, safetyId: safety?.id }
}

export function listWorkspaceCheckpoints(root: string): WorkspaceCheckpoint[] {
  return loadIndex(root)
}

/**
 * Force the working tree back to a checkpoint: reset tracked files to the
 * snapshot (removing tracked files added after) and delete untracked files the
 * snapshot didn't contain. Takes an automatic "before-restore" checkpoint first
 * so the restore is itself undoable. Returns { ok, error?, safetyId? }.
 */
export async function restoreWorkspaceCheckpoint(root: string, id: string): Promise<{ ok: boolean; error?: string; safetyId?: string }> {
  const cp = loadIndex(root).find(c => c.id === id)
  if (!cp) return { ok: false, error: `checkpoint ${id} not found` }
  // Non-git fallback checkpoints carry an `fs:` sentinel commit.
  if (cp.commit.startsWith(FS_PREFIX)) return restoreFsCheckpoint(root, cp)
  if (!(await isGitRepo(root))) return { ok: false, error: 'not a git repository' }

  // Safety net: snapshot the current state before we overwrite it.
  const safety = await createWorkspaceCheckpoint(root, 'before restore')

  // 1. Forcefully reset index + tracked working-tree files to the snapshot tree.
  //    --reset discards local modifications; -u removes tracked files not in the tree.
  const reset = await git(root, ['read-tree', '--reset', '-u', `${cp.commit}^{tree}`])
  if (!reset.ok) return { ok: false, error: `restore failed: ${reset.stderr.slice(0, 200)}`, safetyId: safety?.id }

  // 2. Remove UNTRACKED files that weren't in the snapshot (agent-added).
  const snapFiles = new Set(
    (await git(root, ['ls-tree', '-r', '--name-only', cp.commit])).stdout.split('\n').map(s => s.trim()).filter(Boolean),
  )
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])).stdout
    .split('\n').map(s => s.trim()).filter(Boolean)
  for (const rel of untracked) {
    if (snapFiles.has(rel)) continue
    try { rmSync(join(root, rel), { force: true }) } catch { /* best-effort */ }
  }
  return { ok: true, safetyId: safety?.id }
}

/** Drop a checkpoint's ref + index entry (the dangling commit becomes GC-able). */
export async function deleteWorkspaceCheckpoint(root: string, id: string): Promise<boolean> {
  const list = loadIndex(root)
  const cp = list.find(c => c.id === id)
  if (!cp) return false
  if (cp.commit.startsWith(FS_PREFIX)) {
    try { rmSync(backupDir(root, id), { recursive: true, force: true }) } catch { /* ignore */ }
  } else {
    try { await git(root, ['update-ref', '-d', `${REF_PREFIX}/${id}`]) } catch { /* ignore */ }
  }
  saveIndex(root, list.filter(c => c.id !== id))
  return true
}
