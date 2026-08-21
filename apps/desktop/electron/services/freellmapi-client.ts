// apps/desktop/electron/services/freellmapi-client.ts
import { ChatChunk, ChatRequest, ChatContentPart, profiledIdleMs, extractReasoningDelta, createThinkWrapper } from '@tachi/core'
import { randomUUID } from 'crypto'
import { getFreellmapiPort, getFreellmapiApiKey } from './sidecar-manager'
import { readOrIdleAbort, STREAM_IDLE_TIMEOUT_MS } from './stream-idle'

const NOT_RUNNING = {
  code: 'FREELLMAPI_NOT_RUNNING',
  message: 'freellmapi is not running. Open Status to start it.',
}
const NETWORK_ERROR = {
  code: 'NETWORK_ERROR',
  message: 'Could not connect to freellmapi.',
}
const MALFORMED_SSE = {
  code: 'MALFORMED_SSE',
  message: 'Received malformed response from freellmapi.',
}

/**
 * Stream a chat completion from the local freellmapi sidecar.
 * Yields ChatChunk events (start → delta* → usage? → done | error).
 *
 * The 'start' chunk is delayed until the first SSE data frame arrives so
 * we can populate it with the actual model name returned by freellmapi
 * (which may differ from the requested model, e.g. a provider-specific id).
 */
export async function* streamFromFreellmapi(
  request: ChatRequest,
  systemMessage?: string,
  signal?: AbortSignal,
  /** Per-chat sampler (T19): resolved temperature/top_p, or omitted for BALANCED. */
  sampler?: { temperature?: number; top_p?: number },
): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()

  const port   = getFreellmapiPort()
  const apiKey = getFreellmapiApiKey()
  if (!port || !apiKey) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: NOT_RUNNING }
    yield { type: 'done', messageId }
    return
  }

  const rawMessages = systemMessage
    ? [{ role: 'system' as const, content: systemMessage }, ...request.messages]
    : request.messages

  // Build OpenAI-spec messages — convert content-parts when present
  const messages = rawMessages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    // Multi-part content: map to OpenAI vision/file format
    return {
      role: m.role,
      content: (m.content as ChatContentPart[]).map(p => {
        if (p.type === 'text')  return { type: 'text', text: p.text }
        if (p.type === 'image') return { type: 'image_url', image_url: { url: p.data } }
        // Inline file as plain text (base64 decode the payload)
        if (p.type === 'file') {
          try {
            const b64 = p.data.split(',')[1] ?? p.data
            const decoded = Buffer.from(b64, 'base64').toString('utf8')
            return { type: 'text', text: `--- ${p.filename} ---\n${decoded}` }
          } catch {
            return { type: 'text', text: `--- ${p.filename} ---\n(binary file, cannot inline)` }
          }
        }
        return { type: 'text', text: '' }
      }),
    }
  })

  const bodyPayload: Record<string, unknown> = { model: request.model, messages, stream: true }
  if (request.tools) bodyPayload.tools = request.tools
  if (request.tool_choice) bodyPayload.tool_choice = request.tool_choice
  // Per-chat sampler (T19): only present for non-BALANCED presets.
  if (sampler?.temperature !== undefined) bodyPayload.temperature = sampler.temperature
  if (sampler?.top_p !== undefined) bodyPayload.top_p = sampler.top_p

  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:    JSON.stringify(bodyPayload),
      signal,
    })
  } catch {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: NETWORK_ERROR }
    yield { type: 'done', messageId }
    return
  }

  if (!res.ok) {
    // Read freellmapi's error body so the user can see WHY (no upstream working,
    // 429 cascade, bad API key, etc) rather than just the opaque HTTP code.
    // Body is JSON: { error: { message, type, code } } or sometimes plain text.
    let bodyDetail = ''
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text) as { error?: { message?: string; code?: string; provider?: string } }
        const m = j?.error?.message
        const c = j?.error?.code
        const p = j?.error?.provider
        bodyDetail = [m && `${m}`, c && `code=${c}`, p && `upstream=${p}`].filter(Boolean).join(' · ')
      } catch {
        bodyDetail = text.slice(0, 300)
      }
    } catch { /* ignore */ }
    // 502 specifically usually means "all upstreams in the fallback chain failed
    // (out of credit, 429-throttled, missing key)". Surface that hint so the
    // user knows to check the freellmapi dashboard's fallback chain.
    const hint = res.status === 502
      ? ' — open the freellmapi dashboard (/freellmapi) to inspect the fallback chain and which providers are penalised'
      : ''
    yield { type: 'start', messageId, model: request.model }
    yield {
      type: 'error', messageId,
      error: {
        code: `HTTP_${res.status}`,
        message: `freellmapi returned HTTP ${res.status}${bodyDetail ? ` — ${bodyDetail}` : ''}${hint}`,
      },
    }
    yield { type: 'done', messageId }
    return
  }

  const reader = res.body?.getReader()
  if (!reader) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: MALFORMED_SSE }
    yield { type: 'done', messageId }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  // We hold off yielding 'start' until we know the actual model from the first chunk.
  let startYielded = false
  // Fold separate reasoning field (R1/QwQ) into inline <think>…</think>.
  const think = createThinkWrapper()

  // On idle stall, cancel the reader — terminates the hung body stream so the
  // catch below yields a visible error instead of an infinite spinner.
  const stallCancel = { abort: () => { void reader.cancel().catch(() => { /* already dead */ }) } }

  try {
    while (true) {
      if (signal?.aborted) break
      // Pinned reasoning models (R1/QwQ-class) think silently server-side — give
      // them 3× before declaring the stream stalled ('auto' resolves to 1×).
      const { done, value } = await readOrIdleAbort(() => reader.read(), stallCancel, profiledIdleMs(request.model, STREAM_IDLE_TIMEOUT_MS))
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          const parsed = JSON.parse(data)

          // Yield 'start' on first real SSE chunk so we get the actual model.
          if (!startYielded) {
            const actualModel: string = parsed.model ?? request.model
            yield { type: 'start', messageId, model: actualModel }
            startYielded = true
          }

          // Fold separate reasoning field (R1/QwQ) into inline <think> so the
          // renderer's collapsed-thinking disclosure shows it (STEAL/user-wants).
          const content = parsed.choices?.[0]?.delta?.content
          const reasoning = extractReasoningDelta(parsed)
          const delta = think.next(typeof reasoning === 'string' ? reasoning : undefined, typeof content === 'string' ? content : undefined)
          if (delta) yield { type: 'delta', messageId, text: delta }
          if (parsed.usage) {
            yield {
              type: 'usage', messageId,
              usage: {
                promptTokens:     parsed.usage.prompt_tokens     ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens:      parsed.usage.total_tokens      ?? 0,
              },
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } catch {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: MALFORMED_SSE }
  } finally {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    // Close a still-open <think> block if the stream ended mid-reasoning.
    const tail = think.flush()
    if (tail && startYielded) yield { type: 'delta', messageId, text: tail }
    yield { type: 'done', messageId }
  }
}
