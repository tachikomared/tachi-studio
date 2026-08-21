import type { AgentEvent } from './types.js'

/**
 * Parse a single NDJSON line from darksol's `agent harness run --stream-json`
 * stdout into zero or more AgentEvent objects.
 *
 * darksol-terminal (GPL-3.0, @darksol/terminal) drives its agent through a
 * harness that records events as newline-delimited JSON. Each line is one
 * object of the shape (verified against darks0l/darksol-terminal
 * src/agent/harness.js recordHarnessEvent):
 *
 *   { timestamp: <ISO 8601 string>, type: 'run-start' | 'progress' | 'tool' | 'run-final', ... }
 *
 * Mapping to TachiDesk's AgentEvent:
 *   run-start  → []           (lifecycle marker; not renderable)
 *   progress   → text         (the agent's reasoning / status text)
 *   tool start → tool-call    (name + JSON-stringified input)
 *   tool result→ tool-done    (name + stringified output)
 *   run-final  → done         (status 'success') | error (status 'failed')
 *
 * harness.js wraps progress/tool payloads as a nested `event` object whose
 * inner field names are produced by downstream callbacks (onToolEvent, the
 * progress emitter) and are NOT pinned in harness.js itself. So — tolerating
 * both toolCallId/tool_call_id and rawInput/raw_input — this
 * mapper reads from both the flat object AND the nested `event`, and accepts
 * field-name variants (name/tool, input/args/params, output/result, phase/status).
 * Confirm the exact framing against a recorded --stream-json fixture at wiring
 * time (integration-plan §9 open item); the variant fallbacks make the mapper
 * correct for either the flat or the nested shape.
 *
 * Returns [] for unknown/ignored types and for malformed JSON.
 */
export function parseDarksolEvent(raw: string): AgentEvent[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (typeof parsed !== 'object' || parsed === null) return []
  const msg = parsed as Record<string, unknown>

  const type = msg.type as string | undefined
  // The renderable payload may live flat on the line or nested under `event`.
  const inner = (typeof msg.event === 'object' && msg.event !== null)
    ? { ...(msg.event as Record<string, unknown>), ...stripWrapper(msg) }
    : msg

  switch (type) {
    case 'run-start':
      return []

    case 'progress': {
      const text = pickString(inner, ['text', 'message', 'content', 'delta'])
      return text ? [{ type: 'text', text }] : []
    }

    case 'tool': {
      const name = pickString(inner, ['name', 'tool', 'toolName', 'title']) ?? 'tool'
      // Result phase: phase==='result'|'done'|'end', or a status of done/result,
      // or the presence of an output/result field. Otherwise treat as invocation.
      const phase  = pickString(inner, ['phase', 'status', 'state'])
      const hasOut  = inner.output !== undefined || inner.result !== undefined
      const isResult = hasOut
        || phase === 'result' || phase === 'done' || phase === 'end' || phase === 'success' || phase === 'error'
      if (isResult) {
        const output = inner.output ?? inner.result
        return [{ type: 'tool-done', name, output: output !== undefined ? JSON.stringify(output) : '' }]
      }
      const input = inner.input ?? inner.args ?? inner.params ?? inner.arguments
      return [{ type: 'tool-call', name, input: input !== undefined ? JSON.stringify(input) : '' }]
    }

    case 'run-final': {
      const status     = pickString(msg, ['status'])
      const stopReason = pickString(msg, ['stopReason', 'stop_reason']) ?? 'stop'
      const finalText  = pickString(msg, ['final', 'message', 'error'])
      if (status === 'failed' || status === 'error') {
        return [{ type: 'error', message: finalText ?? stopReason }]
      }
      return [{ type: 'done', reason: stopReason }]
    }

    default:
      return []
  }
}

/** Drop the envelope keys so a nested `event` merge doesn't reintroduce them. */
function stripWrapper(msg: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, timestamp: _ts, event: _e, ...rest } = msg
  return rest
}

/** First key in `keys` whose value on `obj` is a non-empty string. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
