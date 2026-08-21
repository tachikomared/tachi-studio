// apps/desktop/electron/services/tool-loop.ts
//
// MVP non-streaming tool-loop:
//   1. Make a non-streaming request with tools attached.
//   2. If the response has no tool_calls, fall back to normal streaming.
//   3. If tool_calls are present, execute them, then make a streaming
//      follow-up request that includes the tool results.
//
// Streaming tool_call delta parsing is NOT attempted here — that requires
// provider-specific reassembly logic and is deferred to a future iteration.

import { ChatChunk, ChatRequest, repairToolMessages } from '@tachi/core'
import { randomUUID } from 'crypto'
import { getFreellmapiPort, getFreellmapiApiKey } from './sidecar-manager'
import { webSearch, WEB_SEARCH_TOOL_SCHEMA } from './web-search-tool'
import { GITHUB_TOOL_SCHEMAS, dispatchGithubTool } from './github-tools'
import { wrapUntrusted } from './prompt-sandbox'

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAIMessage {
  role: string
  content: string | null
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIResponse {
  choices?: Array<{ message: OpenAIMessage; finish_reason?: string }>
}

/**
 * Attempt a non-streaming call and return the full response.
 * Returns null on network error (caller falls back to streaming).
 */
async function nonStreamingCall(
  port: number,
  apiKey: string,
  model: string,
  messages: unknown[],
  tools: unknown[],
): Promise<OpenAIResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: false }),
    })
    if (!res.ok) return null
    return await res.json() as OpenAIResponse
  } catch {
    return null
  }
}

/**
 * One-shot, non-streaming completion via the LOCAL freellmapi sidecar — used by
 * chat-service's phase-2 history compaction to summarize an over-budget span.
 * Best-effort: returns '' on any error so the caller falls back to the
 * un-summarized history. Loopback only, no tools, single user turn.
 */
export async function freellmapiSummarize(model: string, prompt: string): Promise<string> {
  const port = getFreellmapiPort()
  const apiKey = getFreellmapiApiKey()
  if (port === undefined || !apiKey) return ''
  const res = await nonStreamingCall(port, apiKey, model, [{ role: 'user', content: prompt }], [])
  const content = res?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/**
 * Wrap a streaming freellmapi call with one round of web_search tool-calling.
 *
 * Yields ChatChunk events. The messageId used for the final streaming response
 * is the same one yielded in 'start' so the UI can track it normally.
 */
export async function* withWebSearch(
  streamingFn: (req: ChatRequest, sysMsg: string | undefined, signal: AbortSignal) => AsyncIterable<ChatChunk>,
  request: ChatRequest,
  /** OpenAI-format user messages (NO system message — probe prepends it). */
  builtMessages: unknown[],
  webSearchEnabled: boolean,
  signal: AbortSignal,
  systemMessage?: string,
): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()

  if (!webSearchEnabled) {
    // Passthrough: just stream normally
    yield* streamingFn(request, undefined, signal)
    return
  }

  const port   = getFreellmapiPort()
  const apiKey = getFreellmapiApiKey()
  if (!port || !apiKey) {
    // Can't do the non-streaming probe — fall back to normal streaming
    yield* streamingFn(request, undefined, signal)
    return
  }

  // ── Phase 1: non-streaming probe ──────────────────────────────────────────
  // Prepend system message to the probe messages (builtMessages has no system msg).
  const probeMessages = systemMessage
    ? [{ role: 'system', content: systemMessage }, ...builtMessages]
    : builtMessages

  const probe = await nonStreamingCall(
    port, apiKey, request.model,
    probeMessages,
    [WEB_SEARCH_TOOL_SCHEMA],
  )

  if (!probe || !probe.choices?.length) {
    // Probe failed — stream normally
    yield* streamingFn(request, undefined, signal)
    return
  }

  const assistantMsg = probe.choices[0].message
  const toolCalls    = assistantMsg.tool_calls ?? []

  if (toolCalls.length === 0) {
    // Model chose not to use tools.  Stream normally so the user gets a
    // streaming experience rather than a frozen UI for the probe duration.
    yield* streamingFn(request, undefined, signal)
    return
  }

  // ── Phase 2: execute tool calls ───────────────────────────────────────────
  // Emit a 'start' so the UI shows the THINKING indicator while we run searches.
  yield { type: 'start', messageId, model: request.model }

  const followUpMessages: unknown[] = [
    ...builtMessages,
    { role: 'assistant', content: assistantMsg.content ?? '', tool_calls: toolCalls },
  ]

  for (const tc of toolCalls) {
    if (tc.function.name !== 'web_search') continue
    let resultContent: string
    try {
      const args = JSON.parse(tc.function.arguments) as { query: string; count?: number }
      // Emit a placeholder delta so the UI shows "searching…" text
      yield { type: 'delta', messageId, text: `\n[Searching: ${args.query}]\n` }
      const results = await webSearch(args.query, args.count)
      // Prompt-injection sandbox: search snippets are attacker-controllable
      // web content entering the model's context as a tool result.
      resultContent = wrapUntrusted(JSON.stringify(results, null, 2), 'web_search')
    } catch (err) {
      resultContent = `Search failed: ${String(err)}`
    }
    followUpMessages.push({
      role:         'tool',
      content:      resultContent,
      tool_call_id: tc.id,
    })
  }

  if (signal.aborted) {
    yield { type: 'done', messageId }
    return
  }

  // ── Phase 3: streaming follow-up with tool results ────────────────────────
  // Build a follow-up ChatRequest with the augmented messages. Orphan repair
  // (STEAL 2026-06-12, odysseus): a no-op on intact arrays, but guarantees the
  // tool_calls/tool pairs stay protocol-legal if any upstream path ever trims
  // builtMessages mid-exchange (OpenAI-format providers 400 on orphans).
  const followUpRequest: ChatRequest = {
    ...request,
    messages: repairToolMessages(followUpMessages as Array<{ role: string }>) as ChatRequest['messages'],
  }

  // Stream the follow-up.  We suppress the inner 'start' chunk (the outer one
  // was already emitted above) by forwarding everything else.
  let innerStarted = false
  for await (const chunk of streamingFn(followUpRequest, undefined, signal)) {
    if (chunk.type === 'start') {
      // Replace the inner messageId with our outer one so the UI updates the
      // correct bubble.
      if (!innerStarted) {
        innerStarted = true
        // yield a start with the outer messageId already done — skip re-yield
      }
      continue
    }
    // Rewrite messageId so all deltas/usage/done map to the outer bubble.
    if ('messageId' in chunk) {
      yield { ...chunk, messageId } as ChatChunk
    } else {
      yield chunk
    }
  }

  if (!innerStarted) {
    yield { type: 'done', messageId }
  }
}

