// apps/desktop/electron/services/local-chat-backends.ts
//
// LOCAL panel legs for Fusion / COMPARE (UX-benchmark #6): thin ChatBackend
// adapters over the SAME streaming machinery the chat forks already use for
// local providers — Ollama's NDJSON /api/chat loop and llama-server's
// OpenAI-compat SSE (streamFromLlamaCpp). No forked protocol code: the llama.cpp
// leg IS streamFromLlamaCpp; the Ollama leg is the chat-service fork's message
// mapping + NDJSON parse, packaged behind the ChatBackend interface so
// runFusion can fan out over cloud + local models in ONE panel.
//
// Panel member ids are namespaced so they can never collide with a gateway
// catalog id:
//   ollama:<model>     → streams from the local Ollama daemon (auto-started)
//   llamacpp:<modelId> → streams from the running llama-server instance
import { randomUUID } from 'crypto'
import type { ChatBackend, ChatChunk, ChatContentPart, ChatMessage, ChatRequest } from '@tachi/core'
import { streamFromLlamaCpp, isLlamaCppRunning } from './llama-cpp-client'

const OLLAMA_PREFIX = 'ollama:'
const LLAMACPP_PREFIX = 'llamacpp:'
const OLLAMA_BASE = 'http://127.0.0.1:11434'
// Hard cap per local leg so one wedged local model can never deadlock the
// whole panel (Promise.allSettled waits for every leg).
const LOCAL_LEG_TIMEOUT_MS = 5 * 60 * 1000

/** True for the namespaced local panel ids (`ollama:` / `llamacpp:`). */
export function isLocalPanelModelId(id: string): boolean {
  return id.startsWith(OLLAMA_PREFIX) || id.startsWith(LLAMACPP_PREFIX)
}

function stripDataPrefix(b64: string): string {
  const i = b64.indexOf(';base64,')
  return i >= 0 ? b64.slice(i + ';base64,'.length) : b64
}

// Ollama's /api/chat does NOT speak OpenAI-style content-parts: images go in a
// top-level `images: string[]` (raw base64), text-like files are inlined.
// Same mapping as the chat-service ollama fork, applied per message.
interface OllamaMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: string[]
}

function toOllamaMessage(msg: ChatMessage): OllamaMessage {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content }
  }
  const textChunks: string[] = []
  const images: string[] = []
  for (const part of msg.content as ChatContentPart[]) {
    if (part.type === 'text') {
      textChunks.push(part.text)
    } else if (part.type === 'image') {
      images.push(stripDataPrefix(part.data))
    } else if (part.type === 'file') {
      const isTextLike =
        part.mimeType.startsWith('text/') ||
        /^application\/(json|xml|x-yaml|javascript|typescript|sql|toml|x-sh|x-shellscript)$/.test(part.mimeType) ||
        /\.(md|txt|html?|css|js|jsx|ts|tsx|json|yaml|yml|xml|csv|toml|ini|conf|sh|py|rb|go|rs|java|c|cpp|h|hpp)$/i.test(part.filename)
      if (isTextLike) {
        try {
          const decoded = Buffer.from(stripDataPrefix(part.data), 'base64').toString('utf8')
          textChunks.push(`Attached file \`${part.filename}\` (${part.mimeType}):\n\`\`\`\n${decoded}\n\`\`\``)
        } catch {
          textChunks.push(`[Attached file ${part.filename} — could not decode]`)
        }
      } else {
        textChunks.push(`[Attached binary file ${part.filename} (${part.mimeType}) — local models cannot read binary attachments here]`)
      }
    }
  }
  const out: OllamaMessage = { role: msg.role, content: textChunks.join('\n\n') }
  if (images.length > 0) out.images = images
  return out
}

/**
 * Stream one Ollama chat completion as ChatChunks (start → deltas → usage →
 * done, or an error chunk with a friendly message). Auto-starts the Ollama
 * daemon the same way the chat fork does (zero-terminal).
 */
