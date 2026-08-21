import { ChatBackend, ChatRequest, ChatChunk, ModelInfo, HealthStatus } from '../../chat/backend.js'
import { mapBankrError, MALFORMED_SSE_ERROR, NO_MODEL_ERROR, NO_KEY_ERROR } from './bankr-errors.js'
import { fetchBankrModels } from './bankr-models.js'
import { determineBankrHealth } from './bankr-health.js'
import { randomUUID } from 'crypto'

const BASE_URL = 'https://llm.bankr.bot/v1'

export class BankrProvider implements ChatBackend {
  readonly id = 'bankr'
  readonly displayName = 'Bankr Gateway'

  // Key is passed at call time — never stored on instance
  async *sendMessage(request: ChatRequest, apiKey: string): AsyncIterable<ChatChunk> {
    const messageId = randomUUID()

    if (!apiKey) {
      yield { type: 'error', messageId, error: NO_KEY_ERROR }
      return
    }
    if (!request.model) {
      yield { type: 'error', messageId, error: NO_MODEL_ERROR }
      return
    }

    yield { type: 'start', messageId, model: request.model }

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
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
      yield { type: 'error', messageId, error: mapBankrError(0) }
      yield { type: 'done', messageId }
      return
    }

    if (!res.ok) {
      yield { type: 'error', messageId, error: mapBankrError(res.status) }
      yield { type: 'done', messageId }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: 'error', messageId, error: MALFORMED_SSE_ERROR }
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
            const delta = parsed.choices?.[0]?.delta?.content
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
      yield { type: 'error', messageId, error: MALFORMED_SSE_ERROR }
    } finally {
      yield { type: 'done', messageId }
    }
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    return fetchBankrModels(apiKey)
  }

  async healthCheck(apiKey: string): Promise<HealthStatus> {
    return determineBankrHealth(apiKey)
  }
}
