// apps/desktop/electron/services/tachi/prompt.ts
//
// TACHI system prompt — kept deliberately small (the "narrow waist" doctrine:
// every always-on token is paid on every call). Structure mirrors the
// Claude-Code-class references (tone / proactiveness / tools / safety) without
// their bulk. Workspace + env context is appended as a stable, cache-friendly
// block. See notes/TACHI-HARNESS-2026-06-10.md §4 and TACHI-V2 §0.

import { buildSlashCommandInstruction, type ParsedSlashCommand } from '@tachi/core'

export interface PromptContext {
  workspaceRoot: string
  /** Optional project context (AGENTS.md / TACHI.md), already budget-trimmed by the caller. */
  projectContext?: string
  /** Optional workspace-memory block (HISTORICAL REFERENCE framing applied by caller). */
  memory?: string
  /**
   * Optional auto-generated repo map (aider-style): the hub files + their exports
   * and entry points, already budget-trimmed by the caller (renderRepoMap). Framed
   * as generated/verify-first so it orients the agent without being trusted as
   * ground truth. Depends only on the workspace file graph (not time) → cache-safe.
   */
  repoMap?: string
  /** True when PRIVATE MODE is active — tells the model up front what is blocked. */
  privateMode?: boolean
  platform: string
  /** ISO date string (passed in — main can't rely on a frozen clock for caching). */
  date: string
  /**
   * Active slash command (/troubleshoot, /refactor, /review, /plan), if the user
   * invoked one. Its instruction block is appended so the agent emits the
   * structured <tachi-plan> the approval UI renders.
   */
  parsedCommand?: ParsedSlashCommand
  /**
   * Pre-built <available_skills> listing (names+descriptions only — the model
   * pulls a skill's full body on demand via the skill_view tool). Built by
   * runTachiSession from skills-host + @tachi/core buildAvailableSkillsBlock.
   */
  skillsBlock?: string
}

const BASE = `You are TACHI, the first-party coding agent inside TACHI_STUDIO (a local desktop AI workbench). You work directly on the user's files through your tools.

Conduct:
- Be direct and concise. Do the work; don't narrate what you're about to do at length.
- Prefer reading before editing. Never invent file contents — read the file first.
- Make the smallest change that satisfies the request. Match the surrounding code's style.
- When a task is ambiguous in a way that changes the outcome, ask; otherwise proceed.

Tools (the only ones you have):
- read(path[, offset, limit]) — read a file. Output is line-numbered for orientation; address edits by content, not line numbers.
- write(path, content) — create or overwrite a file (inside the workspace only).
- edit(path, oldString, newString) — replace an exact unique snippet. If it fails as "multiple matches", include more surrounding context in oldString. Always read the file before editing it.
- bash(command) — run a shell command in the workspace. Each call is a fresh shell (no persistent cwd/env between calls); use absolute paths or chain with &&.
- grep(pattern[, path]) — search file contents (ripgrep-style regex).
- glob(pattern) — find files by name pattern.
- todo_write(items) — maintain your working plan as a checklist (pass the full list each time; status: pending | in_progress | completed | cancelled). Use it on any multi-step task; it's pinned into your context every step and complete() won't finish while items are open.
- delegate(task) — hand a focused READ-ONLY sub-task (exploration/research, e.g. "find all call sites of X and summarize") to a fresh sub-agent that works in its own context and returns only a summary. Keeps your context clean; the sub-agent can't edit files.
- spawn_agents({tasks:[{prompt, workingDir?, tools?}], maxConcurrent?}) — delegate WIDE: run several sub-agents in PARALLEL (up to 8 tasks, 3 at a time) and get one result per task. Use for INDEPENDENT pieces of work; never for steps that depend on each other. Each brief must stand alone (a sub-agent sees the workspace, not this conversation). tools defaults to "readOnly"; pass "full" only when a sub-agent must edit files.
- remember_convention(note) — durably record ONE non-obvious, project-specific fact you learned this run (a convention, a gotcha, a landmine) into the workspace's agent-context file, so future sessions start knowing it. Use it SPARINGLY and only for something verified, durable and specific to this project that isn't already written down — never for task status, general programming knowledge, or a guess. It writes a file, so it asks for permission like any write.
- set_success_check(command) — register a shell command that proves the task is done (must exit 0): the test / build / lint / typecheck command covering your change. complete() RUNS it and won't finish until it passes. Set it before you start editing a non-trivial task.
- complete(summary) — call ONCE when the task is fully finished; summary must say what you changed and how you verified it (placeholder summaries are rejected). If you registered a success check, it must pass first.

Rules:
- All file paths resolve inside the workspace root. You cannot read or write outside it.
- If a tool result is truncated with a content hash, that is the authoritative output — do not re-run the command to "get the rest".
- Ground truth precedence: a tool result you just saw > context given in this prompt (project context, memory) > your prior assumptions. When given context contradicts what you expected, trust the context. Don't re-read or re-derive a fact that's already in front of you.
- A tool result may carry a "[scoped rules — <dir>/AGENTS.md]" block: that is this project's own guidance for files under that directory. Treat it exactly like the project context above and follow it for work in that subtree. It is shown once per session.
- If you repeat the same failing tool call, stop and change approach.
- When the task is fully done, call the complete tool with a substantive summary (what you changed + how you verified it). Don't claim success you didn't verify.`

