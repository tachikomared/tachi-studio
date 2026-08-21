// apps/desktop/electron/services/api-messages-translate.ts
//
// Pure translators between the Anthropic Messages API shape and the OpenAI
// chat-completions shape, powering POST /v1/messages on the local API server
// (openai-api-server.ts). Tools like Claude Code can then point their
// ANTHROPIC_BASE_URL at Tachi Studio — LM Studio parity.
//
// Kept free of electron/node imports so test/unit can exercise it directly
// (same pattern as util/api-route.ts). Three surfaces:
//   - anthropicToOpenAiRequest   Anthropic request  → OpenAI chat request
//   - openAiToAnthropicResponse  OpenAI response    → Anthropic message
//   - OpenAiToAnthropicStream    OpenAI SSE deltas  → Anthropic event stream
//
// Translation is deliberately text-only: image blocks are dropped with an
// "[image omitted]" note, tool_use/tool_result blocks are rejected (the local
// engines never advertise tools, so a well-behaved client never sends them),
// and a top-level `tools` declaration is silently dropped — the model simply
// answers in prose, which keeps chat-only clients working.

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAiChatRequest {
  model: string
  messages: OpenAiChatMessage[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  stop?: string[]
}

/** The subset of an OpenAI chat-completions response we translate. */
export interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** One parsed OpenAI streaming chunk (a `data:` payload). */
export interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export type AnthropicStopReason = 'end_turn' | 'max_tokens'

export interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<{ type: 'text'; text: string }>
  model: string
  stop_reason: AnthropicStopReason
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

export type TranslateRequestResult =
  | { ok: true; request: OpenAiChatRequest }
  | { ok: false; status: number; errorType: string; message: string }

/** Anthropic-shaped error body ({ type:'error', error:{ type, message } }). */
export function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } })
}

// ── Request translation ───────────────────────────────────────────────────────

const IMAGE_NOTE = '[image omitted]'

function invalid(message: string): TranslateRequestResult {
  return { ok: false, status: 400, errorType: 'invalid_request_error', message }
}

type JoinResult = { ok: true; text: string } | { ok: false; message: string }

/**
 * Flatten Anthropic content (string | block array) into one plain string.
 * Text blocks join with blank lines; images become an "[image omitted]" note;
 * tool blocks are a hard error; unknown block types are skipped leniently.
 */
function joinContent(content: unknown, where: string): JoinResult {
  if (typeof content === 'string') return { ok: true, text: content }
  if (!Array.isArray(content)) {
    return { ok: false, message: `${where} content must be a string or an array of content blocks` }
  }
  const parts: string[] = []
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown }
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(IMAGE_NOTE)
        break
      case 'tool_use':
      case 'tool_result':
        return {
          ok: false,
          message: `content blocks of type "${block.type}" are not supported — this local endpoint is a text-only translation and never advertises tools`,
        }
      default:
        // thinking / redacted_thinking / future block kinds — drop leniently.
        break
    }
  }
  return { ok: true, text: parts.join('\n\n') }
}

/**
 * Anthropic Messages request → OpenAI chat request. `system` (string or text
 * blocks) becomes a leading system message; per-message blocks are flattened
 * via joinContent. Unsupported inputs return a 400-style error object instead
 * of throwing, so the server can wrap them in the Anthropic error envelope.
 */
export function anthropicToOpenAiRequest(body: unknown): TranslateRequestResult {
  const b = body as {
    model?: unknown
    system?: unknown
    messages?: unknown
    max_tokens?: unknown
    stream?: unknown
    temperature?: unknown
    top_p?: unknown
    stop_sequences?: unknown
  }
  if (!b || typeof b !== 'object') return invalid('request body must be a JSON object')
  if (typeof b.model !== 'string' || !b.model.trim()) return invalid('`model` is required')
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return invalid('`messages` must be a non-empty array')
  }

  const messages: OpenAiChatMessage[] = []

  if (b.system !== undefined && b.system !== null) {
    const joined = joinContent(b.system, '`system`')
    if (!joined.ok) return invalid(joined.message)
    if (joined.text) messages.push({ role: 'system', content: joined.text })
  }

  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as { role?: unknown; content?: unknown }
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      return invalid(`messages[${i}].role must be "user" or "assistant"`)
    }
    const joined = joinContent(m.content, `messages[${i}]`)
    if (!joined.ok) return invalid(joined.message)
    messages.push({ role: m.role, content: joined.text })
  }

  const request: OpenAiChatRequest = { model: b.model, messages }
  if (typeof b.max_tokens === 'number' && b.max_tokens > 0) request.max_tokens = b.max_tokens
  if (typeof b.stream === 'boolean') request.stream = b.stream
  if (typeof b.temperature === 'number') request.temperature = b.temperature
  if (typeof b.top_p === 'number') request.top_p = b.top_p
  if (Array.isArray(b.stop_sequences)) {
    const stops = b.stop_sequences.filter((s): s is string => typeof s === 'string')
    if (stops.length) request.stop = stops
  }
  return { ok: true, request }
}

