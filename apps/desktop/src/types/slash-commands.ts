// apps/desktop/src/types/slash-commands.ts
//
// Sprint F2: JSON schema types for the four slash commands.
// These types describe the structured artifacts the agent emits inside
// <tachi-plan type="..."> tags, and the card status lifecycle.

// ── Block (inline-redefined from playbook-service.ts) ─────────────────────────
//
// playbook-service.ts lives in electron/ and cannot be imported from renderer
// code. Block is a simple discriminated union with no logic — we redefine it
// here verbatim so renderer components can use it without crossing the IPC
// boundary. The two definitions must be kept in sync manually.
//
// Source of truth: apps/desktop/electron/services/playbook-service.ts (D3)
export type Block =
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'bullet';  text: string; children?: Block[] }
  | { type: 'text';    text: string }
  | { type: 'code';    lang?: string; text: string }

// ── Slash command names ───────────────────────────────────────────────────────
//
// Canonical home: packages/core/src/agent/types.ts. Re-exported here so renderer
// components can continue to `import { SlashCommand } from '../types/slash-commands'`
// without crossing the package boundary by hand.

export type { SlashCommand } from '@tachi/core'

// Local alias so the rest of this file (which references SlashCommand in field
// types) doesn't need to be reshuffled around the re-export hoisting order.
import type { SlashCommand } from '@tachi/core'

// ── TroubleshootPlan ──────────────────────────────────────────────────────────

export type TroubleshootPlan = {
  command: 'troubleshoot'
  rootCause: {
    /** Plain text, 120 chars max. */
    summary:    string
    /** Integer 0–100. */
    confidence: number
    /** Tool-call outputs or log snippets cited as evidence. */
    evidence:   string[]
  }
  solutions: Array<{
    title:      string
    steps:      string[]
    risk:       'low' | 'medium' | 'high'
    reversible: boolean
  }>
  /** Cross-cutting risks not tied to a specific solution. */
  risks:    string[]
  metadata: {
    sessionId:    string
    workspaceDir: string
    /** Unix epoch milliseconds. */
    ts:           number
  }
}

// ── RefactorPlan ──────────────────────────────────────────────────────────────

export type RefactorPlan = {
  command: 'refactor'
  /** Affected path or scope description (e.g. a file path or free-form target). */
  target:  string
  changes: Array<{
    kind:        'rename' | 'extract' | 'rewrite' | 'delete' | 'move' | 'inline'
    description: string
    /** Absolute paths of affected files. */
    filePaths:   string[]
    impact:      'low' | 'medium' | 'high'
    reversible:  boolean
    /** IDs of other changes within this plan that must precede this one. */
    dependsOn?:  string[]
  }>
  estimatedDiff: {
    added:   number
    removed: number
  }
  metadata: {
    sessionId:    string
    workspaceDir: string
    ts:           number
  }
}

// ── ReviewReport ──────────────────────────────────────────────────────────────

export type ReviewReport = {
  command: 'review'
  /** Path or scope that was reviewed. */
  scope:    string
  findings: Array<{
    severity:    'error' | 'warning' | 'info'
    file:        string
    line?:       number
    /** Short slug, e.g. "unsafe-cast", "missing-await". */
    rule:        string
    description: string
    suggestion?: string
  }>
  summary: {
    errorCount:   number
    warningCount: number
    infoCount:    number
  }
  metadata: {
    sessionId:    string
    workspaceDir: string
    ts:           number
  }
}

// ── PlanArtifact ──────────────────────────────────────────────────────────────

export type PlanArtifact = {
  command: 'plan'
  goal:    string
  phases:  Array<{
    /** Slug format, e.g. "phase-1-ipc-router". */
    id:       string
    name:     string
    status:   'pending' | 'in-progress' | 'done'
    /** IDs of prerequisite phases. */
    dependsOn: string[]
    tasks: Array<{
      /** Slug format, e.g. "task-migrate-shell-ipc". */
      id:          string
      description: string
      status:      'pending' | 'in-progress' | 'done'
      /** Tools the agent expects to use (Read, Edit, Bash, …). */
      toolHints:   string[]
    }>
    /** D3 Block[] for rendered output after the phase completes. */
    summary?: Block[]
  }>
  risks:        string[]
  /** Ordered phase IDs forming the critical path. */
  criticalPath: string[]
  metadata: {
    sessionId:    string
    workspaceDir: string
    ts:           number
  }
}

// ── Discriminated union ───────────────────────────────────────────────────────

/**
 * Discriminated union of all four slash-command result types.
 * Discriminant is the `command` field.
 */
export type SlashCommandResult =
  | TroubleshootPlan
  | RefactorPlan
  | ReviewReport
  | PlanArtifact

// ── Card status ───────────────────────────────────────────────────────────────

/**
 * Lifecycle state of a slash-command card in the agent UI.
 *
 * - `pending-review` — plan emitted, awaiting user action
 * - `approved`       — user clicked Approve; agent is executing
 * - `applied`        — agent finished; all changes committed
 * - `cancelled`      — user clicked Cancel; no agent call made
 */
export type SlashCardStatus = 'pending-review' | 'approved' | 'applied' | 'cancelled'

// ── ParsedSlashCommand (canonical type re-export) ────────────────────────────
//
// Single source of truth: packages/core/src/agent/types.ts. F1 emits this from
// the renderer slash-parser, attaches it to `agent:send`, and the main-process
// chat-service / tool-loop consume the same shape. All three layers import from
// `@tachi/core`; this barrel is provided so existing renderer code that imports
// from `../types/slash-commands` keeps working.

export type { ParsedSlashCommand } from '@tachi/core'