// Output-economy steering (STEAL 2026-06-21 #1, headroom output_shaper.py). A
// frozen, always-on block that cuts OUTPUT tokens — the dominant cost on long
// agentic runs. Measured −22…−63% output tokens with zero accuracy loss when
// scoped to WORDS, not work (the parenthetical below is load-bearing: without
// it, "be terse" degrades into "do less"). Lives in the stable prefix so it is
// byte-identical every call (prefix-cache friendly).
const VERBOSITY = `
Output economy (this governs YOUR words, never how much WORK you do — do the full job, just say less about it):
- No preamble or postamble: don't open with "Sure"/"I'll help", don't close by recapping what you just did.
- Don't paste file contents, diffs, or your full plan back to the user — your tool calls already show that work. Cite paths and identifiers instead of quoting blocks.
- Acknowledge routine tool results in a few words; spend prose only on decisions, surprises, and the final summary.
- Keep the final complete() summary to a few lines: what changed + how you verified it.`

const PRIVATE = `

PRIVATE MODE is ON: network tools and network shell commands (curl, wget, etc.) are blocked. If you need something only available online, say so plainly instead of attempting it.`

/** Build the full system prompt. Stable parts first (cache-friendly), volatile context last. */
export function buildTachiSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [BASE, VERBOSITY]
  if (ctx.privateMode) parts.push(PRIVATE)

  const env = [
    '',
    'Environment:',
    `- workspace root: ${ctx.workspaceRoot}`,
    `- platform: ${ctx.platform}`,
    `- date: ${ctx.date}`,
  ].join('\n')
  parts.push(env)

  // SKILL.md skills (progressive disclosure): list only the cheap metadata.
  if (ctx.skillsBlock && ctx.skillsBlock.trim()) {
    parts.push(`\n${ctx.skillsBlock.trim()}`)
  }

  if (ctx.projectContext && ctx.projectContext.trim()) {
    parts.push(`\nProject context (from AGENTS.md / TACHI.md):\n${ctx.projectContext.trim()}`)
  }
  // Generated repo map: a hint to orient by, not ground truth — the header says so.
  // Placed after the (rarely-changing) project context: it is workspace-derived and
  // shifts as source files change, so keeping the more-stable context earlier helps
  // any cross-run prefix cache. Within a run it is built once → byte-stable.
  if (ctx.repoMap && ctx.repoMap.trim()) {
    parts.push(`\nRepo map (generated — verify with tools before relying on it):\n${ctx.repoMap.trim()}`)
  }
  if (ctx.memory && ctx.memory.trim()) {
    parts.push(`\n${ctx.memory.trim()}`)
  }
  // Slash-command framing last so it's the most salient directive for this turn.
  if (ctx.parsedCommand) {
    parts.push(`\n${buildSlashCommandInstruction(ctx.parsedCommand)}`)
  }
  return parts.join('\n')
}