async function* streamFromOllama(request: ChatRequest): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()
  const model = request.model

  try {
    const { ensureOllamaRunning } = await import('./ollama-service')
    await ensureOllamaRunning()
  } catch (err) {
    yield { type: 'start', messageId, model }
    yield { type: 'error', messageId, error: { code: 'OLLAMA_OFFLINE', message: err instanceof Error ? err.message : String(err) } }
    yield { type: 'done', messageId }
    return
  }

  let res: Response
  try {
    res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: request.messages.map(toOllamaMessage), stream: true }),
      // Same cast idiom as llama-cpp-client's health probe (fetch RequestInit typing).
      signal: AbortSignal.timeout(LOCAL_LEG_TIMEOUT_MS) as AbortSignal,
    })
  } catch (err) {
    yield { type: 'start', messageId, model }
    yield { type: 'error', messageId, error: { code: 'NETWORK_ERROR', message: `Could not connect to Ollama: ${err instanceof Error ? err.message : String(err)}` } }
    yield { type: 'done', messageId }
    return
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    yield { type: 'start', messageId, model }
    yield { type: 'error', messageId, error: { code: `HTTP_${res.status}`, message: `Ollama error (${res.status}): ${body.slice(0, 200)}` } }
    yield { type: 'done', messageId }
    return
  }

  yield { type: 'start', messageId, model }
  const reader = res.body?.getReader()
  if (!reader) {
    yield { type: 'error', messageId, error: { code: 'NO_BODY', message: 'Ollama returned no response body.' } }
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
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as {
            message?: { content?: string }
            done?: boolean
            prompt_eval_count?: number
            eval_count?: number
          }
          const delta = parsed.message?.content
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'delta', messageId, text: delta }
          }
          if (parsed.done && (parsed.prompt_eval_count != null || parsed.eval_count != null)) {
            const promptTokens = parsed.prompt_eval_count ?? 0
            const completionTokens = parsed.eval_count ?? 0
            yield { type: 'usage', messageId, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } }
          }
        } catch { /* skip malformed NDJSON lines */ }
      }
    }
  } catch (err) {
    yield { type: 'error', messageId, error: { code: 'STREAM_ERROR', message: `Ollama stream failed: ${err instanceof Error ? err.message : String(err)}` } }
  }
  yield { type: 'done', messageId }
}

/** llama.cpp leg — delegates to the exact stream chat itself uses. */
async function* streamLlamaCppLeg(request: ChatRequest): AsyncIterable<ChatChunk> {
  if (!isLlamaCppRunning()) {
    const messageId = randomUUID()
    yield { type: 'start', messageId, model: request.model }
    yield { type: 'error', messageId, error: { code: 'NO_PROVIDER', message: 'llama.cpp is not running. Start a model from the panel picker or Status → llama.cpp.' } }
    yield { type: 'done', messageId }
    return
  }
  // The system prompt (if any) is already the first message in request.messages
  // (runFusion builds panels that way), so no separate systemMessage arg.
  yield* streamFromLlamaCpp(request, undefined, AbortSignal.timeout(LOCAL_LEG_TIMEOUT_MS) as AbortSignal)
}

/**
 * Wrap a (possibly absent) cloud ChatBackend with local routing: panel legs
 * whose model id is `ollama:*` / `llamacpp:*` stream from the local engines;
 * everything else goes to the cloud backend unchanged. When there is no cloud
 * backend (no API key) a cloud leg fails soft with a friendly error chunk —
 * a fully-local COMPARE panel still works keyless.
 */
export function makeLocalAwareBackend(cloud: ChatBackend | null, providerId: string): ChatBackend {
  return {
    id: cloud?.id ?? `local-panel-${providerId}`,
    displayName: cloud?.displayName ?? 'Local panel',
    sendMessage(request: ChatRequest, apiKey: string): AsyncIterable<ChatChunk> {
      const model = request.model ?? ''
      if (model.startsWith(OLLAMA_PREFIX)) {
        return streamFromOllama({ ...request, model: model.slice(OLLAMA_PREFIX.length) })
      }
      if (model.startsWith(LLAMACPP_PREFIX)) {
        return streamLlamaCppLeg({ ...request, model: model.slice(LLAMACPP_PREFIX.length) })
      }
      if (!cloud) {
        return (async function* (): AsyncIterable<ChatChunk> {
          const messageId = randomUUID()
          yield { type: 'start', messageId, model }
          yield { type: 'error', messageId, error: { code: 'NO_PROVIDER', message: `Add a ${providerId} API key in Settings to include cloud models in the panel.` } }
          yield { type: 'done', messageId }
        })()
      }
      return cloud.sendMessage(request, apiKey)
    },
  }
}
