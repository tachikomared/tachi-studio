// packages/core/src/chat/__tests__/repair-tool-messages.test.ts
//
// Tool-call orphan repair (STEAL 2026-06-12 cluster A; odysseus
// context_compactor._sanitize_tool_messages). OpenAI-format providers return
// hard 400s when a message array contains a role:'tool' result whose
// tool_calls parent was trimmed away, or an assistant tool_calls entry whose
// responses are missing. This utility makes any trimmed/assembled array
// protocol-legal again; intact arrays pass through unchanged.

import { describe, it, expect } from 'vitest'
import { repairToolMessages, type ToolishMessage } from '../repair-tool-messages'

const user = (content: string): ToolishMessage => ({ role: 'user', content })
const assistant = (content: string): ToolishMessage => ({ role: 'assistant', content })
const assistantCalls = (content: string, ids: string[]): ToolishMessage => ({
  role: 'assistant', content,
  tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'web_search', arguments: '{}' } })),
})
const toolResult = (id: string): ToolishMessage => ({ role: 'tool', content: 'result', tool_call_id: id })

describe('repairToolMessages', () => {
  it('passes an intact tool exchange through unchanged', () => {
    const msgs = [user('q'), assistantCalls('', ['a']), toolResult('a'), assistant('answer')]
    expect(repairToolMessages(msgs)).toEqual(msgs)
  })

  it('drops an orphaned tool result (parent trimmed away)', () => {
    const msgs = [toolResult('ghost'), user('q'), assistant('a')]
    const out = repairToolMessages(msgs)
    expect(out).toEqual([user('q'), assistant('a')])
  })

  it('de-arms an assistant tool_calls whose responses were trimmed', () => {
    const msgs = [user('q'), assistantCalls('thinking…', ['lost'])]
    const out = repairToolMessages(msgs)
    expect(out).toHaveLength(2)
    expect(out[1]!.tool_calls).toBeUndefined()
    expect(out[1]!.content).toBe('thinking…')
  })

  it('drops a content-less assistant whose only payload was dangling tool_calls', () => {
    const msgs = [user('q'), assistantCalls('', ['lost']), assistant('final')]
    const out = repairToolMessages(msgs)
    expect(out).toEqual([user('q'), assistant('final')])
  })

  it('keeps answered ids and prunes only unanswered ones (partial trim)', () => {
    const msgs = [user('q'), assistantCalls('', ['a', 'b']), toolResult('a'), assistant('done')]
    const out = repairToolMessages(msgs)
    const armed = out[1]!
    expect(armed.tool_calls).toHaveLength(1)
    expect((armed.tool_calls![0] as { id: string }).id).toBe('a')
    expect(out.filter(m => m.role === 'tool')).toHaveLength(1)
  })

  it('a tool result BEFORE its parent is orphaned (order matters)', () => {
    const msgs = [toolResult('x'), assistantCalls('', ['x'])]
    const out = repairToolMessages(msgs)
    // The early result is dropped; the parent is then dangling and de-armed/dropped.
    expect(out.filter(m => m.role === 'tool')).toHaveLength(0)
    expect(out.every(m => m.tool_calls === undefined)).toBe(true)
  })

  it('no-ops on plain user/assistant histories', () => {
    const msgs = [user('a'), assistant('b'), user('c')]
    expect(repairToolMessages(msgs)).toEqual(msgs)
  })
})
