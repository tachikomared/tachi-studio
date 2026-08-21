// packages/core/src/agent/__tests__/history.test.ts
//
// Conversation history for the TACHI agent. The Code page stores a flat stream
// of AgentEvents (user-text, assistant text deltas, tool calls…); the harness
// needs prior (user, assistant) TURNS so it remembers context across messages.
// buildAgentHistory collapses the event stream into clean turns (tool noise
// dropped — the assistant's spoken text carries the conclusion). Pure + testable.

import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '../types.js'
import { buildAgentHistory } from '../history.js'

describe('buildAgentHistory', () => {
  it('pairs a user message with the assistant text reply (deltas merged)', () => {
    const events: AgentEvent[] = [
      { type: 'user-text', text: 'remember the number 42' },
      { type: 'text', text: 'Got' },
      { type: 'text', text: ' it, 42.' },
      { type: 'done', reason: 'stop' },
    ]
    expect(buildAgentHistory(events)).toEqual([
      { role: 'user', content: 'remember the number 42' },
      { role: 'assistant', content: 'Got it, 42.' },
    ])
  })

  it('drops tool-call/tool-done noise but keeps the surrounding assistant text', () => {
    const events: AgentEvent[] = [
      { type: 'user-text', text: 'create a file' },
      { type: 'text', text: 'Creating it. ' },
      { type: 'tool-call', name: 'write', input: '{}' },
      { type: 'tool-done', name: 'write', output: 'ok', exitCode: 0 },
      { type: 'text', text: 'Done.' },
      { type: 'done', reason: 'stop' },
    ]
    const turns = buildAgentHistory(events)
    expect(turns[0]).toEqual({ role: 'user', content: 'create a file' })
    expect(turns[1].role).toBe('assistant')
    expect(turns[1].content).toContain('Creating it.')
    expect(turns[1].content).toContain('Done.')
  })

  it('handles multiple turns in order', () => {
    const events: AgentEvent[] = [
      { type: 'user-text', text: 'first' },
      { type: 'text', text: 'reply one' },
      { type: 'user-text', text: 'second' },
      { type: 'text', text: 'reply two' },
    ]
    expect(buildAgentHistory(events)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply two' },
    ])
  })

  it('skips empty/whitespace user messages and a trailing assistant with no text', () => {
    const events: AgentEvent[] = [
      { type: 'user-text', text: '   ' },
      { type: 'user-text', text: 'real question' },
    ]
    expect(buildAgentHistory(events)).toEqual([{ role: 'user', content: 'real question' }])
  })

  it('returns [] for an empty stream', () => {
    expect(buildAgentHistory([])).toEqual([])
  })
})
