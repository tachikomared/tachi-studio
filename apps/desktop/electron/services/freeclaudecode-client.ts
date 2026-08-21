// apps/desktop/electron/services/freeclaudecode-client.ts
import { ChatChunk, ChatRequest } from '@tachi/core'
import { randomUUID } from 'crypto'
import { getFreeClaudeCodeToken } from './sidecar-manager'
import { readOrIdleAbort } from './stream-idle'

/**
 * Stream a chat completion from the local free-claude-code sidecar.
 * Yields ChatChunk events (start → delta* → usage? → done | error).
 *
 * free-claude-code exposes an Anthropic Messages API shape at /v1/messages,
 * not OpenAI chat-completions. We parse Anthropic SSE events accordingly:
 *   message_start         → start
 *   content_block_delta   → delta
 *   message_delta (usage) → usage
 */
export async function* streamFromFreeClaudeCode(
  request: ChatRequest,
  systemMessage: string | undefined,
  signal: AbortSignal,
  port: number,
): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()

  // Anthropic shape: messages array + top-level system + model
  const body: Record<string, unknown> = {
    model:      request.model,
    messages:   request.messages.map(m => ({ role: m.role, content: m.content })),
    stream:     true,
    max_tokens: 4096,
  }
  if (systemMessage) body.system = systemMessage

  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         getFreeClaudeCodeToken(),
        'anthropic-version': '2023-06-01',
      },
      body:   JSON.stringify(body),
      signal,
    })
  } catch {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: { code: 'NETWORK_ERROR', message: 'Could not connect to free-claude-code.' } }
    yield { type: 'done', messageId }
    return
  }

  if (!res.ok) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: { code: `HTTP_${res.status}`, message: `free-claude-code returned HTTP ${res.status}` } }
    yield { type: 'done', messageId }
    return
  }

  // Parse Anthropic SSE format:
  //   event: content_block_delta
  //   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
  const reader = res.body?.getReader()
  if (!reader) {
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: { code: 'MALFORMED_SSE', message: 'Empty response body' } }
    yield { type: 'done', messageId }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let startYielded = false
  let actualModel = request.model

  // On idle stall, cancel the reader — terminates the hung body stream so the
  // catch below yields a visible error instead of an infinite spinner.
  const stallCancel = { abort: () => { void reader.cancel().catch(() => { /* already dead */ }) } }

  try {
    while (true) {
      if (signal.aborted) break
      const { done, value } = await readOrIdleAbort(() => reader.read(), stallCancel)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'message_start' && parsed.message?.model) {
            actualModel = parsed.message.model
            yield { type: 'start', messageId, model: actualModel }
            startYielded = true
          }
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            if (!startYielded) { yield { type: 'start', messageId, model: actualModel }; startYielded = true }
            yield { type: 'delta', messageId, text: parsed.delta.text ?? '' }
          }
          if (parsed.type === 'message_delta' && parsed.usage) {
            yield {
              type: 'usage', messageId,
              usage: {
                promptTokens:     parsed.usage.input_tokens  ?? 0,
                completionTokens: parsed.usage.output_tokens ?? 0,
                totalTokens:      (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
              },
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } catch {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: { code: 'MALFORMED_SSE', message: 'Stream parse failed' } }
  } finally {
    if (!startYielded) yield { type: 'start', messageId, model: request.model }
    yield { type: 'done', messageId }
  }
}