// ── GitHub tools loop ─────────────────────────────────────────────────────────

/**
 * Wrap a streaming freellmapi call with a GitHub tool-calling loop.
 *
 * When the model requests a GitHub tool call, we execute it and send the
 * result back as a follow-up streaming request.  Works identically to
 * withWebSearch but dispatches to github-tools.ts instead of Brave.
 */
export async function* withGithubTools(
  streamingFn: (req: ChatRequest, sysMsg: string | undefined, signal: AbortSignal) => AsyncIterable<ChatChunk>,
  request: ChatRequest,
  /** OpenAI-format user messages (NO system message — probe prepends it). */
  builtMessages: unknown[],
  signal: AbortSignal,
  systemMessage?: string,
): AsyncIterable<ChatChunk> {
  const messageId = randomUUID()

  const port   = getFreellmapiPort()
  const apiKey = getFreellmapiApiKey()
  if (!port || !apiKey) {
    // No freellmapi available — fall back to streaming without tools.
    // The system message still primes the model to "want" to use tools,
    // so the response will at least be GitHub-context-aware.
    yield* streamingFn(request, undefined, signal)
    return
  }

  // ── Phase 1: non-streaming probe with GitHub tool schemas ─────────────────
  const probeMessages = systemMessage
    ? [{ role: 'system', content: systemMessage }, ...builtMessages]
    : builtMessages

  const probe = await nonStreamingCall(
    port, apiKey, request.model,
    probeMessages,
    GITHUB_TOOL_SCHEMAS,
  )

  if (!probe || !probe.choices?.length) {
    yield* streamingFn(request, undefined, signal)
    return
  }

  const assistantMsg = probe.choices[0].message
  const toolCalls    = assistantMsg.tool_calls ?? []

  if (toolCalls.length === 0) {
    // No tool calls — stream normally
    yield* streamingFn(request, undefined, signal)
    return
  }

  // ── Phase 2: execute GitHub tool calls ────────────────────────────────────
  yield { type: 'start', messageId, model: request.model }

  const followUpMessages: unknown[] = [
    ...builtMessages,
    { role: 'assistant', content: assistantMsg.content ?? '', tool_calls: toolCalls },
  ]

  for (const tc of toolCalls) {
    if (!tc.function.name.startsWith('github_')) continue
    let resultContent: string
    try {
      const args = JSON.parse(tc.function.arguments) as Record<string, string>
      yield { type: 'delta', messageId, text: `\n[GitHub: ${tc.function.name}]\n` }
      resultContent = await dispatchGithubTool(tc.function.name, args)
    } catch (err) {
      resultContent = `GitHub tool error: ${String(err)}`
    }
    followUpMessages.push({
      role:         'tool',
      content:      resultContent,
      tool_call_id: tc.id,
    })
  }

  if (signal.aborted) {
    yield { type: 'done', messageId }
    return
  }

  // ── Phase 3: streaming follow-up with tool results ────────────────────────
  const followUpRequest: ChatRequest = {
    ...request,
    messages: followUpMessages as ChatRequest['messages'],
  }

  let innerStarted = false
  for await (const chunk of streamingFn(followUpRequest, undefined, signal)) {
    if (chunk.type === 'start') {
      if (!innerStarted) innerStarted = true
      continue
    }
    if ('messageId' in chunk) {
      yield { ...chunk, messageId } as ChatChunk
    } else {
      yield chunk
    }
  }

  if (!innerStarted) {
    yield { type: 'done', messageId }
  }
}
