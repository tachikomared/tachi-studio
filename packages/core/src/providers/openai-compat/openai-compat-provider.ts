// Generic OpenAI-compatible ChatBackend. Bankr/Venice/Surplus all speak the same
// /v1/chat/completions SSE wire — the ONLY difference is the base URL. This is the
// BankrProvider body, parameterized by baseUrl, so a single backend serves every
// OpenAI-compat gateway and feeds the provider-agnostic runFusion unchanged.
import { ChatBackend, ChatRequest, ChatChunk, FriendlyProviderError } from '../../chat/backend.js'
import { randomUUID } from 'crypto'

export interface OpenAiCompatConfig {
  id: string
  displayName: string
  /** Base URL WITHOUT a trailing slash or endpoint, e.g. 'https://api.venice.ai/api/v1'. */
  baseUrl: string
}

function httpError(status: number, who: string): FriendlyProviderError {
  if (status === 0) return { code: 'NETWORK_ERROR', message: `Could not reach ${who}.` }
  if (status === 401 || status === 403) return { code: `HTTP_${status}`, message: `${who}: authentication failed — check the API key.` }
  if (status === 429) return { code: 'RATE_LIMITED', message: `${who} is rate limiting — try again shortly.` }
  return { code: `HTTP_${status}`, message: `${who} error (${status}).` }
}

export class OpenAiCompatBackend implements ChatBackend {
  readonly id: string
  readonly displayName: string
  private readonly baseUrl: string

  constructor(cfg: OpenAiCompatConfig) {
    this.id = cfg.id
    this.displayName = cfg.displayName
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
  }

  async *sendMessage(request: ChatRequest, apiKey: string): AsyncIterable<ChatChunk> {
    const messageId = randomUUID()

    if (!apiKey) {
      yield { type: 'error', messageId, error: { code: 'NO_KEY', message: `Add a ${this.displayName} API key in Settings.` } }
      return
    }
    if (!request.model) {
      yield { type: 'error', messageId, error: { code: 'NO_MODEL', message: 'No model specified.' } }
      return
    }

    yield { type: 'start', messageId, model: request.model }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          max_tokens: request.maxTokens,
        }),
      })
    } catch {
      yield { type: 'error', messageId, error: httpError(0, this.displayName) }
      yield { type: 'done', messageId }
      return
    }

    if (!res.ok) {
      yield { type: 'error', messageId, error: httpError(res.status, this.displayName) }
      yield { type: 'done', messageId }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: 'error', messageId, error: { code: 'MALFORMED_SSE', message: 'No response body.' } }
      yield { type: 'done', messageId }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
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
            // Most gateways nest under choices[0].delta.content; some use .text.
            const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.delta?.text
            if (typeof delta === 'string') yield { type: 'delta', messageId, text: delta }
            if (parsed.usage) {
              yield {
                type: 'usage', messageId,
                usage: {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  totalTokens: parsed.usage.total_tokens ?? 0,
                },
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch {
      yield { type: 'error', messageId, error: { code: 'MALFORMED_SSE', message: 'Stream parse error.' } }
    } finally {
      yield { type: 'done', messageId }
    }
  }
}
