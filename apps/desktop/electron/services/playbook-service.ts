// apps/desktop/electron/services/playbook-service.ts
//
// Context-window management via playbooks.
// - Records every agent turn to a JSONL trace file (crash-safe, fsync on each write).
// - On session end, calls the Curator service to compress the trace into a playbook.md.
// - Playbooks are keyed by sha256(workspacePath.toLowerCase()).slice(0,16).
// - Future sessions pre-load the playbook as a system-prompt prefix via loadPlaybook().

import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  fsyncSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs'
import { curate, fallbackPlaybook, markdownToBlocks } from './curator-service'

// ─── Block-tree schema (Sprint D3) ───────────────────────────────────────────

export type Block =
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'bullet';  text: string; children?: Block[] }
  | { type: 'text';    text: string }
  | { type: 'code';    lang?: string; text: string }

// ─── Playbook entry types ─────────────────────────────────────────────────────

export type Task = {
  id:           string
  description:  string
  dependencies: string[]
  status:       'pending' | 'in-progress' | 'done'
}

export type Phase = {
  name:   string
  status: 'pending' | 'in-progress' | 'done'
  tasks:  Task[]
}

export type PlaybookEntry =
  | { type: 'summary';  ts: number; blocks: Block[]; sourceRunIds: string[] }
  | { type: 'handoff';  ts: number; blocks: Block[]; reason: 'red-zone' | 'session-end' | 'sidecar-restart'; agentSlug: string }
  | { type: 'state';    ts: number; goal: string; phases: Phase[]; blockers: string[]; decisions: string[]; criticalPath: string[] }
  | { type: 'retro';    ts: number; planned: Block[]; actual: Block[]; missing: Block[]; notable: Block[] }

// ─── Legacy turn type (still used by recordTurn) ──────────────────────────────

export interface PlaybookTurn {
  role:      'user' | 'assistant' | 'tool-call' | 'tool-result'
  content:   string
  name?:     string   // tool name for tool-call / tool-result
  ts:        number   // epoch ms
}

