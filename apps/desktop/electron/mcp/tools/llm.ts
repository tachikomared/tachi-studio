// apps/desktop/electron/mcp/tools/llm.ts
//
// LLM tools for the in-process MCP server. External agents (Claude Desktop,
// Codex, etc.) can route inference through Tachi's locally-configured
// providers — they get the user's free-provider rotation, Bankr / OpenGateway
// gateways, and Ollama without each agent needing its own API keys.
//
// v1 supports two paths:
//   - 'freellmapi' (a.k.a. 'auto') — collapse-stream the local freellmapi
//     sidecar, which already does the multi-provider fallback for us.
//   - 'ollama' — direct call to Ollama's /api/chat (non-streaming) for
//     fully-local models.
//
// Bankr / OpenGateway / direct cloud providers are intentionally NOT exposed
// in v1 — they have their own API keys callers can use directly, and exposing
// them via MCP would leak keys from Tachi's keychain through a third channel.
//
// Concerns (called out in the parent task report):
// - We bypass chat-service's tool-loop wrapper (web search, GitHub tools).
//   That's intentional: an external agent already has its own tool-loop;
//   plumbing ours through MCP would create double-wrapping. If the caller
//   wants web search, they invoke their own tool.
// - PRIVATE MODE gating: llm_complete is gated through checkProviderEgress —
//   freellmapi (cloud-proxying) is denied, ollama (truly local) is allowed.
//   llm_list_providers still enumerates providers but annotates each entry
//   with `blocked: true` when PRIVATE MODE would refuse llm_complete to it,
//   so external agents can introspect the gate without trial-and-error.

import type { ToolRegistry } from '../registry'
import { streamFromFreellmapi } from '../../services/freellmapi-client'
import { getFreellmapiPort, getFreellmapiApiKey } from '../../services/sidecar-manager'
import { isOllamaRunning, listOllamaModels } from '../../services/ollama-service'
import { checkProviderEgress, classifyProvider } from '../../services/egress-policy'
import { getCurrentPrivacyMode } from '../../ipc/privacy.ipc'

const FREELLMAPI_DEFAULT_MODEL = 'auto'
const OLLAMA_BASE = 'http://127.0.0.1:11434'

type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }

function assertMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error('messages must be an array')
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) throw new Error('each message must be an object')
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Error(`message.role must be one of user|assistant|system (got ${String(role)})`)
    }
    if (typeof content !== 'string') {
      throw new Error('message.content must be a string')
    }
    out.push({ role, content })
  }
  return out
}

