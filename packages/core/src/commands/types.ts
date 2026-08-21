// NOTE: 'goose' was removed from this union when the Goose harness was deleted
// from the product (TACHI supersedes it). Nothing PARSES a stored runtimeId
// against this union — AgentCommandEvent is a wire/display shape only — so a
// historical event that still says "goose" renders as plain text rather than
// failing validation.
export type AgentRuntimeId =
  | 'codex'
  | 'claude-code'
  | 'openclaude'
  | 'openclaw'
  | 'tachi'

export type AgentCommandStatus =
  | 'proposed'
  | 'waiting_for_approval'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface AgentCommandEvent {
  id: string
  conversationId?: string
  runtimeId?: AgentRuntimeId
  command: string
  cwd?: string
  status: AgentCommandStatus
  stdout?: string
  stderr?: string
  exitCode?: number
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}
