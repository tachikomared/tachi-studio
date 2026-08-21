// apps/desktop/electron/services/sidecar-checkpoints.ts
//
// Sprint C3 — Stateless sidecar checkpointing (12-factor #12).
//
// Writes every agent turn to an append-only JSONL file keyed by sessionId.
// On sidecar restart the main process can replay the checkpoint to restore
// conversation context (see TODO(C3-replay) in sidecar-manager.ts for details
// on what the harness adapters still need to implement).
//
// File layout:
//   userData/
//     checkpoints/
//       <sessionId>.jsonl       ← active checkpoint, append-only
//       <sessionId>.jsonl.old   ← rotated when active file hits 10 MB cap

import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from 'fs'
import type { PlaybookTurn } from './playbook-service'

// ── Re-export the shared Turn type so callers can import from one place ────────
//
// C3 uses the same turn shape as playbook-service (role/content/name?/ts).
// We import and re-export rather than duplicate so any future schema change
// only needs to land in playbook-service.
export type { PlaybookTurn as CheckpointTurn } from './playbook-service'

// Convenience alias used inside this file.
type Turn = PlaybookTurn

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024  // 10 MB rotation cap

// ── Paths ─────────────────────────────────────────────────────────────────────

function checkpointsDir(): string {
  return join(app.getPath('userData'), 'checkpoints')
}

// Some harnesses return session tokens shaped `<connectionId>||<sessionId>` — the `|`
// characters are invalid in Windows filenames (causes ENOENT on open). Replace
// every Win32-illegal char with `_` so any session token round-trips safely.
// Trailing dots/spaces are also illegal on Windows so we trim those too.
function sanitizeSessionId(id: string): string {
  return id.replace(/[<>:"/\\|?*]+/g, '_').replace(/[.\s]+$/, '')
}

function checkpointPath(sessionId: string): string {
  return join(checkpointsDir(), `${sanitizeSessionId(sessionId)}.jsonl`)
}

function checkpointOldPath(sessionId: string): string {
  return join(checkpointsDir(), `${sanitizeSessionId(sessionId)}.jsonl.old`)
}

function ensureDir(): void {
  mkdirSync(checkpointsDir(), { recursive: true })
}

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * Append a single turn to <userData>/checkpoints/<sessionId>.jsonl.
 *
 * Rotation: if the file is at or above MAX_FILE_BYTES before the write,
 * the current file is renamed to <sessionId>.jsonl.old (replacing any prior
 * rotation) and a fresh file is started. This keeps individual files under
 * 10 MB while preserving at least the most-recent history segment.
 *
 * Non-fatal: all errors are logged with console.warn and swallowed so a disk
 * hiccup cannot break the agent loop.
 */
export function recordCheckpoint(sessionId: string, turn: Turn): void {
  try {
    ensureDir()
    const filePath = checkpointPath(sessionId)
    const line     = JSON.stringify(turn) + '\n'

    // Rotation check — rename to .old when file reaches or exceeds 10 MB.
    if (existsSync(filePath)) {
      const { size } = statSync(filePath)
      if (size >= MAX_FILE_BYTES) {
        renameSync(filePath, checkpointOldPath(sessionId))
      }
    }

    // appendFileSync is sufficient here — writes are small and infrequent.
    // (playbook-service uses fsync-on-fd for durability; we accept the marginal
    // loss-on-crash risk to keep the hot path simple for C3.)
    appendFileSync(filePath, line, 'utf-8')
  } catch (err) {
    console.warn('[checkpoint] recordCheckpoint failed (non-fatal):', err)
  }
}

// ── Read path ─────────────────────────────────────────────────────────────────

/**
 * Load all turns from <userData>/checkpoints/<sessionId>.jsonl.
 *
 * Lines that are not valid JSON or do not conform to the Turn shape are
 * silently skipped with a console.warn. Returns an empty array when the
 * file does not exist.
 *
 * Note: only the active file is read. If the file was rotated (a .old exists),
 * that history is NOT included here — the goal is to replay the most-recent
 * segment to a freshly-started sidecar, not to replay the entire lifetime.
 */
export function loadCheckpoint(sessionId: string): Turn[] {
  try {
    const filePath = checkpointPath(sessionId)
    if (!existsSync(filePath)) return []

    const raw   = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const turns: Turn[] = []

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'role'    in parsed &&
          'content' in parsed &&
          'ts'      in parsed
        ) {
          turns.push(parsed as Turn)
        } else {
          console.warn('[checkpoint] loadCheckpoint: skipping malformed line (missing fields):', line.slice(0, 120))
        }
      } catch {
        console.warn('[checkpoint] loadCheckpoint: skipping invalid JSON line:', line.slice(0, 120))
      }
    }

    return turns
  } catch (err) {
    console.warn('[checkpoint] loadCheckpoint failed:', err)
    return []
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export interface CheckpointMeta {
  sessionId:  string
  sizeBytes:  number
  updatedAt:  string
}

/**
 * List all checkpoint files in <userData>/checkpoints/.
 * Returns metadata for each .jsonl file (not .jsonl.old rotation files).
 */
export function listCheckpoints(): CheckpointMeta[] {
  try {
    ensureDir()
    const dir = checkpointsDir()
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && !f.endsWith('.jsonl.old'))
      .map(f => {
        const filePath  = join(dir, f)
        const st        = statSync(filePath)
        const sessionId = f.replace(/\.jsonl$/, '')
        return {
          sessionId,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))  // newest first
  } catch {
    return []
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete the checkpoint (and its .old rotation, if any) for a sessionId.
 * Returns true if at least one file was deleted, false if none existed.
 */
export function deleteCheckpoint(sessionId: string): boolean {
  let deleted = false
  try {
    const active = checkpointPath(sessionId)
    if (existsSync(active)) {
      unlinkSync(active)
      deleted = true
    }
    const old = checkpointOldPath(sessionId)
    if (existsSync(old)) {
      unlinkSync(old)
      deleted = true
    }
  } catch (err) {
    console.warn('[checkpoint] deleteCheckpoint failed:', err)
  }
  return deleted
}
