// apps/desktop/electron/services/permission-service.ts
//
// Stateless + session-scoped permission oracle for agent tool calls.
//
// Lifecycle:
//   1. agent.ipc.ts calls checkAutoApproval() before dispatching each tool.
//   2. If 'auto-allow' → dispatch immediately.
//   3. If 'needs-prompt' → pause dispatch, push an `agent:permission-request`
//      to the renderer, wait for the renderer to call agent:permission-response
//      via IPC, then recordDecision() and unblock.

import { isPathProtected } from './protected-paths'
import { isDestructiveCommand } from './destructive-commands'
import { randomUUID } from 'crypto'

// ── Types (exported so renderer can share them via IPC payload) ──────────────

export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'always_allow_tool'
  | 'always_allow_server'
  /** Session grant that silently expires (30-min TTL cache) — the escape from
   *  per-call prompting without the permanence of always_allow (UX #8). */
  | 'allow_30m'

/**
 * User-selected trust preset for the CODE tab (UX #8) — same three-state chip
 * idiom as NORMAL/THINK/ULTRA:
 *  - 'safe'     → ask for EVERY mutation (even writes inside the workspace).
 *  - 'standard' → today's default ladder: reads auto, writes inside the
 *                 workspace auto, protected paths / bash / MCP ask.
 *  - 'auto'     → additionally auto-allows NON-destructive bash; destructive
 *                 commands and MCP tools still ask; deny-lists stay fail-closed.
 */
export type TrustLevel = 'safe' | 'standard' | 'auto'

export interface PermissionRequest {
  /** Stable UUID for correlating request ↔ response. */
  id: string
  toolName: string
  toolInput: unknown
  /** Human-readable explanation of why this requires review. */
  reason: string
  recommendedDecision: 'allow' | 'deny'
  /**
   * Harness session this call belongs to. Stamped on the RENDERER payload (see
   * agent.ipc.ts `awaitPermissionDecision`) — the approval queue is
   * app-lifetime, so a card can render on a surface that does not own the run,
   * and the renderer maps this id back to the owning surface to label it.
   * Optional: `buildPermissionRequest` does not know the session.
   */
  sessionId?: string
}

// ── Session-scoped allow-lists ───────────────────────────────────────────────
//
// Entries are added when the user chooses 'always_allow_tool' or
// 'always_allow_server'. These survive for the current app session only —
// they are not persisted to disk.

/** Tool names the user has said "always allow" for. */
const alwaysAllowedTools = new Set<string>()

/** A synthetic "server" key per tool (we use toolName prefix family here). */
const alwaysAllowedFamilies = new Set<string>()

// ── TTL session-approval cache ──────────────────────────────────────────────
//
// Adapted from gridex's MCPApprovalGate.sessionApprovals: an [actor+tool: expiry]
// map consulted BEFORE prompting. Distinct from the permanent always-allow above —
// these are the "Approve for 30 minutes" grants that expire silently, so the next
// request re-prompts. Keyed by tool+actor (the actor being the originating
// agent/connection, mirroring gridex's connectionId+tool key).

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes, matching gridex

/** tool+actor key -> epoch-ms expiry (inclusive). */
const ttlApprovals = new Map<string, number>()

/** Identifies a single approval grant: a tool invoked by a specific actor. */
export interface SessionApprovalKey {
  toolName: string
  /** Originating agent/connection (e.g. 'darksol', 'tachi'). */
  actor: string
}

/** Injectable clock; defaults to Date.now so callers need not pass one. */
type NowFn = () => number

const _TTL_KEY_SEP = String.fromCharCode(31)

function _ttlKey(key: SessionApprovalKey): string {
  // U+001F (unit separator) delimits the two fields so distinct (actor,tool)
  // pairs can never collide (e.g. "a"+"bc" vs "ab"+"c"). It is a control char
  // that never appears in a tool name or actor id. (Previously a literal NUL
  // was used here, which made the source file binary to git — replaced.)
  return `${key.actor}${_TTL_KEY_SEP}${key.toolName}`
}

// ── Read-like tools that are safe to auto-approve ───────────────────────────

