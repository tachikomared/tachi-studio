// apps/desktop/electron/ipc/workspace-panel.ipc.ts
//
// Sprint C4 — typed IPC router for the per-conversation workspace panel.
//
// New namespace: "workspace-panel" — does NOT touch the existing "workspace"
// namespace (workspace.ipc.ts / registerWorkspaceIpc), which remains unchanged.
//
// Routes:
//   workspace-panel:list-recent-changes   { sessionId }       → { changes[] }
//   workspace-panel:get-workspace-for-conversation { conversationId } → { workspaceDir }
//
// Adapted from AionUi Workspace/index.tsx (MIT) — logic only, no UI lifted.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { loadCheckpoint } from '../services/sidecar-checkpoints'
import type { CheckpointTurn } from '../services/sidecar-checkpoints'

// ── Tool-name filter ──────────────────────────────────────────────────────────
//
// Surface only tool-call turns where the tool is one of the "mutating" tools.
// Read-only tools (Read, Glob, Grep) are included so the panel shows a
// meaningful diff picture, but future callers can narrow to Edit/Write/Bash.

const RELEVANT_TOOLS = new Set([
  'Edit', 'Write', 'Bash', 'MultiEdit', 'Read', 'Glob', 'Grep',
])

// ── parseTarget ───────────────────────────────────────────────────────────────

/**
 * Extract a human-readable target description from a tool-call turn:
 *   Edit/Write/Read  → file_path from the JSON content
 *   Bash             → the command, trimmed to 60 chars
 *   anything else    → ''
 */
function parseTarget(toolName: string, contentJson: string): string {
  try {
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
      const parsed = JSON.parse(contentJson) as unknown
      if (parsed !== null && typeof parsed === 'object' && 'file_path' in parsed) {
        return String((parsed as Record<string, unknown>)['file_path'] ?? '')
      }
      return ''
    }
    if (toolName === 'Bash') {
      const parsed = JSON.parse(contentJson) as unknown
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const cmd = String((parsed as Record<string, unknown>)['command'] ?? '').trim()
        return cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd
      }
      // Fallback: treat the raw content string as the command
      const raw = contentJson.trim()
      return raw.length > 60 ? raw.slice(0, 60) + '…' : raw
    }
    // MultiEdit / Glob / Grep: try file_path, then path, then ''
    const parsed = JSON.parse(contentJson) as unknown
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      for (const key of ['file_path', 'path', 'pattern']) {
        if (key in obj && obj[key] !== undefined) {
          return String(obj[key])
        }
      }
    }
    return ''
  } catch {
    // content is not JSON — use it directly (truncated)
    const raw = contentJson.trim()
    return raw.length > 60 ? raw.slice(0, 60) + '…' : raw
  }
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ChangeSchema = z.object({
  tool:   z.string(),   // e.g. 'Edit', 'Write', 'Bash'
  target: z.string(),   // file path or command
  ts:     z.number(),   // epoch ms
})

// ── Router ────────────────────────────────────────────────────────────────────

export const workspacePanelRouter = defineRouter('workspace-panel', {

  /**
   * Return the last 20 tool-call turns from a session's checkpoint that
   * involve a "relevant" tool (Edit, Write, Bash, MultiEdit, Read, Glob, Grep).
   *
   * Returns an empty `changes` array when the session has no checkpoint yet.
   */
  listRecentChanges: route({
    input:  z.object({ sessionId: z.string() }),
    output: z.object({
      changes: z.array(ChangeSchema),
    }),
    handle: async ({ sessionId }) => {
      const turns: CheckpointTurn[] = sessionId ? loadCheckpoint(sessionId) : []
      const changes = turns
        .filter(
          t => t.role === 'tool-call' && RELEVANT_TOOLS.has(t.name ?? ''),
        )
        .slice(-20)
        .map(t => ({
          tool:   t.name ?? 'unknown',
          target: parseTarget(t.name ?? '', t.content),
          ts:     t.ts,
        }))
      return { changes }
    },
  }),

  /**
   * Stub — returns null for now.
   *
   * TODO(C4-cross-window): plumb via a main-side conversation registry so that
   * workspaceDir survives across windows and can be set/read without relying on
   * the renderer's chat.store (which is per-window). For C4 the renderer reads
   * workspaceDir from its local chat.store directly; this route exists so the
   * IPC surface is in place for future cross-window sync.
   */
  getWorkspaceForConversation: route({
    input:  z.object({ conversationId: z.string() }),
    output: z.object({ workspaceDir: z.string().nullable() }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    handle: async (_input) => ({ workspaceDir: null }),
  }),

})

/**
 * @deprecated Use registerRouter(workspacePanelRouter) instead.
 * No-op shim — kept for structural consistency with other IPC modules.
 */
export function registerWorkspacePanelIpc(): void { /* no-op */ }
