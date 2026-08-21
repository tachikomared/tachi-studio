// apps/desktop/electron/services/tachi/wire.ts
//
// Wire-level request shaping for TACHI's OpenAI-compatible provider. Pure (no
// electron, no app deps) so it is unit-testable and shareable with the live
// smoke test. Currently: force single (non-parallel) tool calls.
//
// Why: a live run against a gateway-routed model (NVIDIA-NIM Llama 3.1 70B via
// freellmapi) failed with "This model only supports single tool-calls at once"
// when the model emitted parallel tool calls. The OpenAI-compatible chat
// options schema exposes no parallelToolCalls knob, so we inject
// `parallel_tool_calls: false` into the chat/completions body. A coding loop
// wants sequential calls anyway (each tool result informs the next); backends
// that don't recognise the field ignore it.

/** Wrap a fetch so chat/completions requests with tools force parallel_tool_calls:false. */
export function singleToolCallFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('"tools"')) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        if (Array.isArray(body.tools) && body.tools.length > 0 && body.parallel_tool_calls === undefined) {
          body.parallel_tool_calls = false
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch { /* non-JSON body — leave untouched */ }
    }
    return base(input as RequestInfo, init)
  }
}

// ── Streamed tool_calls index normalization (dogfood crash 2026-07-24) ───────
//
// Gateways sometimes stream `choices[].delta.tool_calls[]` entries with a
// missing or non-contiguous `index` (the exact bug class Ollama is famous for —
// ollama#7881). The AI-SDK's tool-call assembler places deltas into an array BY
// INDEX, so a hole produces a SPARSE array and its flush() crashes with
// "Cannot read properties of undefined (reading 'hasFinished')" — which killed
// every tool-calling TACHI run on Bankr. We repair the stream at the wire:
// every provider index is REMAPPED to a dense local index (first-seen order);
// missing indices resolve by tool-call id, else stick to the last call.
// Non-tool lines (and anything unparseable) pass through byte-identical.

interface SseToolCallDelta {
  index?: number
  id?: string
  [k: string]: unknown
}

/** Per-response line transformer. Feed complete SSE lines; returns the
 *  (possibly rewritten) line. Stateful — create one per response. */
export function createSseToolCallIndexNormalizer(): (line: string) => string {
  const providerToDense = new Map<string, number>()
  let nextDense = 0
  let lastDense = 0
  return (line: string): string => {
    if (!line.startsWith('data:')) return line
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return line
    try {
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { tool_calls?: SseToolCallDelta[] } }> }
      let changed = false
      for (const choice of obj.choices ?? []) {
        const calls = choice?.delta?.tool_calls
        if (!Array.isArray(calls)) continue
        for (const tc of calls) {
          // Key: provider index when present, else the call id, else "the
          // current call" (continuation chunks often carry neither).
          const key = typeof tc.index === 'number' ? `i:${tc.index}` : (typeof tc.id === 'string' && tc.id ? `id:${tc.id}` : null)
          let dense: number
          if (key !== null && providerToDense.has(key)) {
            dense = providerToDense.get(key)!
          } else if (key !== null) {
            // New call — also cross-register by id so later id-only chunks match.
            dense = nextDense++
            providerToDense.set(key, dense)
            if (typeof tc.index === 'number' && typeof tc.id === 'string' && tc.id) providerToDense.set(`id:${tc.id}`, dense)
          } else {
            dense = lastDense
          }
          if (tc.index !== dense) { tc.index = dense; changed = true }
          lastDense = dense
        }
      }
      return changed ? `data: ${JSON.stringify(obj)}` : line
    } catch {
      return line // partial/malformed JSON — never break the stream
    }
  }
}

/** Wrap a fetch so text/event-stream responses get their streamed tool_calls
 *  indices normalized (dense, hole-free) before the SDK assembler sees them. */
export function toolCallIndexFixFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input as RequestInfo, init)
    const ctype = res.headers.get('content-type') ?? ''
    if (!res.body || !ctype.includes('text/event-stream')) return res
    const normalize = createSseToolCallIndexNormalizer()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = ''
    const transformed = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) controller.enqueue(encoder.encode(`${normalize(line)}\n`))
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(normalize(buffer)))
      },
    }))
    return new Response(transformed, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}
