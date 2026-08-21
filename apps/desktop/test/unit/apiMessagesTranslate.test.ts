// test/unit/apiMessagesTranslate.test.ts — pure Anthropic ⇄ OpenAI translators
// behind POST /v1/messages (electron-free, services/api-messages-translate.ts).
import { describe, it, expect } from 'vitest'
import {
  anthropicError,
  anthropicToOpenAiRequest,
  formatSseEvent,
  openAiToAnthropicResponse,
  OpenAiToAnthropicStream,
  type AnthropicStreamEvent,
} from '../../electron/services/api-messages-translate'

describe('anthropicToOpenAiRequest', () => {
  it('maps a plain request with a string system prompt', () => {
    const out = anthropicToOpenAiRequest({
      model: 'auto',
      max_tokens: 256,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.request).toEqual({
      model: 'auto',
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('joins system blocks into one leading system message', () => {
    const out = anthropicToOpenAiRequest({
      model: 'auto',
      system: [{ type: 'text', text: 'rule one' }, { type: 'text', text: 'rule two' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.request.messages[0]).toEqual({ role: 'system', content: 'rule one\n\nrule two' })
  })

  it('joins multimodal content, replacing images with a note', () => {
    const out = anthropicToOpenAiRequest({
      model: 'auto',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'answer briefly' },
        ],
      }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.request.messages[0].content).toBe('what is this?\n\n[image omitted]\n\nanswer briefly')
  })

  it('rejects tool_use and tool_result blocks with a 400-style error', () => {
    for (const type of ['tool_use', 'tool_result']) {
      const out = anthropicToOpenAiRequest({
        model: 'auto',
        messages: [{ role: 'assistant', content: [{ type, id: 'x' }] }],
      })
      expect(out.ok).toBe(false)
      if (out.ok) continue
      expect(out.status).toBe(400)
      expect(out.errorType).toBe('invalid_request_error')
      expect(out.message).toContain(type)
    }
  })

  it('drops unknown block types (thinking) leniently', () => {
    const out = anthropicToOpenAiRequest({
      model: 'auto',
      messages: [{
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'done' }],
      }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.request.messages[0].content).toBe('done')
  })

  it('passes sampling params through and maps stop_sequences to stop', () => {
    const out = anthropicToOpenAiRequest({
      model: 'auto',
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END', 42],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.request.stream).toBe(true)
    expect(out.request.temperature).toBe(0.2)
    expect(out.request.top_p).toBe(0.9)
    expect(out.request.stop).toEqual(['END'])
  })

  it('rejects missing model, empty messages, and bad roles', () => {
    expect(anthropicToOpenAiRequest({ messages: [{ role: 'user', content: 'x' }] }).ok).toBe(false)
    expect(anthropicToOpenAiRequest({ model: 'auto', messages: [] }).ok).toBe(false)
    expect(anthropicToOpenAiRequest({ model: 'auto', messages: [{ role: 'tool', content: 'x' }] }).ok).toBe(false)
    expect(anthropicToOpenAiRequest('not an object').ok).toBe(false)
  })
})

describe('openAiToAnthropicResponse', () => {
  it('produces the Anthropic message shape', () => {
    const out = openAiToAnthropicResponse({
      choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }, 'auto')
    expect(out.type).toBe('message')
    expect(out.role).toBe('assistant')
    expect(out.id).toMatch(/^msg_/)
    expect(out.model).toBe('auto')
    expect(out.content).toEqual([{ type: 'text', text: 'hello there' }])
    expect(out.stop_reason).toBe('end_turn')
    expect(out.stop_sequence).toBeNull()
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 3 })
  })

  it('maps finish_reason length to max_tokens', () => {
    const out = openAiToAnthropicResponse({
      choices: [{ message: { content: 'trunc' }, finish_reason: 'length' }],
    }, 'auto')
    expect(out.stop_reason).toBe('max_tokens')
  })

  it('survives a degenerate upstream response', () => {
    const out = openAiToAnthropicResponse({}, 'auto')
    expect(out.content).toEqual([{ type: 'text', text: '' }])
    expect(out.stop_reason).toBe('end_turn')
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })
})

describe('OpenAiToAnthropicStream', () => {
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

  it('translates 3 synthetic deltas into the canonical event sequence', () => {
    const t = new OpenAiToAnthropicStream('auto')
    const events: AnthropicStreamEvent[] = [
      ...t.pushSse(sse({ choices: [{ delta: { content: 'Hel' } }] })),
      ...t.pushSse(sse({ choices: [{ delta: { content: 'lo ' } }] })),
      ...t.pushSse(sse({ choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] })),
      ...t.pushSse('data: [DONE]\n\n'),
    ]
    expect(events.map(e => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const text = events
      .filter(e => e.type === 'content_block_delta')
      .map(e => (e.delta as { text: string }).text)
      .join('')
    expect(text).toBe('Hello world')
    const messageDelta = events.find(e => e.type === 'message_delta') as AnthropicStreamEvent
    expect((messageDelta.delta as { stop_reason: string }).stop_reason).toBe('end_turn')
    // No upstream usage — output_tokens falls back to the delta count.
    expect((messageDelta.usage as { output_tokens: number }).output_tokens).toBe(3)
    // finish() after [DONE] is a no-op.
    expect(t.finish()).toEqual([])
  })

  it('buffers data lines split across chunk boundaries', () => {
    const t = new OpenAiToAnthropicStream('auto')
    const whole = sse({ choices: [{ delta: { content: 'split' } }] })
    const events = [
      ...t.pushSse(whole.slice(0, 14)), // mid-JSON — nothing complete yet
      ...t.pushSse(whole.slice(14)),
    ]
    expect(events.map(e => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta'])
  })

  it('maps finish_reason length to max_tokens and uses reported usage', () => {
    const t = new OpenAiToAnthropicStream('auto')
    t.pushSse(sse({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }))
    t.pushSse(sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 42 } }))
    const closing = t.finish()
    const messageDelta = closing.find(e => e.type === 'message_delta') as AnthropicStreamEvent
    expect((messageDelta.delta as { stop_reason: string }).stop_reason).toBe('max_tokens')
    expect((messageDelta.usage as { output_tokens: number }).output_tokens).toBe(42)
  })

  it('emits a complete sequence even when the upstream sent nothing', () => {
    const t = new OpenAiToAnthropicStream('auto')
    expect(t.finish().map(e => e.type)).toEqual([
      'message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop',
    ])
  })

  it('skips malformed data lines without dying', () => {
    const t = new OpenAiToAnthropicStream('auto')
    const events = [
      ...t.pushSse('data: {not json}\n\n'),
      ...t.pushSse(sse({ choices: [{ delta: { content: 'ok' } }] })),
    ]
    expect(events.map(e => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta'])
  })
})

describe('anthropicError / formatSseEvent', () => {
  it('produces the Anthropic error envelope', () => {
    expect(JSON.parse(anthropicError('api_error', 'boom'))).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'boom' },
    })
  })

  it('formats an event as an Anthropic SSE frame', () => {
    const frame = formatSseEvent({ type: 'message_stop' })
    expect(frame).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
})
