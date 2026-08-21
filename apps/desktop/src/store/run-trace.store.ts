// apps/desktop/src/store/run-trace.store.ts
//
// LIGHTWEIGHT LOCAL RUN-TRACE STORE (OTel-flavored, zero external deps).
//
// A tiny Zustand store that records spans for an in-app trace timeline. It is
// intentionally framework-free: no langfuse, no @opentelemetry, no IPC. Other
// code (chat-service, agent-kit adapters, graph runner) can import this and
// call startSpan/endSpan to light up the Trace console tab without pulling in
// any heavy tracing SDK.
//
// A "span" is one timed unit of work — an LLM call, a tool invocation, an
// agent step, or a coarse phase. Spans nest via parentId, forming a tree we
// render as an indented brutalist timeline (selectSpanTree).
//
// In-memory only. Spans are ephemeral diagnostics; we never persist them and
// we cap the buffer so a long-running session can't grow unbounded.

import { create } from 'zustand'

/** What kind of work a span represents. Drives the bar color in the viewer. */
export type SpanKind = 'llm' | 'tool' | 'agent' | 'phase'

/** A single recorded span. Mirrors the shape requested in the feature spec. */
export interface Span {
  id: string
  name: string
  kind: SpanKind
  /** epoch ms when the span opened. */
  startedAt: number
  /** epoch ms when the span closed; undefined while still in-flight. */
  endedAt?: number
  /** id of the enclosing span, if any (root spans omit this). */
  parentId?: string
  /** free-form key/value metadata (model name, token counts, tool args, …). */
  attrs: Record<string, unknown>
}

/** A span plus its resolved children — the shape the viewer consumes. */
export interface SpanNode extends Span {
  children: SpanNode[]
  /** tree depth (root = 0); precomputed so the viewer stays dumb. */
  depth: number
}

/** Args accepted by startSpan. id is auto-generated when omitted. */
export interface StartSpanInput {
  id?: string
  name: string
  kind: SpanKind
  parentId?: string
  attrs?: Record<string, unknown>
  /** override the start time (defaults to Date.now()). */
  startedAt?: number
}

/** Hard cap on retained spans (oldest dropped first). Keeps memory bounded. */
const MAX_SPANS = 2000

let spanSeq = 0
function nextId(): string {
  spanSeq += 1
  return `span_${Date.now().toString(36)}_${spanSeq.toString(36)}`
}

interface RunTraceStore {
  /** All recorded spans in insertion order. */
  spans: Span[]

  /**
   * Open a new span. Returns its id so the caller can later endSpan(id) or
   * nest children under it. Never throws.
   */
  startSpan: (input: StartSpanInput) => string

  /**
   * Close a span by id, optionally merging extra attrs (e.g. final token
   * counts). No-op if the id is unknown or already ended. Never throws.
   */
  endSpan: (id: string, extraAttrs?: Record<string, unknown>) => void

  /** Drop every recorded span. */
  clear: () => void
}

export const useRunTraceStore = create<RunTraceStore>((set) => ({
  spans: [],

  startSpan(input) {
    const id = input.id ?? nextId()
    const span: Span = {
      id,
      name: input.name,
      kind: input.kind,
      startedAt: input.startedAt ?? Date.now(),
      parentId: input.parentId,
      attrs: input.attrs ?? {},
    }
    set((s) => {
      const next = [...s.spans, span]
      // Bound the buffer: drop oldest once over the cap.
      return { spans: next.length > MAX_SPANS ? next.slice(next.length - MAX_SPANS) : next }
    })
    return id
  },

  endSpan(id, extraAttrs) {
    set((s) => ({
      spans: s.spans.map((sp) =>
        sp.id === id && sp.endedAt === undefined
          ? { ...sp, endedAt: Date.now(), attrs: extraAttrs ? { ...sp.attrs, ...extraAttrs } : sp.attrs }
          : sp,
      ),
    }))
  },

  clear() {
    set({ spans: [] })
  },
}))

// ── Selectors / pure helpers ────────────────────────────────────────────────

/**
 * Build the span forest from a flat span list. Spans whose parentId points at
 * a missing span are treated as roots (defensive — a parent may have been
 * trimmed by the buffer cap). Children sort by start time; roots preserve
 * insertion order. Pure — safe to call inside a selector/useMemo.
 */
