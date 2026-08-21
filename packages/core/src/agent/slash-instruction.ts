// packages/core/src/agent/slash-instruction.ts
//
// System-prompt instruction block for a slash command (/troubleshoot, /refactor,
// /review, /plan). The block tells the model its first response MUST be a single
// <tachi-plan type="..."> block whose inner JSON matches the renderer's
// SlashCommandResult schema — the SlashCommandCard UI then renders + approves it.
//
// Pure (no electron, no I/O) so it lives in @tachi/core and is shared by BOTH
// consumers: the Chat tab (chat-service.ts) and the TACHI agent system prompt
// (electron/services/tachi/prompt.ts). Extracted from chat-service.ts so the
// agent path can use it without pulling the whole chat service in.

import type { ParsedSlashCommand } from './types.js'

/**
 * Return the system-prompt instruction block for the given slash command. When
 * `flags.fix` is set, an extra paragraph permits the model to begin executing
 * after emitting the plan block. The switch is exhaustive over the four
 * SlashCommand values, so every path returns a string.
 */
export function buildSlashCommandInstruction(cmd: ParsedSlashCommand): string {
  const fixSuffix = cmd.flags.fix
    ? '\nThe user passed --fix. After emitting the plan block, you may immediately begin executing the recommended changes. For /refactor, defer high-impact changes until the user gives explicit approval. For /plan, proceed through phases in dependsOn order.'
    : ''

  switch (cmd.command) {
    case 'troubleshoot':
      return `[SLASH COMMAND: /troubleshoot]
The user invoked /troubleshoot. Your first response MUST be a single <tachi-plan type="troubleshoot"> block followed by NO additional text.
The block must contain a JSON object matching this exact schema:
{
  "command": "troubleshoot",
  "rootCause": { "summary": string, "confidence": number, "evidence": string[] },
  "solutions": Array<{ "title": string, "steps": string[], "risk": "low"|"medium"|"high", "reversible": boolean }>,
  "risks": string[],
  "metadata": { "sessionId": string, "workspaceDir": string, "ts": number }
}
Constraints: summary max 120 chars. confidence is an integer 0-100. Provide 2-3 solutions ordered by recommended priority. DO NOT begin any tool calls until the user has approved the plan.${fixSuffix}`

    case 'refactor':
      return `[SLASH COMMAND: /refactor]
The user invoked /refactor. Your first response MUST be a single <tachi-plan type="refactor"> block followed by NO additional text.
The block must contain a JSON object matching this exact schema:
{
  "command": "refactor",
  "target": string,
  "changes": Array<{ "kind": "rename"|"extract"|"rewrite"|"delete"|"move"|"inline", "description": string, "filePaths": string[], "impact": "low"|"medium"|"high", "reversible": boolean, "dependsOn"?: string[] }>,
  "estimatedDiff": { "added": number, "removed": number },
  "metadata": { "sessionId": string, "workspaceDir": string, "ts": number }
}
Constraints: order changes by dependsOn (topological). filePaths must be absolute. High-impact changes require user explicit approval even when --fix is active. DO NOT begin tool calls until the user has approved.${fixSuffix}`

    case 'review':
      return `[SLASH COMMAND: /review]
The user invoked /review. Your first response MUST be a single <tachi-plan type="review"> block followed by NO additional text. No prose is allowed before the JSON block.
The block must contain a JSON object matching this exact schema:
{
  "command": "review",
  "scope": string,
  "findings": Array<{ "severity": "error"|"warning"|"info", "file": string, "line"?: number, "rule": string, "description": string, "suggestion"?: string }>,
  "summary": { "errorCount": number, "warningCount": number, "infoCount": number },
  "metadata": { "sessionId": string, "workspaceDir": string, "ts": number }
}
Constraints: rule is a short slug (e.g. "unsafe-cast", "missing-await"). summary counts must match findings array. DO NOT begin tool calls until the user has approved.${fixSuffix}`

    case 'plan':
      return `[SLASH COMMAND: /plan]
The user invoked /plan. Your first response MUST be a single <tachi-plan type="plan"> block followed by NO additional text.
The block must contain a JSON object matching this exact schema:
{
  "command": "plan",
  "goal": string,
  "phases": Array<{ "id": string, "name": string, "status": "pending"|"in-progress"|"done", "dependsOn": string[], "tasks": Array<{ "id": string, "description": string, "status": "pending"|"in-progress"|"done", "toolHints": string[] }>, "summary"?: Block[] }>,
  "risks": string[],
  "criticalPath": string[],
  "metadata": { "sessionId": string, "workspaceDir": string, "ts": number }
}
Constraints: phase and task ids use slug format (e.g. "phase-1-ipc-router", "task-migrate-shell-ipc"). dependsOn references must resolve to ids within this plan. criticalPath lists phase ids in execution order. DO NOT begin tool calls until the user has approved.${fixSuffix}`
  }
}
