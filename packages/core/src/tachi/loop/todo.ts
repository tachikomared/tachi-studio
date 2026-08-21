// packages/core/src/tachi/loop/todo.ts
//
// Pinned TODO ledger for the TACHI agent loop — the model's working plan as
// explicit, re-injected state. On long multi-step tasks a model loses the
// thread, skips sub-steps, and declares victory early; an always-fresh task list
// (Claude Code's TodoWrite, Cursor/Cline task lists) is the highest-leverage
// single anti-drift feature.
//
// The loop re-injects renderTodoLedger() into context every step (via
// streamText's prepareStep) so the plan survives HeadTail compaction — which
// drops middle turns, so a list emitted at step 3 would otherwise vanish by step
// 40. completion is gated on hasOpenTodos() so the agent can't declare done with
// work still pending.
//
// Pure: no electron, no node, no 'ai'. Plain data + string building.

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  content: string
  status: TodoStatus
}

/** Per-content char cap so one runaway item can't bloat the re-injected ledger. */
const MAX_ITEM_CHARS = 200
/** Cap on OPEN items rendered verbatim (closed items collapse to a count). */
const MAX_OPEN_RENDERED = 30

const OPEN: ReadonlySet<TodoStatus> = new Set<TodoStatus>(['pending', 'in_progress'])

/** True iff any item is still pending or in progress. */
export function hasOpenTodos(items: readonly TodoItem[]): boolean {
  return items.some(t => OPEN.has(t.status))
}

/** Count open (pending + in_progress) items. */
export function openTodoCount(items: readonly TodoItem[]): number {
  return items.filter(t => OPEN.has(t.status)).length
}

function clip(s: string): string {
  const t = s.trim()
  return t.length > MAX_ITEM_CHARS ? `${t.slice(0, MAX_ITEM_CHARS - 1)}…` : t
}

/** One-line human summary for the tool's return value (model-facing confirmation). */
export function summarizeTodos(items: readonly TodoItem[]): string {
  const c = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
  for (const t of items) c[t.status]++
  return `${c.in_progress} in progress, ${c.pending} pending, ${c.completed} done, ${c.cancelled} cancelled`
}

/**
 * Render the ledger as a compact reminder block for re-injection, or null when
 * there are no items (nothing to pin). In-progress first, then pending (the work
 * that still matters), each verbatim; completed/cancelled collapse to counts so
 * the block stays small as the task grows.
 */
export function renderTodoLedger(items: readonly TodoItem[]): string | null {
  if (items.length === 0) return null

  const inProgress = items.filter(t => t.status === 'in_progress')
  const pending = items.filter(t => t.status === 'pending')
  const doneCount = items.filter(t => t.status === 'completed').length
  const cancelledCount = items.filter(t => t.status === 'cancelled').length

  const lines: string[] = ['[TODO LIST — your working plan; keep it current with todo_write]']
  let rendered = 0
  for (const t of inProgress) {
    if (rendered++ >= MAX_OPEN_RENDERED) break
    lines.push(`[>] ${clip(t.content)}`)
  }
  for (const t of pending) {
    if (rendered++ >= MAX_OPEN_RENDERED) break
    lines.push(`[ ] ${clip(t.content)}`)
  }
  const openTotal = inProgress.length + pending.length
  if (openTotal > MAX_OPEN_RENDERED) lines.push(`…and ${openTotal - MAX_OPEN_RENDERED} more open item(s)`)
  if (doneCount > 0 || cancelledCount > 0) lines.push(`(${doneCount} completed, ${cancelledCount} cancelled)`)
  return lines.join('\n')
}
