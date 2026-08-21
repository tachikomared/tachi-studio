// apps/desktop/electron/services/model-capability-probe.ts
//
// Two-gate model admission probe (STEAL 2026-06-12 cluster E;
// free-coding-models src/core/sync-set.js probeModel pattern).
//
// Gate 1 (text):  "Reply with exactly OK" — proves the chat endpoint + model
//                 id actually complete (a 200 on GET /v1/models does NOT).
// Gate 2 (tools): a minimal echo tool with an instruction to call it — proves
//                 the model emits OpenAI-shape tool_calls. Models that pass
//                 text but fail tools are 'chat-only': fine for chat, silently
//                 broken for agentic nodes/router tool work.
//
// Pure given fetchImpl (injected for tests). Callers resolve baseUrl/key —
// see provider:probe-model in providers.ipc.ts. Cheap by design (~30 output
// tokens total, temperature 0), but it DOES spend a trivial amount of quota,
// so it is on-demand, never an automatic sweep.

export interface ModelProbeOptions {
  /** OpenAI-compatible base, e.g. https://api.x.ai/v1 (no trailing slash). */
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface ModelProbeResult {
  textOk: boolean
  toolsOk: boolean
  verdict: 'full' | 'chat-only' | 'unusable'
  detail?: string
}

const ECHO_TOOL = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
}

async function chatCall(
  opts: ModelProbeOptions,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; json: unknown; detail?: string }> {
  const f = opts.fetchImpl ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('probe timeout')), opts.timeoutMs ?? 20_000)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
    const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.model, temperature: 0, ...body }),
      signal: ctrl.signal as AbortSignal,
    })
    if (!res.ok) return { ok: false, json: null, detail: `HTTP ${res.status}` }
    try { return { ok: true, json: await res.json() } }
    catch { return { ok: true, json: null, detail: 'non-JSON body' } }
  } catch (e) {
    return { ok: false, json: null, detail: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

function firstMessage(json: unknown): { content?: unknown; tool_calls?: unknown[] } | null {
  const m = (json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown[] } }> } | null)
    ?.choices?.[0]?.message
  return m ?? null
}

export async function probeModelCapability(opts: ModelProbeOptions): Promise<ModelProbeResult> {
  // Gate 1: plain text.
  const text = await chatCall(opts, {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 8,
  })
  const textContent = firstMessage(text.json)?.content
  const textOk = text.ok && typeof textContent === 'string' && /\bok\b/i.test(textContent)
  if (!textOk) {
    return { textOk: false, toolsOk: false, verdict: 'unusable', detail: text.detail ?? 'no OK completion' }
  }

  // Gate 2: minimal tool call.
  const tools = await chatCall(opts, {
    messages: [{ role: 'user', content: "Call the echo tool with text='hi'. Do not answer in plain text." }],
    tools: [ECHO_TOOL],
    tool_choice: 'auto',
    max_tokens: 64,
  })
  const calls = firstMessage(tools.json)?.tool_calls
  const toolsOk = tools.ok && Array.isArray(calls) && calls.length > 0

  return {
    textOk: true,
    toolsOk,
    verdict: toolsOk ? 'full' : 'chat-only',
    ...(toolsOk ? {} : { detail: tools.detail ?? 'model answered in text instead of tool_calls' }),
  }
}
