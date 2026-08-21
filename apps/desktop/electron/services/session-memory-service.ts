// apps/desktop/electron/services/session-memory-service.ts
//
// agent-session-memory — Session memory between agent runs (ECC pattern).
//
// Persists a short, human-readable session summary keyed by the project /
// workspace PATH. On the next agent start for the same path, the most recent
// summary can be loaded and injected into the system prompt / context as
// HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. This gives the agent a
// thin thread of continuity ("last time we worked on X, decided Y, touched Z")
// without re-feeding entire transcripts.
//
// This is deliberately distinct from sidecar-checkpoints.ts:
//   - checkpoints are keyed by sessionId and store the FULL turn-by-turn JSONL
//     for in-process replay to a freshly-restarted sidecar.
//   - session-memory is keyed by WORKSPACE PATH and stores a single compact
//     summary object for cross-run human/agent context.
//
// File layout:
//   userData/
//     sessions/
//       <hash>.json     ← one summary per workspace path (overwritten on save)
//
// <hash> is a sha256 of the absolute workspace path (first 16 hex chars). This
// keeps filenames stable, collision-safe, and free of path separators / drive
// letters that are illegal in Win32 filenames.

import { app } from 'electron'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
} from 'fs'
// Reflexion recall: TachiDesk has NO embedder, so similarity is the lexical
// (embedder-free) scorer in @tachi/core — the SAME one the playbook read-back
// in agent.ipc.ts already uses to rank prior-session notes against the task.
import { recall } from '@tachi/core'

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A compact, persisted summary of one agent session for a workspace.
 * Written on agent stop; read on agent start.
 */
export interface SessionSummary {
  /** Absolute workspace / project path this summary belongs to. */
  workspacePath: string
  /** One- or two-sentence description of the last task worked on. */
  lastTask: string
  /** Key decisions made during the session (architecture, trade-offs, etc.). */
  keyDecisions: string[]
  /** Files created / edited during the session (workspace-relative or absolute). */
  filesChanged: string[]
  /** ISO-8601 timestamp of when this summary was written. */
  timestamp: string
  /** Optional free-form notes the harness or user wants carried forward. */
  notes?: string
}

/** Input shape accepted by saveSummary — timestamp is stamped server-side. */
export interface SaveSummaryInput {
  workspacePath: string
  lastTask: string
  keyDecisions?: string[]
  filesChanged?: string[]
  notes?: string
}

// ── Paths ───────────────────────────────────────────────────────────────────

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

/**
 * Hash a workspace path into a stable, filesystem-safe filename stem.
 * Normalises separators + case (case-insensitive on Windows / macOS) so the
 * same logical workspace always maps to the same file regardless of how the
 * path was typed.
 */
function hashWorkspacePath(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function summaryPath(workspacePath: string): string {
  return join(sessionsDir(), `${hashWorkspacePath(workspacePath)}.json`)
}

function ensureDir(): void {
  mkdirSync(sessionsDir(), { recursive: true })
}

// ── Validation helper ─────────────────────────────────────────────────────────

/** Narrow an unknown parsed JSON blob to a SessionSummary, or null if malformed. */
function asSummary(parsed: unknown): SessionSummary | null {
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'workspacePath' in parsed &&
    'lastTask'      in parsed &&
    'timestamp'     in parsed
  ) {
    const p = parsed as Partial<SessionSummary>
    return {
      workspacePath: String(p.workspacePath ?? ''),
      lastTask:      String(p.lastTask ?? ''),
      keyDecisions:  Array.isArray(p.keyDecisions) ? p.keyDecisions.map(String) : [],
      filesChanged:  Array.isArray(p.filesChanged) ? p.filesChanged.map(String) : [],
      timestamp:     String(p.timestamp ?? ''),
      notes:         typeof p.notes === 'string' ? p.notes : undefined,
    }
  }
  return null
}

