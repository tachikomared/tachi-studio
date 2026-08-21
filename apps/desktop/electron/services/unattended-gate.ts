// apps/desktop/electron/services/unattended-gate.ts
//
// The tool gate for UNATTENDED agent paths (swarm-executor, approve-plan) — runs
// ON TOP of the existing PRIVATE-MODE egress check. Audit 2026-06-12 (dim 4+6):
// those paths previously gated only egress, so an autonomous agent ran arbitrary
// bash and protected-path writes with no human in the loop.
//
// Policy (fail-closed):
//   - bash-shaped tool → deny destructive commands (rm -rf /, dd, curl|sh, …);
//     normal work (build/test/commit, scoped cleanup) passes.
//   - any other tool   → consult the interactive auto-approval oracle; anything
//     that would prompt a human (protected-path write, etc.) is DENIED, because
//     there is no human to prompt in unattended mode.

import { checkAutoApproval, extractCommandArg } from './permission-service'
import { isDestructiveCommand } from './destructive-commands'

/** Bash-shaped tool names across harnesses. */
const BASH_SHAPED = /^(bash|shell|run_command|run|execute|cmd|terminal|developer__shell)/i

export interface UnattendedDecision {
  allowed: boolean
  reason?: string
}

export function classifyUnattendedTool(
  toolName: string,
  input: unknown,
  ctx: { workingDir: string },
): UnattendedDecision {
  if (BASH_SHAPED.test(toolName)) {
    const cmd = extractCommandArg(input)
    if (cmd) {
      const verdict = isDestructiveCommand(cmd)
      if (verdict.destructive) {
        return { allowed: false, reason: `Unattended run refused a destructive shell command: ${verdict.reason}. Run it from an interactive session if intended.` }
      }
    }
    return { allowed: true }
  }

  // Non-bash: anything that would need a human prompt is denied (fail-closed).
  const approval = checkAutoApproval(toolName, input, ctx)
  if (approval === 'needs-prompt') {
    return { allowed: false, reason: `Unattended run refused "${toolName}" — it requires human approval (e.g. a protected path) and no human is in the loop.` }
  }
  return { allowed: true }
}