// ── Response translation ──────────────────────────────────────────────────────

function mapStopReason(finishReason: string | null | undefined): AnthropicStopReason {
  // OpenAI 'length' is the only cap signal; everything else ('stop',
  // 'content_filter', null, …) reads as a natural end to an Anthropic client.
  return finishReason === 'length' ? 'max_tokens' : 'end_turn'
}

function newMessageId(): string {
  return `msg_local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** OpenAI chat response → Anthropic Messages response (non-streaming path). */
export function openAiToAnthropicResponse(resp: OpenAiChatResponse, model: string): AnthropicMessageResponse {
  const choice = resp?.choices?.[0]
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  return {
    id: newMessageId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof resp?.usage?.prompt_tokens === 'number' ? resp.usage.prompt_tokens : 0,
      output_tokens: typeof resp?.usage?.completion_tokens === 'number' ? resp.usage.completion_tokens : 0,
    },
  }
}

// ── Stream translation ────────────────────────────────────────────────────────

/** One Anthropic SSE event; the `type` field doubles as the `event:` name. */
export type AnthropicStreamEvent = { type: string } & Record<string, unknown>

/** Serialize one event as an Anthropic-protocol SSE frame. */
export function formatSseEvent(ev: AnthropicStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/**
 * Stateful OpenAI-SSE → Anthropic-events translator. Feed it raw upstream SSE
 * text (any chunking — it buffers partial lines) via pushSse, or parsed chunks
 * via pushChunk; call finish() once the upstream ends. Emits the canonical
 * sequence: message_start → content_block_start → content_block_delta ×N →
 * content_block_stop → message_delta(stop_reason) → message_stop.
 */
export class OpenAiToAnthropicStream {
  private readonly id = newMessageId()
  private buffer = ''
  private started = false
  private closed = false
  private deltaCount = 0
  private inputTokens = 0
  private outputTokens: number | null = null
  private stopReason: AnthropicStopReason = 'end_turn'

  constructor(private readonly model: string) {}

  /** Feed raw SSE text from the upstream; returns the events it produced. */
  pushSse(text: string): AnthropicStreamEvent[] {
    if (this.closed) return []
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? '' // last element is a partial line (or '')
    const events: AnthropicStreamEvent[] = []
    for (const line of lines) {
      if (!line.startsWith('data:')) continue // event:/comment/blank lines
      const payload = line.slice('data:'.length).trim()
      if (payload === '[DONE]') {
        events.push(...this.finish())
        break
      }
      try {
        events.push(...this.pushChunk(JSON.parse(payload) as OpenAiStreamChunk))
      } catch { /* malformed data line — skip it, keep the stream alive */ }
    }
    return events
  }

  /** Feed one parsed OpenAI chunk; returns the events it produced. */
  pushChunk(chunk: OpenAiStreamChunk): AnthropicStreamEvent[] {
    if (this.closed) return []
    const events: AnthropicStreamEvent[] = this.started ? [] : this.open()

    if (typeof chunk?.usage?.prompt_tokens === 'number') this.inputTokens = chunk.usage.prompt_tokens
    if (typeof chunk?.usage?.completion_tokens === 'number') this.outputTokens = chunk.usage.completion_tokens

    const choice = chunk?.choices?.[0]
    const text = choice?.delta?.content
    if (typeof text === 'string' && text.length > 0) {
      this.deltaCount++
      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
    }
    // Remember the stop reason but don't close yet — some upstreams send a
    // trailing usage-only chunk after finish_reason; [DONE]/finish() closes.
    if (choice?.finish_reason) this.stopReason = mapStopReason(choice.finish_reason)
    return events
  }

  /** Flush the closing events. Idempotent — safe to call after [DONE]. */
  finish(): AnthropicStreamEvent[] {
    if (this.closed) return []
    this.closed = true
    // An upstream that died before any chunk still gets a valid sequence.
    const events: AnthropicStreamEvent[] = this.started ? [] : this.open()
    events.push(
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        // Real token counts when the upstream reported usage; otherwise the
        // delta count is an honest floor (≥1 token per delta).
        usage: { output_tokens: this.outputTokens ?? this.deltaCount },
      },
      { type: 'message_stop' },
    )
    return events
  }

  private open(): AnthropicStreamEvent[] {
    this.started = true
    return [
      {
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ]
  }
}