// ── Write path ──────────────────────────────────────────────────────────────

/**
 * Persist (overwrite) the session summary for a workspace path.
 *
 * Called on agent stop. The timestamp is always stamped here so callers cannot
 * forge a stale/future time. Returns the written SessionSummary.
 *
 * Non-fatal: any disk error is logged and re-thrown to the router layer, which
 * wraps it into a HANDLER_ERROR envelope rather than crashing the main process.
 */
export function saveSummary(input: SaveSummaryInput): SessionSummary {
  ensureDir()
  const summary: SessionSummary = {
    workspacePath: input.workspacePath,
    lastTask:      input.lastTask,
    keyDecisions:  input.keyDecisions ?? [],
    filesChanged:  input.filesChanged ?? [],
    timestamp:     new Date().toISOString(),
    notes:         input.notes,
  }
  writeFileSync(summaryPath(input.workspacePath), JSON.stringify(summary, null, 2), 'utf-8')
  return summary
}

// ── Read path ───────────────────────────────────────────────────────────────

/**
 * Load the most recent session summary for a workspace path.
 * Returns null when no summary exists or the file is malformed.
 */
export function loadSummary(workspacePath: string): SessionSummary | null {
  try {
    const filePath = summaryPath(workspacePath)
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return asSummary(JSON.parse(raw) as unknown)
  } catch (err) {
    console.warn('[session-memory] loadSummary failed (non-fatal):', err)
    return null
  }
}

/**
 * Render a SessionSummary into a context block suitable for prepending to a
 * system prompt on agent start. Clearly framed as HISTORICAL REFERENCE so the
 * model does not treat stale decisions as live instructions.
 *
 * Returns an empty string when there is nothing to inject, so callers can do:
 *   const prefix = buildHistoricalContext(loadSummary(dir))
 *   systemPrompt = prefix + systemPrompt
 */
export function buildHistoricalContext(summary: SessionSummary | null): string {
  if (!summary) return ''
  const lines: string[] = []
  lines.push('=== HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS ===')
  lines.push('The following summarises a PRIOR agent session in this workspace.')
  lines.push('Use it only as background context. It is NOT a task list and may be stale.')
  lines.push('')
  lines.push(`Last session: ${summary.timestamp}`)
  lines.push(`Last task: ${summary.lastTask}`)
  if (summary.keyDecisions.length > 0) {
    lines.push('Key decisions:')
    for (const d of summary.keyDecisions) lines.push(`  - ${d}`)
  }
  if (summary.filesChanged.length > 0) {
    lines.push('Files changed last time:')
    for (const f of summary.filesChanged.slice(0, 40)) lines.push(`  - ${f}`)
  }
  if (summary.notes) {
    lines.push(`Notes: ${summary.notes}`)
  }
  lines.push('=== END HISTORICAL REFERENCE ===')
  return lines.join('\n')
}

// ── Listing / management ──────────────────────────────────────────────────────

export interface SessionSummaryMeta {
  workspacePath: string
  lastTask:      string
  timestamp:     string
}

/**
 * List all persisted session summaries, newest first.
 * Malformed files are skipped silently.
 */
export function listSummaries(): SessionSummaryMeta[] {
  try {
    ensureDir()
    const dir = sessionsDir()
    const metas: SessionSummaryMeta[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const summary = asSummary(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as unknown)
        if (summary) {
          metas.push({
            workspacePath: summary.workspacePath,
            lastTask:      summary.lastTask,
            timestamp:     summary.timestamp,
          })
        }
      } catch { /* skip malformed file */ }
    }
    return metas.sort((a, b) => b.timestamp.localeCompare(a.timestamp))  // newest first
  } catch {
    return []
  }
}

/**
 * Delete the persisted summary for a workspace path.
 * Returns true if a file was removed, false if none existed.
 */