export function buildSpanTree(spans: Span[]): SpanNode[] {
  const byId = new Map<string, SpanNode>()
  for (const sp of spans) byId.set(sp.id, { ...sp, children: [], depth: 0 })

  const roots: SpanNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // Assign depth + sort children by start time (stable, recursive).
  const visit = (node: SpanNode, depth: number) => {
    node.depth = depth
    node.children.sort((a, b) => a.startedAt - b.startedAt)
    for (const c of node.children) visit(c, depth + 1)
  }
  for (const r of roots) visit(r, 0)

  return roots
}

/** Zustand selector: the span tree. Use with a shallow-safe consumer/useMemo. */
export const selectSpanTree = (s: RunTraceStore): SpanNode[] => buildSpanTree(s.spans)

/**
 * The overall trace window [min start, max end] in epoch ms across all spans.
 * In-flight spans count "now" as their end. Returns null when there are no
 * spans. Used to scale bars to a common timeline.
 */
export function traceBounds(spans: Span[], now = Date.now()): { start: number; end: number } | null {
  if (spans.length === 0) return null
  let start = Infinity
  let end = -Infinity
  for (const sp of spans) {
    if (sp.startedAt < start) start = sp.startedAt
    const e = sp.endedAt ?? now
    if (e > end) end = e
  }
  return { start, end }
}

/** Bar color CSS-var per kind. Matches the brutalist theme tokens. */
export const KIND_COLOR: Record<SpanKind, string> = {
  llm: 'var(--accent)',
  tool: 'var(--warning)',
  agent: 'var(--success)',
  phase: 'var(--text-muted)',
}

/** Human-readable duration. Open spans render as "…". */
export function formatDuration(span: Span, now = Date.now()): string {
  const end = span.endedAt ?? now
  const ms = Math.max(0, end - span.startedAt)
  if (span.endedAt === undefined) return `${fmtMs(ms)}…`
  return fmtMs(ms)
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
}

// ── Token / cost aggregation (Observability console tab) ──────────────────────

export interface RunTokenStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  toolCalls: number
  spanCount: number
}

/**
 * Aggregate token counts + tool-call count across a flat span list. Token data
 * is read from span.attrs.promptTokens / completionTokens when present (spans
 * carry it once the runner is extended to report it); tool calls are spans with
 * kind === 'tool'. Pure — safe to call inside a selector/useMemo.
 */
export function selectRunTokenStats(spans: Span[]): RunTokenStats {
  let promptTokens = 0, completionTokens = 0, toolCalls = 0
  for (const sp of spans) {
    promptTokens     += typeof sp.attrs.promptTokens     === 'number' ? sp.attrs.promptTokens     : 0
    completionTokens += typeof sp.attrs.completionTokens === 'number' ? sp.attrs.completionTokens : 0
    if (sp.kind === 'tool') toolCalls += 1
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, toolCalls, spanCount: spans.length }
}

// ── Per-tool success rates (Observability "TOOL SUCCESS" section) ─────────────
//
// success-rate = ratio of tool spans whose attrs.ok === true over the total
// tool spans for that tool name (idea ported from ColeMurray/claude-code-otel's
// dashboard: tool_result success=true / total, per tool name).
//
// A tool span counts as a success only when attrs.ok === true. Anything else —
// ok:false, an `error` attr, or NO success attribute at all (emitters that
// don't stamp ok yet) — is conservatively counted as not-ok, so okRate never
// overstates success. Pure — safe to call inside a selector/useMemo.

export interface ToolSuccessRate {
  tool: string
  total: number
  /** fraction in [0,1] of this tool's calls that ended ok:true. */
  okRate: number
}

export function selectToolSuccessRates(spans: Span[]): ToolSuccessRate[] {
  const byTool = new Map<string, { total: number; ok: number }>()
  for (const sp of spans) {
    if (sp.kind !== 'tool') continue
    const agg = byTool.get(sp.name) ?? { total: 0, ok: 0 }
    agg.total += 1
    if (sp.attrs.ok === true) agg.ok += 1
    byTool.set(sp.name, agg)
  }

  const out: ToolSuccessRate[] = []
  for (const [tool, { total, ok }] of byTool) {
    out.push({ tool, total, okRate: total > 0 ? ok / total : 0 })
  }
  // Busiest tool first; tie-break by name for a stable order.
  out.sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool))
  return out
}