const READ_LIKE_TOOLS = new Set([
  // Canonical names across harnesses
  'Read', 'read', 'read_file', 'view_file',
  'Glob', 'glob',
  'Grep', 'grep', 'search', 'ripgrep',
  // SKILL.md skills: reads a skill's own folder only (containment enforced in
  // skills-host) — no writes, shell, or network.
  'skill_view',
  // Background-task bookkeeping: bash_output tails a buffer; bash_kill stops
  // a task THIS session started (the start itself was bash → already prompted).
  'bash_output', 'bash_kill',
  'LS', 'ls', 'list', 'list_files', 'list_dir',
  'View', 'view',
  'Find', 'find',
  'Tree', 'tree',
  // Read-only static analysis (TACHI): builds an in-memory import graph and
  // returns affected paths / dependency chains / a structural overview — no
  // writes, no shell, no network.
  'blast_radius', 'trace_path', 'get_architecture', 'find_definition', 'find_references', 'find_callers',
  // CCR: recover the full text of an already-produced (elided) tool output —
  // reads an in-memory session store, no side effects.
  'expand_compacted',
  // Full-text recall over saved chats (local FTS5 index) — read-only, no network.
  'conversation_search',
])

/** Regex for BASH-like tool names — always prompt. */
const BASH_RE = /^(bash|shell|run_command|execute|cmd|terminal)/i

/** Regex for write/mutate tool names — may prompt depending on path. */
const WRITE_RE = /^(write|create|edit|patch|update|replace|str_replace|multiedit|delete|remove|move|rename|mkdir)/i

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine whether this tool invocation can proceed without prompting.
 *
 * @returns 'auto-allow' → dispatch immediately.
 *          'needs-prompt' → pause and show PermissionCard to the user.
 */
export function checkAutoApproval(
  toolName: string,
  input: unknown,
  ctx: { workingDir: string; actor?: string; trust?: TrustLevel },
): 'auto-allow' | 'needs-prompt' {
  const trust: TrustLevel = ctx.trust ?? 'standard'
  // 1. Explicit always-allow-tool grant.
  if (alwaysAllowedTools.has(toolName)) return 'auto-allow'

  // 2. Family-level always-allow (e.g. "always allow read family")
  const familyKey = _familyKey(toolName)
  if (alwaysAllowedFamilies.has(familyKey)) return 'auto-allow'

  // 2b. Live TTL session grant for this tool+actor ("Approve for 30 min").
  if (ctx.actor && isSessionApproved({ toolName, actor: ctx.actor })) return 'auto-allow'

  // 3. Read-like tools → auto-allow (all trust tiers — reads are safe).
  if (READ_LIKE_TOOLS.has(toolName)) return 'auto-allow'

  // 3b. SAFE tier: everything that is not a known read asks. Explicit grants
  // above still work, so the user can carve exceptions without leaving SAFE.
  if (trust === 'safe') return 'needs-prompt'

  // 4. Bash / shell → prompt, except AUTO tier auto-allows NON-destructive
  // commands (rm -rf / format / registry writes etc. still ask — the
  // destructive matcher is the same one the unattended gate fail-closes on).
  if (BASH_RE.test(toolName)) {
    if (trust === 'auto') {
      const cmd = extractCommandArg(input)
      // Fail-closed: no extractable command string → still prompt.
      if (cmd && !isDestructiveCommand(cmd).destructive) return 'auto-allow'
    }
    return 'needs-prompt'
  }

  // 5. Write/mutate tools — check path protection.
  if (WRITE_RE.test(toolName)) {
    const path = _extractPath(input)
    if (path && isPathProtected(path, ctx.workingDir)) return 'needs-prompt'
    // Write inside workingDir — auto-allow (agent is doing its job).
    return 'auto-allow'
  }

  // 5b. Codex worker delegation — read-only analysis runs free; WRITE access
  // to the workspace (sandbox workspace-write) always asks the user first.
  // Explicit rule because rule 6 would otherwise auto-allow it.
  if (toolName === 'codex_worker') {
    return (input as { write?: boolean } | null)?.write === true ? 'needs-prompt' : 'auto-allow'
  }

  // 5c. Bridged MCP tools (mcp_<server>_<tool>) — third-party code with
  // unknown side effects; never auto-allow. The user can grant a session
  // TTL / always-allow from the PermissionCard like any other tool.
  if (toolName.startsWith('mcp_')) return 'needs-prompt'

  // 6. Unknown tool — auto-allow unless it looks dangerous.
  return 'auto-allow'
}

/**
 * Build a PermissionRequest object for a tool call that needs a prompt.
 * The caller is responsible for pushing this to the renderer and waiting for
 * a response.
 */
