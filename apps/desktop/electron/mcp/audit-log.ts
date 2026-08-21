// apps/desktop/electron/mcp/audit-log.ts
//
// Durable JSONL audit trail for MCP tool calls (STEAL 2026-06-12 cluster B;
// gridex MCPAuditLogger pattern). One line per call — including reads and
// failures — so "what did that agent touch last night" is answerable after a
// restart. Rotation keeps at most ~2 windows on disk (file + file.1).
//
// Best-effort by contract: an audit failure must NEVER break the tool call.

import { appendFileSync, statSync, renameSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AuditEntry {
  ts: number
  actor: string
  tool: string
  status: 'ok' | 'error' | 'denied'
  durationMs: number
  /** Short free-form context, e.g. the error message head. Optional. */
  detail?: string
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export function appendAudit(filePath: string, entry: AuditEntry, maxBytes = DEFAULT_MAX_BYTES): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      // Windows rename fails on an existing target — drop the old .1 first.
      rmSync(filePath + '.1', { force: true })
      renameSync(filePath, filePath + '.1')
    }
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* best-effort: never break the tool call over auditing */
  }
}
