// packages/core/src/chat/repair-tool-messages.ts
//
// Tool-call orphan repair (STEAL 2026-06-12 cluster A; odysseus
// src/context_compactor.py _sanitize_tool_messages, two-pass).
//
// OpenAI-format providers reject (HTTP 400) message arrays where:
//   - a role:'tool' result has no preceding assistant tool_calls parent
//     carrying its tool_call_id (the parent was trimmed away), or
//   - an assistant message advertises tool_calls whose responses are missing
//     (the results were trimmed away).
// Any history trimming or compaction that cuts mid-exchange produces exactly
// these states. Run this AFTER any trim and BEFORE sending to a provider:
// intact arrays pass through value-equal; broken ones become protocol-legal.

export interface ToolCallish {
  id: string
  [k: string]: unknown
}

export interface ToolishMessage {
  role: string
  content?: unknown
  tool_calls?: ToolCallish[]
  tool_call_id?: string
  [k: string]: unknown
}

export function repairToolMessages<T extends ToolishMessage>(messages: T[]): T[] {
  // Pass 1: drop orphaned tool results — a result is valid only if its
  // tool_call_id was advertised by an EARLIER surviving assistant message.
  const advertised = new Set<string>()
  const pass1: T[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      if (typeof m.tool_call_id === 'string' && advertised.has(m.tool_call_id)) pass1.push(m)
      continue // orphan: parent gone (or result precedes parent) — drop
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc && typeof tc.id === 'string') advertised.add(tc.id)
    }
    pass1.push(m)
  }

  // Pass 2: de-arm dangling tool_calls — keep only ids that have a LATER
  // tool result in the surviving array; strip empty tool_calls; drop
  // assistant messages left with neither content nor calls.
  const answered = new Set<string>()
  for (const m of pass1) {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') answered.add(m.tool_call_id)
  }
  const out: T[] = []
  for (const m of pass1) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) { out.push(m); continue }
    const kept = m.tool_calls.filter(tc => tc && typeof tc.id === 'string' && answered.has(tc.id))
    if (kept.length === m.tool_calls.length) { out.push(m); continue }
    const hasContent = typeof m.content === 'string' ? m.content.length > 0 : m.content != null
    if (kept.length === 0 && !hasContent) continue // nothing left to say — drop
    const repaired = { ...m }
    if (kept.length > 0) repaired.tool_calls = kept
    else delete repaired.tool_calls
    out.push(repaired)
  }
  return out
}