export function register(registry: ToolRegistry): void {
  // ── llm_complete ───────────────────────────────────────────────────────────
  registry.set('llm_complete', {
    description:
      'Generate a chat completion via one of Tachi\'s locally-managed providers. '
      + 'Streaming is collapsed to a single final-text response. '
      + 'provider="freellmapi" routes through the free-tier fallback chain (default). '
      + 'provider="ollama" calls a local model.',
    schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['freellmapi', 'ollama'] },
        model:    { type: 'string', description: '"auto" or a specific model id. Defaults: freellmapi=auto, ollama=llama3.' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role:    { type: 'string', enum: ['user', 'assistant', 'system'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
        systemMessage: { type: 'string', description: 'Optional. Prepended as a system message if no system role present.' },
        temperature:   { type: 'number' },
        maxTokens:     { type: 'integer' },
      },
      required: ['messages'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const messages = assertMessages((args as { messages?: unknown })?.messages)
      const provider = ((args as { provider?: unknown })?.provider as string) ?? 'freellmapi'
      const systemMessage = ((args as { systemMessage?: unknown })?.systemMessage as string | undefined)
      const model = ((args as { model?: unknown })?.model as string | undefined)

      // PRIVATE MODE egress gate — only truly-local providers (ollama) are
      // allowed when private. freellmapi proxies cloud and is denied. In
      // 'open' mode this is a no-op.
      const egress = checkProviderEgress(provider)
      if (!egress.allowed) {
        throw new Error(egress.reason)
      }

      if (provider === 'freellmapi') {
        const port = getFreellmapiPort()
        const apiKey = getFreellmapiApiKey()
        if (!port || !apiKey) {
          throw new Error('freellmapi sidecar is not running. Start it from Tachi\'s Status page.')
        }
        // streamFromFreellmapi accepts the @tachi/core ChatRequest shape: an
        // array of messages with role+content. We collapse the stream to
        // a single final text response so external agents see a synchronous
        // tool result.
        const userMsgs = messages.filter(m => m.role !== 'system')
        const sys = systemMessage ?? messages.find(m => m.role === 'system')?.content
        const req = { model: model ?? FREELLMAPI_DEFAULT_MODEL, messages: userMsgs as never[] }
        let text = ''
        let actualModel = req.model
        let usage: unknown = null
        let errorPayload: unknown = null
        for await (const chunk of streamFromFreellmapi(req as never, sys)) {
          if (chunk.type === 'start') actualModel = (chunk as { model?: string }).model ?? actualModel
          else if (chunk.type === 'delta') text += (chunk as { text: string }).text
          else if (chunk.type === 'usage') usage = (chunk as { usage: unknown }).usage
          else if (chunk.type === 'error') { errorPayload = (chunk as { error: unknown }).error }
        }
        if (errorPayload) {
          // Hand the structured error back to the MCP client.
          throw new Error(`llm_complete (freellmapi) failed: ${JSON.stringify(errorPayload)}`)
        }
        return { provider, model: actualModel, text, usage }
      }

      if (provider === 'ollama') {
        const running = await isOllamaRunning().catch(() => false)
        if (!running) throw new Error('Ollama is not running on localhost:11434.')
        const msgs = [...(systemMessage ? [{ role: 'system', content: systemMessage }] : []), ...messages]
        const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model ?? 'llama3',
            messages: msgs,
            stream: false,
            options: {
              ...(typeof (args as { temperature?: unknown })?.temperature === 'number' ? { temperature: (args as { temperature: number }).temperature } : {}),
              ...(typeof (args as { maxTokens?: unknown })?.maxTokens === 'number' ? { num_predict: (args as { maxTokens: number }).maxTokens } : {}),
            },
          }),
        })
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`)
        const body = await res.json() as {
          model: string
          message?: { content?: string }
          eval_count?: number
          prompt_eval_count?: number
        }
        return {
          provider,
          model: body.model,
          text: body.message?.content ?? '',
          usage: {
            promptTokens: body.prompt_eval_count ?? 0,
            completionTokens: body.eval_count ?? 0,
            totalTokens: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
          },
        }
      }

      throw new Error(`unknown provider: ${provider}`)
    },
  })

  // ── llm_list_providers ─────────────────────────────────────────────────────
  registry.set('llm_list_providers', {
    description: 'Report reachability of Tachi\'s locally-managed LLM providers (freellmapi, ollama). When PRIVATE MODE is on, cloud-proxying providers are flagged with `blocked: true`.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const port = getFreellmapiPort()
      const apiKey = getFreellmapiApiKey()
      const freellmapi = {
        id: 'freellmapi',
        running: !!port && !!apiKey,
        port: port ?? null,
      }
      let ollama: { id: string; running: boolean; models: string[] } = { id: 'ollama', running: false, models: [] }
      try {
        const running = await isOllamaRunning()
        if (running) {
          const models = await listOllamaModels()
          ollama = { id: 'ollama', running: true, models: models.map(m => m.name) }
        }
      } catch { /* keep default false */ }
      // Annotate each provider with `blocked` so external agents can see
      // ahead of time whether llm_complete would refuse the call. In 'open'
      // mode, nothing is blocked; in 'private' mode, anything that isn't
      // classified as a truly-local provider is blocked.
      const mode = getCurrentPrivacyMode()
      const providers = [freellmapi, ollama].map(p => ({
        ...p,
        blocked: mode === 'private' && classifyProvider(p.id) !== 'local',
      }))
      return { providers, privacyMode: mode }
    },
  })
}