export function buildPermissionRequest(
  toolName: string,
  input: unknown,
  ctx: { workingDir: string },
): PermissionRequest {
  const isBash = BASH_RE.test(toolName)
  const path = _extractPath(input)
  const isProtected = path ? isPathProtected(path, ctx.workingDir) : false

  let reason: string
  let recommended: 'allow' | 'deny'

  if (isBash) {
    const cmd = extractCommandArg(input)
    reason = cmd
      ? `Bash execution: \`${cmd.slice(0, 120)}\``
      : 'Agent wants to run a shell command.'
    recommended = 'allow'
  } else if (toolName === 'codex_worker') {
    const task = (input as { task?: string } | null)?.task ?? ''
    reason = `Codex worker wants WRITE access to the workspace for: "${task.slice(0, 140)}"`
    recommended = 'allow'
  } else if (toolName.startsWith('mcp_')) {
    reason = `Third-party MCP tool "${toolName}" — runs outside Tachi's sandbox.`
    recommended = 'allow'
  } else if (isProtected && path) {
    reason = `Attempts to mutate a protected path: ${path}`
    recommended = 'deny'
  } else {
    reason = `Tool "${toolName}" requires review.`
    recommended = 'allow'
  }

  return {
    id: randomUUID(),
    toolName,
    toolInput: input,
    reason,
    recommendedDecision: recommended,
  }
}

/**
 * Record the user's decision for a permission request.
 * Updates the session-scoped allow-lists for 'always_allow_*' decisions.
 */
export function recordDecision(req: PermissionRequest, decision: PermissionDecision, actor = 'tachi'): void {
  if (decision === 'always_allow_tool') {
    alwaysAllowedTools.add(req.toolName)
  }
  if (decision === 'always_allow_server') {
    alwaysAllowedFamilies.add(_familyKey(req.toolName))
  }
  if (decision === 'allow_30m') {
    // Wire the (previously dormant) TTL cache: same tool+actor sails through
    // checkAutoApproval step 2b until the grant silently expires.
    approveForSession({ toolName: req.toolName, actor })
  }
}

/** Check if a tool is in the session-scoped always-allow list. */
export function isAutoAllowed(toolName: string): boolean {
  return alwaysAllowedTools.has(toolName) || alwaysAllowedFamilies.has(_familyKey(toolName))
}

/**
 * Grant a time-boxed approval for one tool+actor pair (the "Approve for 30 min"
 * action). Re-granting refreshes the expiry. Distinct from always_allow_*, which
 * is permanent for the session.
 */
export function approveForSession(
  key: SessionApprovalKey,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
  now: NowFn = Date.now,
): void {
  const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_SESSION_TTL_MS
  ttlApprovals.set(_ttlKey(key), now() + ttl)
}

/**
 * Whether a live (non-expired) TTL grant covers this tool+actor. Expired entries
 * are pruned on read so a stale grant never lingers. The boundary is inclusive:
 * a grant is valid up to and including its expiry instant, expired strictly after.
 */
export function isSessionApproved(key: SessionApprovalKey, now: NowFn = Date.now): boolean {
  const k = _ttlKey(key)
  const expiry = ttlApprovals.get(k)
  if (expiry === undefined) return false
  if (now() > expiry) {
    ttlApprovals.delete(k) // prune silently -> next request prompts again
    return false
  }
  return true
}

/** Drop all TTL grants. Permanent always-allow lists are NOT touched. */
export function clearSessionApprovals(): void {
  ttlApprovals.clear()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _extractPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const p = input as Record<string, unknown>
  const val = p.file_path ?? p.path ?? p.target_file ?? p.filename ?? p.destination
  return typeof val === 'string' ? val : null
}

/**
 * Extract the shell command from a bash-shaped tool call's input.
 * SINGLE SOURCE for "which command is the agent trying to run" — shared with
 * unattended-gate so the interactive and unattended security gates can never
 * diverge on how they parse tool args.
 */
export function extractCommandArg(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const p = input as Record<string, unknown>
  const val = p.command ?? p.cmd
  return typeof val === 'string' ? val : null
}

/** Maps tool name to a coarse family string for family-level allow-listing. */
function _familyKey(toolName: string): string {
  const n = toolName.toLowerCase()
  if (/^(read|view|glob|grep|ls|list|find|tree|search)/.test(n)) return 'family:read'
  if (/^(write|create)/.test(n)) return 'family:write'
  if (/^(edit|patch|update|replace|str_replace|multiedit)/.test(n)) return 'family:edit'
  if (/^(bash|shell|run|execute|cmd|terminal)/.test(n)) return 'family:bash'
  return `family:${n.split('_')[0]}`
}