export function deleteSummary(workspacePath: string): boolean {
  try {
    const filePath = summaryPath(workspacePath)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      return true
    }
  } catch (err) {
    console.warn('[session-memory] deleteSummary failed (non-fatal):', err)
  }
  return false
}

// ── Reflexion: structured failure memory ────────────────────────────────────
//
// STEAL: all-agentic-architectures/architectures/reflexion.py — after a
// failed/partial run, extract a structured (root_cause, correction, lesson)
// reflection and store it in episodic memory keyed to the task; on a future
// SIMILAR task, recall the top-k reflections and prepend them as a prior.
//
// That source uses a FAISS vector store for "similar". TachiDesk has no
// embedder, so this port uses the lexical recall scorer in @tachi/core over the
// reflection's (task + lesson) text — the same embedder-free similarity the
// playbook read-back already relies on. Reflections live in their OWN JSONL
// file (separate from the per-workspace SessionSummary store above) because
// they are GLOBAL across workspaces: a lesson learned fixing a vitest mock in
// one repo is worth recalling on a structurally-similar task anywhere.
//
// File layout:
//   userData/
//     reflections.jsonl   ← one Reflection per line, append-only
//
// The class is electron-free (path + clock injected) so vitest can drive it;
// getReflectionStore() is the electron-coupled singleton (lazy require,
// mirroring getCostLedger() in cost-ledger.ts).

/** One stored verbal reflection — the actionable triple plus its task key. */
export interface Reflection {
  /** The task text this reflection was learned on (the recall key). */
  task: string
  /** ONE sentence: precisely why the previous attempt failed. */
  rootCause: string
  /** ONE sentence, imperative: the concrete change to make next time. */
  correction: string
  /** The transferable lesson, recalled verbatim on a similar future task. */
  lesson: string
  /** Epoch ms the reflection was recorded. */
  ts: number
}

/** Input to addReflection — ts is stamped from the clock when omitted. */
export interface AddReflectionInput {
  task: string
  rootCause: string
  correction: string
  lesson: string
  ts?: number
}

/**
 * Render a recalled list of reflections into a compact context block suitable
 * for prepending to the agent system prompt. Empty string when the list is
 * empty, so callers can safely string-concat the result.
 *
 * Pure / electron-free so the renderer-side prompt assembly and tests can use
 * it directly. The block is framed as PRIOR-ATTEMPT lessons (not live
 * instructions), mirroring buildHistoricalContext above.
 */
export function buildReflexionContext(recalled: Reflection[], _task?: string): string {
  if (recalled.length === 0) return ''
  const lines: string[] = []
  lines.push('Lessons from similar past attempts (recalled from your reflection memory):')
  lines.push('These are mistakes you (or a prior run) made on structurally-similar tasks')
  lines.push('and the corrections committed to. Apply them now; do not repeat them.')
  for (const r of recalled) {
    // lesson is the load-bearing, transferable text; correction is the concrete
    // imperative. root_cause is omitted from the prompt to keep the block tight
    // (it is still persisted for debugging).
    lines.push(`- ${r.lesson}${r.correction ? ` (do: ${r.correction})` : ''}`)
  }
  return lines.join('\n')
}

const REFLECTION_MAX = 2000

export class ReflectionStore {
  private reflections: Reflection[] = []
  private loaded = false

