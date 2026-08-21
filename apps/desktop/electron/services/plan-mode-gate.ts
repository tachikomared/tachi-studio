// apps/desktop/electron/services/plan-mode-gate.ts
//
// Enforcement behind the AgentPage PLAN/BUILD toggle (STEAL 2026-06-12;
// odysseus src/tool_security.py pattern). Before this gate, "plan" mode was a
// prompt prefix only — the model was ASKED not to build, but write/edit/bash
// still executed. This module is consulted by agent.ipc's tachiGate when the
// renderer sends mode === 'plan'.
//
// Policy (FAIL-CLOSED — mirror of unattended-gate.ts's shape):
//   read / grep / glob  → allow (inspection)
//   write / edit        → deny  (mutators, hard backstop)
//   bash                → allow ONLY simple read-only commands: no shell
//                         metacharacters, first tokens on a known allowlist
//   anything else       → deny

export interface PlanModeDecision {
  allowed: boolean
  reason?: string
}

const READ_TOOLS = new Set(['read', 'grep', 'glob'])
// Read-only static analysis (build an in-memory import graph from reading
// files — no writes, shell, or network; same tools auto-approved by
// permission-service). Allowed in PLAN: impact analysis is precisely what a
// plan should be grounded in.
const READONLY_ANALYSIS = new Set(['blast_radius', 'trace_path', 'get_architecture', 'find_definition', 'find_references', 'find_callers', 'expand_compacted', 'conversation_search', 'skill_view', 'bash_output'])
const MUTATOR_TOOLS = new Set(['write', 'edit'])

/** Pipes, redirects, chaining, substitution — any of these defeats prefix checks. */
const SHELL_META = /[|;&><`]|\$\(/

/**
 * Read-only command prefixes. Compared lowercase. A trailing space in an entry
 * means "must be followed by an argument"; entries without it also match the
 * bare command.
 */
const READONLY_PREFIXES = [
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git blame',
  'git grep', 'git rev-parse', 'git remote -v', 'git stash list',
  'ls', 'dir', 'pwd', 'tree',
  'cat ', 'head ', 'tail ', 'wc ',
  'rg ', 'grep ', 'find ',
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm view',
  'python --version', 'pip list',
  'where ', 'which ', 'type ', 'whoami',
]

export function checkPlanModeTool(name: string, input: Record<string, unknown>): PlanModeDecision {
  if (READ_TOOLS.has(name) || READONLY_ANALYSIS.has(name)) return { allowed: true }

  if (MUTATOR_TOOLS.has(name)) {
    return {
      allowed: false,
      reason: `"${name}" mutates the workspace. You are in PLAN mode — present the plan; the user switches to BUILD to apply it.`,
    }
  }

  if (name === 'bash') {
    const raw = input.command ?? input.cmd
    const cmd = typeof raw === 'string' ? raw.trim() : ''
    if (!cmd) return { allowed: false, reason: 'PLAN mode: empty shell command.' }
    if (SHELL_META.test(cmd)) {
      return { allowed: false, reason: 'PLAN mode allows only simple read-only commands (no pipes, redirects, chaining, or substitution).' }
    }
    const lc = cmd.toLowerCase()
    const ok = READONLY_PREFIXES.some(p => (p.endsWith(' ') ? lc.startsWith(p) : lc === p || lc.startsWith(p + ' ')))
    if (ok) return { allowed: true }
    return {
      allowed: false,
      reason: `PLAN mode blocked "${cmd.slice(0, 60)}" — only read-only inspection commands run in PLAN; switch to BUILD to execute.`,
    }
  }

  // Unknown tool → deny (fail-closed; a new mutating tool must not slip through).
  return { allowed: false, reason: `PLAN mode blocks "${name}" (fail-closed default).` }
}
