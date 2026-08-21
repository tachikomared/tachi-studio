// packages/core/src/agent/history.ts
//
// Collapse a flat AgentEvent stream (what the Code page stores per session) into
// clean conversation TURNS the harness can replay so it remembers context across
// messages. User messages (`user-text`) and the assistant's spoken `text` are
// kept; tool calls/results and control events are dropped (the assistant's text
// carries the conclusion, and replaying full tool I/O would blow the budget).
// Pure — no electron, no renderer types.

import type { AgentEvent } from './types.js'

export interface AgentHistoryTurn { role: 'user' | 'assistant'; content: string }

export function buildAgentHistory(events: AgentEvent[]): AgentHistoryTurn[] {
  const turns: AgentHistoryTurn[] = []
  let assistant = '' // accumulates assistant text deltas (across tool calls) until the next user turn

  const flushAssistant = (): void => {
    if (assistant.trim()) turns.push({ role: 'assistant', content: assistant.trim() })
    assistant = ''
  }

  for (const e of events) {
    if (e.type === 'user-text') {
      flushAssistant()
      if (e.text.trim()) turns.push({ role: 'user', content: e.text.trim() })
    } else if (e.type === 'text') {
      assistant += e.text
    }
    // tool-call / tool-done / fusion-panel / error / done → ignored (kept out of replayed history)
  }
  flushAssistant()
  return turns
}
