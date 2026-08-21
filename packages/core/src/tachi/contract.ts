// packages/core/src/tachi/contract.ts
//
// Shared type spine for the TACHI first-party agentic harness. Pure types only —
// no runtime, no electron, no node. Every TACHI core module imports its
// input/output shapes from here so the loop (apps/desktop) and the pure logic
// (packages/core/src/tachi/*) stay in lock-step. See docs/app/TACHI-HARNESS-2026-06-10.md
// and docs/app/TACHI-V2-2026-06-11.md.

// ── Tools ──────────────────────────────────────────────────────────────────────

/** The fixed TACHI v1 core toolset (the "narrow waist"). */
export type TachiToolName =
  | 'read'
  | 'write'
  | 'edit'
  | 'bash'
  | 'grep'
  | 'glob'

/** A tool call the model wants to make (provider-normalised). */
export interface TachiToolCall {
  /** Stable id from the provider, or a synthesised one for salvaged calls. */
  id: string
  name: string
  /** Parsed arguments object (already JSON-parsed; never a raw string). */
  args: Record<string, unknown>
}

// ── Edit cascade (tools/edit-core.ts) ────────────────────────────────────────────

/** Result of attempting a single string replacement in file content. */
export type EditResult =
  | { ok: true; content: string; strategy: EditStrategy }
  | { ok: false; reason: EditFailureReason; detail: string }

export type EditStrategy =
  | 'exact'
  | 'line-trimmed'
  | 'block-anchor'
  | 'whitespace-normalized'
  | 'indentation-flexible'
  | 'escape-normalized'
  | 'trimmed-boundary'
  | 'context-aware'

export type EditFailureReason =
  | 'not-found'        // oldString matched nothing under any strategy
  | 'multiple-matches' // matched in >1 place; needs more context
  | 'disproportionate' // a fuzzy match was implausibly large vs oldString
  | 'empty-old-string' // empty oldString on a non-empty/ existing file

// ── Salvage parser (salvage.ts) ──────────────────────────────────────────────────

/** Shape of a tool call recovered from assistant TEXT when native tool_calls is empty. */
export interface SalvagedCall {
  name: string
  args: Record<string, unknown>
  /** Which textual encoding it was recovered from (for telemetry/debugging). */
  via: 'xml-function' | 'xml-tool_call' | 'json-block' | 'bare-json'
}

// ── Stall detection (loop/stall.ts) ──────────────────────────────────────────────

export interface StallVerdict {
  /** True when the last N tool calls are byte-identical (default N=3). */
  stalled: boolean
  /** How many identical calls in a row at the tail. */
  repeats: number
}

// ── Token estimation (estimate-tokens.ts) ────────────────────────────────────────

/** A chat message shape the estimator can weigh (subset of provider message). */
export interface EstimableMessage {
  role: string
  content: unknown
}

// ── Tool-output truncation (tools/truncate.ts) ────────────────────────────────────

export interface TruncateOptions {
  /** Keep at most this many lines (head+tail split). Default 2000. */
  maxLines?: number
  /** Hard byte cap after line slicing. Default 50_000. */
  maxBytes?: number
  /** Approx model-facing token budget; overrides byte cap when smaller. Default 10_000. */
  maxTokens?: number
}

export interface TruncateResult {
  /** Text to hand the model (possibly elided with a hashed receipt). */
  text: string
  truncated: boolean
  /** sha256(full).slice(0,12) when truncated, else undefined — lets reruns be recognised. */
  contentHash?: string
  originalChars: number
  keptChars: number
}

// ── Model capability catalog (models.ts) ──────────────────────────────────────────

export type ToolProtocol = 'native' | 'native-then-salvage' | 'none'
export type EditFormat = 'edit-cascade' | 'whole-file' | 'apply-patch'

export interface ModelCapability {
  /** Match key: exact id or a substring tested against the model id. */
  match: string
  /**
   * Context window in tokens. ALWAYS a usable number so budgeting callers can
   * budget — but read `contextWindowKnown` before believing it. When that flag
   * is false this is a conservative ESTIMATE (a family-wide guess, or the
   * blanket assumption for an id we have never seen), not the model's real
   * window, and it must never be shown to the user as the model's window.
   * Prefer `resolveContextWindow()` over reading this field directly: it takes
   * the provider's live catalog value when there is one and tells you which
   * source answered.
   */
  contextWindow: number
  /**
   * True ⇔ `contextWindow` is a sourced fact about the models this row matches
   * (an exact id, a named variant, or a vendor-published family-wide floor).
   * False on bare family rows that span variants with materially different
   * windows, and on the wildcard fallback.
   */
  contextWindowKnown: boolean
  supportsTools: boolean
  supportsTemperature: boolean
  toolProtocol: ToolProtocol
  editFormat: EditFormat
  /** Defeat agent mode entirely (e.g. 8k local models). */
  agentCapable: boolean
}

// ── Safe-command classifier (safety.ts) ──────────────────────────────────────────

export type CommandSafety =
  | { safe: true }
  | { safe: false; reason: string }