export interface PlaybookMeta {
  workspaceHash: string
  workspacePath: string
  updatedAt:     string
  sizeBytes:     number
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function playbooksDir(): string {
  return join(app.getPath('userData'), 'playbooks')
}

function runsDir(): string {
  return join(playbooksDir(), 'runs')
}

function ensureDirs(): void {
  mkdirSync(playbooksDir(), { recursive: true })
  mkdirSync(runsDir(),      { recursive: true })
}

// runIds can embed a harness session token shaped `<connId>||<sessionId>` (darksol
// still does). The
// `|` is invalid in Windows filenames (causes ENOENT on open). Replace every
// Win32-illegal char with `_` so any token round-trips safely. Trailing dots
// and spaces are also illegal on Windows, trim those too.
function sanitizeFileSegment(s: string): string {
  return s.replace(/[<>:"/\\|?*]+/g, '_').replace(/[.\s]+$/, '')
}

// ─── Workspace hash ───────────────────────────────────────────────────────────

export function workspaceHash(workspacePath: string): string {
  return createHash('sha256')
    .update(workspacePath.toLowerCase())
    .digest('hex')
    .slice(0, 16)
}

// ─── JSONL trace writer ───────────────────────────────────────────────────────

/**
 * Append a single turn to <userData>/playbooks/runs/<runId>.jsonl.
 * Crash-safe: we open the file in append mode, write one line, then fsync.
 */
export function recordTurn(runId: string, turn: PlaybookTurn): void {
  try {
    ensureDirs()
    const filePath = join(runsDir(), `${sanitizeFileSegment(runId)}.jsonl`)
    const line = JSON.stringify(turn) + '\n'

    // Use low-level fd so we can fsync immediately after write.
    const fd = openSync(filePath, 'a')
    try {
      appendFileSync(filePath, line, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    console.warn('[playbook] recordTurn failed (non-fatal):', err)
  }
}

// ─── Session end / curation ───────────────────────────────────────────────────

/**
 * Called when an agent session ends.
 * Reads the JSONL trace, sends it to the Curator, saves the resulting
 * playbook to <userData>/playbooks/<hash>.md.
 * Non-fatal: all errors are logged and the session continues normally.
 */
export async function endSession(runId: string, workspacePath: string): Promise<void> {
  try {
    ensureDirs()
    const tracePath = join(runsDir(), `${sanitizeFileSegment(runId)}.jsonl`)
    if (!existsSync(tracePath)) {
      console.warn(`[playbook] endSession: no trace found at ${tracePath}`)
      return
    }

    const jsonl = readFileSync(tracePath, 'utf-8').trim()
    if (!jsonl) {
      console.warn('[playbook] endSession: trace is empty, skipping curation')
      return
    }

    // Prefer the LLM curator; if no LLM backend is available, fall back to a
    // no-LLM summary built straight from the trace so cross-session memory still
    // works (read back next session via loadPlaybook).
    let playbook = await curate(jsonl)
    if (!playbook) {
      playbook = fallbackPlaybook(jsonl)
      if (playbook) console.log('[playbook] endSession: curator unavailable, wrote no-LLM fallback summary')
    }
    if (!playbook) {
      console.warn('[playbook] endSession: curator returned null and trace yielded no fallback, skipping')
      return
    }

    const hash = workspaceHash(workspacePath)
    const dest = join(playbooksDir(), `${hash}.md`)
    writeFileSync(dest, playbook, 'utf-8')
    console.log(`[playbook] saved playbook for workspace hash ${hash} -> ${dest}`)
  } catch (err) {
    console.warn('[playbook] endSession failed (non-fatal):', err)
  }
}

// ─── Structured entry JSONL ───────────────────────────────────────────────────

/**
 * Path to the structured playbook JSONL for a workspace hash.
 * Separate from the legacy .md file — append-only, one JSON object per line.
 */
function entriesPath(hash: string): string {
  return join(playbooksDir(), `${hash}.entries.jsonl`)
}

/**
 * Append a PlaybookEntry to the workspace's structured JSONL.
 * Non-fatal; all errors are logged.
 */
function appendEntry(hash: string, entry: PlaybookEntry): void {
  try {
    ensureDirs()
    const filePath = entriesPath(hash)
    const line = JSON.stringify(entry) + '\n'
    const fd = openSync(filePath, 'a')
    try {
      appendFileSync(filePath, line, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    console.warn('[playbook] appendEntry failed (non-fatal):', err)
  }
}

/**
 * Load all PlaybookEntry objects for a workspace path.
 * Backward-compat: lines that cannot be parsed are silently skipped.
 */
export function loadEntries(workspacePath: string): PlaybookEntry[] {
  try {
    const hash = workspaceHash(workspacePath)
    const filePath = entriesPath(hash)
    if (!existsSync(filePath)) return []
    const raw = readFileSync(filePath, 'utf-8').trim()
    if (!raw) return []
    return raw.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as PlaybookEntry]
      } catch {
        return []
      }
    })
  } catch (err) {
    console.warn('[playbook] loadEntries failed:', err)
    return []
  }
}

// ─── Curator emit functions (Sprint D3) ───────────────────────────────────────

/**
 * Emit a structured `summary` entry for the given run.
 * Converts the curator's markdown output into a Block[] for the renderer.
 * Falls back to a single `text` block if conversion fails.
 */
export async function emitSummary(runId: string, workspacePath: string): Promise<void> {
  try {
    ensureDirs()
    const tracePath = join(runsDir(), `${sanitizeFileSegment(runId)}.jsonl`)
    if (!existsSync(tracePath)) return
    const jsonl = readFileSync(tracePath, 'utf-8').trim()
    if (!jsonl) return

    const markdown = await curate(jsonl)
    if (!markdown) return

    const blocks = markdownToBlocks(markdown)
    const hash = workspaceHash(workspacePath)
    const entry: PlaybookEntry = {
      type:         'summary',
      ts:           Date.now(),
      blocks,
      sourceRunIds: [runId],
    }
    appendEntry(hash, entry)
  } catch (err) {
    console.warn('[playbook] emitSummary failed (non-fatal):', err)
  }
}

/**
 * Emit a `handoff` entry when the agent is being handed off to another session.
 * Called by D4 (Red Zone monitor) and on session-end / sidecar-restart.
 *
 * TODO(D4): Wire this into the red-zone trigger in tool-loop.ts when context
 * usage exceeds the red-zone threshold.
 */
export function emitHandoff(
  workspacePath: string,
  reason: 'red-zone' | 'session-end' | 'sidecar-restart',
  agentSlug: string,
): void {
  try {
    const hash = workspaceHash(workspacePath)
    const blocks: Block[] = [
      { type: 'heading', level: 1, text: `Handoff: ${reason}` },
      { type: 'text',    text: `Agent: ${agentSlug}` },
      { type: 'text',    text: `Reason: ${reason}` },
    ]
    const entry: PlaybookEntry = {
      type:      'handoff',
      ts:        Date.now(),
      blocks,
      reason,
      agentSlug,
    }
    appendEntry(hash, entry)
  } catch (err) {
    console.warn('[playbook] emitHandoff failed (non-fatal):', err)
  }
}

/**
 * Emit a `state` snapshot for the current session.
 * Heuristically extracts goal/blockers/decisions from recent assistant messages.
 * Prefers empty arrays over hallucinated content.
 *
 * Called every N turns (default N=5) from the agent turn loop.
 */
export function emitState(workspacePath: string, recentTurns: PlaybookTurn[]): void {
  try {
    const hash = workspaceHash(workspacePath)

    // Extract goal from the first user message (simple heuristic)
    const firstUser = recentTurns.find(t => t.role === 'user')
    const goal = firstUser ? firstUser.content.slice(0, 200) : ''

    // Extract blockers: assistant messages that contain "blocked", "error", "fail"
    const blockerPattern = /\b(blocked|error|fail|cannot|unable)\b/i
    const blockers: string[] = recentTurns
      .filter(t => t.role === 'assistant' && blockerPattern.test(t.content))
      .map(t => t.content.slice(0, 120))
      .slice(0, 3)

    // Extract decisions: assistant messages that contain "decided", "chose", "will use"
    const decisionPattern = /\b(decided|chose|choosing|will use|going with)\b/i
    const decisions: string[] = recentTurns
      .filter(t => t.role === 'assistant' && decisionPattern.test(t.content))
      .map(t => t.content.slice(0, 120))
      .slice(0, 3)

    const entry: PlaybookEntry = {
      type:         'state',
      ts:           Date.now(),
      goal,
      phases:       [],         // populated by higher-level plan-mode in Sprint F
      blockers,
      decisions,
      criticalPath: [],
    }
    appendEntry(hash, entry)
  } catch (err) {
    console.warn('[playbook] emitState failed (non-fatal):', err)
  }
}

// ── PlanArtifact shape (Sprint F) ─────────────────────────────────────────────
//
// Inline type mirror of the canonical PlanArtifact from
//   apps/desktop/src/types/slash-commands.ts
// (which itself re-exports `SlashCommand` from packages/core/src/agent/types.ts).
//
// Electron services live outside the renderer tsconfig and cannot import from
// src/ at runtime; this local mirror is intentionally thin — only the fields
// emitRetro reads (goal / phases / risks / criticalPath / phases[].tasks[].
// toolHints). The two definitions are structurally compatible — TS structural
// typing makes call sites that pass the canonical PlanArtifact safe.
//
// If you add a field to the canonical type, update this mirror only when
// emitRetro starts consuming the new field. Otherwise leave it lean.
interface PlanArtifactPhaseTask {
  id:          string
  description: string
  status:      'pending' | 'in-progress' | 'done'
  /** Tools the agent planned to use (Read, Edit, Bash, …). */
  toolHints:   string[]
}

interface PlanArtifactPhase {
  id:        string
  name:      string
  status:    'pending' | 'in-progress' | 'done'
  dependsOn: string[]
  tasks:     PlanArtifactPhaseTask[]
}

interface PlanArtifactShape {
  command:      'plan'
  goal:         string
  phases:       PlanArtifactPhase[]
  risks:        string[]
  criticalPath: string[]
}

/**
 * Emit a `retro` entry on session-end when a `/plan` was approved.
 *
 * Sprint F4: Replaces the D3 stub. Diffs `plan.phases[].tasks[].toolHints`
 * against `actualToolCalls` (names collected from JSONL `tool-call` turns).
 *
 * Diff algorithm — **exact name match** (Open Question 4, Sprint F §8 resolved):
 * - planned tool IN actualToolCalls → `notable` (planned tool was used)
 * - planned tool NOT IN actualToolCalls → `missing` (agent skipped it)
 * - actualToolCall NOT IN any task's toolHints → `notable` (unplanned tool use)
 * Exact-name matching is chosen for simplicity; semantic grouping (Edit ≈ Write)
 * would require a category map that could silently hide missed tool calls.
 *
 * @param workspacePath - Absolute path used to derive the workspace hash.
 * @param plan          - The approved PlanArtifact emitted by the agent.
 * @param runId         - Run ID used to locate the JSONL trace for actual tool calls.
 */
export async function emitRetro(
  workspacePath: string,
  plan: PlanArtifactShape,
  runId: string,
): Promise<void> {
  try {
    // Collect actual tool-call names from the JSONL trace.
    const tracePath = join(runsDir(), `${sanitizeFileSegment(runId)}.jsonl`)
    let actualToolCalls: string[] = []
    if (existsSync(tracePath)) {
      const raw = readFileSync(tracePath, 'utf-8').trim()
      if (raw) {
        actualToolCalls = raw.split('\n').flatMap(line => {
          try {
            const turn = JSON.parse(line) as { role?: string; name?: string }
            if (turn.role === 'tool-call' && turn.name) return [turn.name]
            return []
          } catch {
            return []
          }
        })
      }
    }

    // Collect all planned tool hints (flat list, de-duped).
    const allPlannedTools = new Set<string>()
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        for (const hint of task.toolHints) {
          allPlannedTools.add(hint)
        }
      }
    }

    const actualSet = new Set(actualToolCalls)

    // planned tools: build Block[] for `planned`
    const plannedBlocks: Block[] = [
      { type: 'heading', level: 2, text: `Plan: ${plan.goal}` },
      ...Array.from(allPlannedTools).map(t => ({
        type: 'bullet' as const,
        text: `planned \`${t}\``,
      })),
    ]

    // actual tool calls: build Block[] for `actual`
    const actualBlocks: Block[] = actualToolCalls.map(t => ({
      type: 'bullet' as const,
      text: `actual \`${t}\``,
    }))

    // missing: planned tools that were NOT in actual calls
    const missingBlocks: Block[] = Array.from(allPlannedTools)
      .filter(t => !actualSet.has(t))
      .map(t => ({ type: 'bullet' as const, text: `missing \`${t}\` (planned, not used)` }))

    // notable: planned tools that WERE used + unplanned tools that were used
    const notableBlocks: Block[] = [
      // planned tools that appeared in actuals
      ...Array.from(allPlannedTools)
        .filter(t => actualSet.has(t))
        .map(t => ({ type: 'bullet' as const, text: `planned \`${t}\` used` })),
      // unplanned tools (in actuals but not in any toolHints)
      ...actualToolCalls
        .filter(t => !allPlannedTools.has(t))
        // De-dup unplanned tools: only report each name once
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .map(t => ({ type: 'bullet' as const, text: `unplanned \`${t}\` used` })),
    ]

    const hash = workspaceHash(workspacePath)
    const entry: PlaybookEntry = {
      type:    'retro',
      ts:      Date.now(),
      planned: plannedBlocks,
      actual:  actualBlocks,
      missing: missingBlocks,
      notable: notableBlocks,
    }
    appendEntry(hash, entry)
    console.log(`[playbook] emitRetro: ${missingBlocks.length} missing, ${notableBlocks.length} notable`)
  } catch (err) {
    console.warn('[playbook] emitRetro failed (non-fatal):', err)
  }
}

// ─── Playbook pre-loader ──────────────────────────────────────────────────────

/**
 * Load the playbook for a workspace path.
 * Returns the markdown content, or null if none exists.
 */
export function loadPlaybook(workspacePath: string): string | null {
  try {
    const hash = workspaceHash(workspacePath)
    const dest = join(playbooksDir(), `${hash}.md`)
    if (!existsSync(dest)) return null
    return readFileSync(dest, 'utf-8')
  } catch (err) {
    console.warn('[playbook] loadPlaybook failed:', err)
    return null
  }
}

// ─── List / delete ────────────────────────────────────────────────────────────

/**
 * List all saved playbooks.
 */
export function listPlaybooks(): PlaybookMeta[] {
  try {
    ensureDirs()
    const dir = playbooksDir()
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(dir, f)
        const st = statSync(filePath)
        const hash = f.replace(/\.md$/, '')
        // We can't reverse the hash to a path, so surface what we have.
        return {
          workspaceHash: hash,
          workspacePath: '',       // not stored — would need a separate index
          updatedAt:     st.mtime.toISOString(),
          sizeBytes:     st.size,
        }
      })
  } catch {
    return []
  }
}

/**
 * Delete the playbook for a workspace path.
 */
export function deletePlaybook(workspacePath: string): boolean {
  try {
    const hash = workspaceHash(workspacePath)
    const dest = join(playbooksDir(), `${hash}.md`)
    if (!existsSync(dest)) return false
    unlinkSync(dest)
    return true
  } catch (err) {
    console.warn('[playbook] deletePlaybook failed:', err)
    return false
  }
}
