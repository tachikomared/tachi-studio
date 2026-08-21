// apps/desktop/test/unit/openclaude-events.test.ts
//
// Regression coverage for the OpenClaude SDK→AgentEvent mapper (audit C4/H4):
//   C4 — tool_result must emit the REAL tool name (via the per-stream
//        tool_use_id→name map), not a hardcoded 'tool', so the renderer pairs
//        parallel tool calls correctly.
//   H4 — the dedup flag + name map are per-stream state (not module globals),
//        so concurrent sessions don't corrupt each other.

import { describe, it, expect } from 'vitest'
import { sdkMessageToAgentEvents, newStreamState } from '../../electron/services/openclaude-client'

// Minimal SDKMessage shapes (the mapper only reads .type and .message.content).
const assistantWithTools = (blocks: Array<Record<string, unknown>>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
})
const userWithResults = (blocks: Array<Record<string, unknown>>) => ({
  type: 'user',
  message: { role: 'user', content: blocks },
})

describe('sdkMessageToAgentEvents — C4 tool-result pairing', () => {
  it('emits the real tool name on tool-done by matching tool_use_id', () => {
    const state = newStreamState()
    // Assistant runs two tools in one turn (parallel tool_use blocks).
    const callEvents = sdkMessageToAgentEvents(
      assistantWithTools([
        { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file: 'a.ts' } },
        { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'ls' } },
      ]),
      state,
    )
    expect(callEvents.filter(e => e.type === 'tool-call').map(e => (e as { name: string }).name))
      .toEqual(['Read', 'Bash'])

    // Results arrive (here in REVERSE order) — each must carry its real name,
    // never the old hardcoded 'tool'.
    const doneEvents = sdkMessageToAgentEvents(
      userWithResults([
        { type: 'tool_result', tool_use_id: 'tu_bash', content: 'file1 file2' },
        { type: 'tool_result', tool_use_id: 'tu_read', content: 'export const a = 1' },
      ]),
      state,
    )
    const done = doneEvents.filter(e => e.type === 'tool-done') as Array<{ name: string; output: string }>
    expect(done.map(d => d.name)).toEqual(['Bash', 'Read'])
    expect(done.find(d => d.name === 'Read')?.output).toContain('export const a = 1')
    expect(done.some(d => d.name === 'tool')).toBe(false)
  })

  it('falls back to "tool" only when the tool_use_id is unknown', () => {
    const state = newStreamState()
    const done = sdkMessageToAgentEvents(
      userWithResults([{ type: 'tool_result', tool_use_id: 'never_seen', content: 'x' }]),
      state,
    ).filter(e => e.type === 'tool-done') as Array<{ name: string }>
    expect(done[0].name).toBe('tool')
  })
})

describe('sdkMessageToAgentEvents — H4 per-stream isolation', () => {
  it('two independent states do not share the tool-name map', () => {
    const a = newStreamState()
    const b = newStreamState()
    sdkMessageToAgentEvents(assistantWithTools([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]), a)
    // b never saw 'x' → must NOT resolve it to Read (no cross-stream bleed).
    const doneB = sdkMessageToAgentEvents(
      userWithResults([{ type: 'tool_result', tool_use_id: 'x', content: 'y' }]),
      b,
    ).filter(e => e.type === 'tool-done') as Array<{ name: string }>
    expect(doneB[0].name).toBe('tool')
    // a still resolves it.
    const doneA = sdkMessageToAgentEvents(
      userWithResults([{ type: 'tool_result', tool_use_id: 'x', content: 'y' }]),
      a,
    ).filter(e => e.type === 'tool-done') as Array<{ name: string }>
    expect(doneA[0].name).toBe('Read')
  })

  it('streamed-text dedup flag is tracked per state, not globally', () => {
    const state = newStreamState()
    // A streamed text delta sets the flag…
    sdkMessageToAgentEvents(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      state,
    )
    expect(state.streamedThisTurn).toBe(true)
    // …and the matching final assistant text is then suppressed (consumed once).
    const ev = sdkMessageToAgentEvents(assistantWithTools([{ type: 'text', text: 'hi' }]), state)
    expect(ev.filter(e => e.type === 'text')).toHaveLength(0)
    expect(state.streamedThisTurn).toBe(false)
  })
})