  constructor(
    private filePath: string,
    private now: () => number = Date.now,
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as Partial<Reflection>
          if (typeof r.task === 'string' && typeof r.lesson === 'string') {
            this.reflections.push({
              task: r.task,
              rootCause: typeof r.rootCause === 'string' ? r.rootCause : '',
              correction: typeof r.correction === 'string' ? r.correction : '',
              lesson: r.lesson,
              ts: typeof r.ts === 'number' ? r.ts : 0,
            })
          }
        } catch { /* skip one corrupt line, keep the rest */ }
      }
    } catch { /* unreadable file = start empty in memory; appends still work */ }
  }

  /** Record one reflection (append-only). Persistence is best-effort. */
  addReflection(input: AddReflectionInput): Reflection {
    this.load()
    const r: Reflection = {
      task: input.task,
      rootCause: input.rootCause,
      correction: input.correction,
      lesson: input.lesson,
      ts: input.ts ?? this.now(),
    }
    // Cap unbounded growth: keep the newest REFLECTION_MAX in memory.
    this.reflections.push(r)
    if (this.reflections.length > REFLECTION_MAX) {
      this.reflections = this.reflections.slice(-REFLECTION_MAX)
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, JSON.stringify(r) + '\n', 'utf8')
    } catch { /* persistence best-effort — in-memory recall still works this run */ }
    return r
  }

  /**
   * Recall the top-k reflections most relevant to `task` by lexical overlap
   * (@tachi/core recall) over each reflection's task + lesson text. Reflections
   * with zero overlap are dropped. Newest-first among equal-score is implicitly
   * handled by recall's stable sort over input order (we feed newest last, but
   * recall preserves input index for ties — close enough; relevance dominates).
   */
  recallReflections(task: string, k = 3): Reflection[] {
    this.load()
    if (this.reflections.length === 0) return []
    const kk = Math.max(0, k)
    if (kk === 0) return []
    // Build recall candidates: index-tagged so we can map scored text back to
    // the full Reflection object (recall returns only {text, score}).
    const candidates = this.reflections.map(r => ({ text: `${r.task}\n${r.lesson}` }))
    // Recall EXTRA so we still end up with kk DISTINCT lessons after deduping
    // near-identical ones — without this, the same lesson logged across many
    // failed runs can fill all kk slots, crowding out other useful lessons.
    const ranked = recall(task, candidates, { topK: kk * 4 })
    const out: Reflection[] = []
    const used = new Set<number>()
    const seen: string[] = []
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    for (const item of ranked) {
      if (out.length >= kk) break
      // Find the first unused reflection whose composite text matches.
      const idx = candidates.findIndex((c, i) => !used.has(i) && c.text === item.text)
      if (idx < 0) continue
      used.add(idx)
      // Drop a near-duplicate lesson (normalized exact, or one subsumes the other).
      const lessonNorm = norm(this.reflections[idx]!.lesson)
      if (lessonNorm && seen.some(s => s === lessonNorm || s.includes(lessonNorm) || lessonNorm.includes(s))) continue
      seen.push(lessonNorm)
      out.push(this.reflections[idx]!)
    }
    return out
  }

  /**
   * Recall + render in one call — the shape the prompt builder wants.
   * Empty string when no stored reflection overlaps `task`.
   */
  buildReflexionContext(task: string, k = 3): string {
    return buildReflexionContext(this.recallReflections(task, k), task)
  }
}

let reflectionSingleton: ReflectionStore | null = null

/** Electron-coupled accessor — lazy so vitest can import this module. */
export function getReflectionStore(): ReflectionStore {
  if (!reflectionSingleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron') as typeof import('electron')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join: joinPath } = require('node:path') as typeof import('node:path')
    reflectionSingleton = new ReflectionStore(
      joinPath(electronApp.getPath('userData'), 'reflections.jsonl'),
    )
  }
  return reflectionSingleton
}

/**
 * Module-level convenience for the NO-TOUCH consumers (agent.ipc.ts records a
 * reflection on a failed run; tachi/prompt.ts injects the context block). Both
 * go through the electron singleton so they share one on-disk store.
 */
export function addReflection(input: AddReflectionInput): Reflection {
  return getReflectionStore().addReflection(input)
}

export function recallReflections(task: string, k = 3): Reflection[] {
  return getReflectionStore().recallReflections(task, k)
}

/** Recall + render against the live store. Empty string when nothing overlaps. */
export function buildReflexionContextForTask(task: string, k = 3): string {
  return getReflectionStore().buildReflexionContext(task, k)
}
