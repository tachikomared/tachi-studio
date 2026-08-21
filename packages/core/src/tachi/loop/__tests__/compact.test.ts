// packages/core/src/tachi/loop/__tests__/compact.test.ts
import { describe, it, expect } from 'vitest'
import {
  compactAgentMessages,
  agentHistoryBudgetChars,
  totalMessageChars,
  type AgentMessageLike,
} from '../compact.js'

// A small message factory. `n` chars of body so sizes are easy to reason about.
const user = (content: string): AgentMessageLike => ({ role: 'user', content })
const asst = (toolName: string): AgentMessageLike => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: toolName, toolName, input: {} }],
})
const toolRes = (toolName: string, body: string): AgentMessageLike => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: toolName, toolName, output: { type: 'text', value: body } }],
})
const big = (n: number) => 'x'.repeat(n)

describe('agentHistoryBudgetChars', () => {
  it('scales with the context window (~1.75 chars per token of window)', () => {
    expect(agentHistoryBudgetChars(200_000)).toBe(350_000) // claude
    expect(agentHistoryBudgetChars(128_000)).toBe(224_000) // gpt
    expect(agentHistoryBudgetChars(32_000)).toBe(56_000)   // default/qwen
  })
  it('never returns negative for a zero/garbage window', () => {
    expect(agentHistoryBudgetChars(0)).toBe(0)
    expect(agentHistoryBudgetChars(-5)).toBe(0)
  })
})

describe('totalMessageChars', () => {
  it('counts string bodies directly and JSON-sizes structured bodies', () => {
    expect(totalMessageChars([user('hello')])).toBe(5)
    const m = toolRes('read', 'abc')
    expect(totalMessageChars([m])).toBe(JSON.stringify(m.content).length)
  })
})

describe('compactAgentMessages', () => {
  it('returns the same reference when within budget (cheap no-op signal)', () => {
    const msgs = [user('task'), asst('read'), toolRes('read', 'small')]
    const out = compactAgentMessages(msgs, { maxChars: 100_000, keepRecent: 4 })
    expect(out).toBe(msgs)
  })

  it('returns the same reference for trivially short histories regardless of budget', () => {
    const msgs = [user('task'), asst('read')]
    expect(compactAgentMessages(msgs, { maxChars: 0, keepRecent: 1 })).toBe(msgs)
  })

  it('drops the middle, keeps the head + recent tail, and inserts one notice', () => {
    // 6 turns of (assistant tool-call + bulky tool result). Over budget → compact.
    const msgs: AgentMessageLike[] = [user('the original task')]
    for (let i = 0; i < 6; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(5_000))) }
    // 13 messages total. Budget tiny → must drop.
    const out = compactAgentMessages(msgs, { maxChars: 1_000, keepRecent: 4 })

    expect(out).not.toBe(msgs)
    // Head preserved verbatim.
    expect(out[0]).toBe(msgs[0])
    expect((out[0] as AgentMessageLike).role).toBe('user')
    // Exactly one notice, right after the head.
    expect((out[1] as AgentMessageLike).role).toBe('user')
    expect(String((out[1] as AgentMessageLike).content)).toContain('elided')
    // Tail is a verbatim suffix of the input (pairing preserved).
    const tail = out.slice(2)
    expect(tail).toEqual(msgs.slice(msgs.length - tail.length))
    // Compacted is materially smaller than the original.
    expect(totalMessageChars(out)).toBeLessThan(totalMessageChars(msgs))
  })

  it('reports the number of dropped messages in the notice', () => {
    const msgs: AgentMessageLike[] = [user('task')]
    for (let i = 0; i < 5; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(2_000))) }
    // 11 messages. keepRecent 4 → tailStart = 11-4 = 7 → dropped = 7-1 = 6.
    const out = compactAgentMessages(msgs, { maxChars: 500, keepRecent: 4 })
    expect(String((out[1] as AgentMessageLike).content)).toContain('6 earlier message')
  })

  it('never lets the tail BEGIN on an orphan tool result (pulls the boundary back to its assistant)', () => {
    // Construct so that the naive tailStart lands on a 'tool' message.
    // messages: [user, A0, T0, A1, T1, A2, T2, A3, T3]  (len 9)
    const msgs: AgentMessageLike[] = [user('task')]
    for (let i = 0; i < 4; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(3_000))) }
    // len 9; keepRecent 4 → tailStart = 5 → msgs[5] = A2 (assistant) — already fine.
    // keepRecent 3 → tailStart = 6 → msgs[6] = T2 (tool!) → must pull back to 5 (A2).
    const out = compactAgentMessages(msgs, { maxChars: 500, keepRecent: 3 })
    const firstTail = out[2] as AgentMessageLike // after head + notice
    expect(firstTail.role).not.toBe('tool')
    expect(firstTail.role).toBe('assistant')
  })

  it('is a no-op when keepRecent covers everything droppable', () => {
    const msgs: AgentMessageLike[] = [user('task'), asst('t0'), toolRes('t0', big(9_999))]
    // keepRecent 4 >= droppable region → tailStart clamps to 1 → nothing dropped.
    const out = compactAgentMessages(msgs, { maxChars: 10, keepRecent: 4 })
    expect(out).toBe(msgs)
  })

  // ── THE CUT MUST NOT WALK ──────────────────────────────────────────────────
  //
  // `tailStart` was `messages.length - keepRecent`, and the history grows by two
  // messages per step, so once a run went over budget the cut advanced EVERY
  // step — moving the notice's count and the first tail message with it. Every
  // provider in the path prices a prefix hit at a fraction of a fresh token and
  // all of them match on an exact leading prefix; a long agentic run is where
  // that is worth the most, and it was the one place we guaranteed a miss.
  describe('prefix stability', () => {
    /** A run of `steps` tool turns after the task, each result `size` chars. */
    const run = (steps: number, size: number): AgentMessageLike[] => {
      const msgs: AgentMessageLike[] = [user('the original task')]
      for (let i = 0; i < steps; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(size))) }
      return msgs
    }

    it('holds the boundary still while the run grows, then moves by a whole block', () => {
      // Budget large enough that a held tail still fits — the production case
      // (350k chars for a 200k-window model against a 12-message tail).
      const opts = { maxChars: 40_000, keepRecent: 12 }
      const starts: number[] = []
      const notices: string[] = []
      for (let steps = 19; steps <= 40; steps++) {
        const msgs = run(steps, 2_000)
        const out = compactAgentMessages(msgs, opts)
        if (out === msgs) continue
        notices.push(String((out[1] as AgentMessageLike).content))
        // Where the verbatim tail begins, as an index into the input.
        starts.push(msgs.length - (out.length - 2))
      }
      expect(starts.length, 'the fixture must actually compact').toBeGreaterThan(15)
      // THE PIN: one distinct boundary PER SEND is what this was. Stated as a
      // ratio rather than a magic number, because the number is a consequence
      // of the block size and the fixture's step size, and the property is not.
      expect(new Set(starts).size).toBeLessThanOrEqual(starts.length / 4)
      // The notice text is part of the prefix, so it has to hold still too.
      expect(new Set(notices).size).toBe(new Set(starts).size)
    })

    it('keeps at least keepRecent — the held tail is always longer, never shorter', () => {
      for (let steps = 12; steps <= 40; steps++) {
        const msgs = run(steps, 2_000)
        const out = compactAgentMessages(msgs, { maxChars: 40_000, keepRecent: 12 })
        if (out === msgs) continue
        expect(out.length - 2, `steps=${steps}`).toBeGreaterThanOrEqual(12)
      }
    })

    it('gives the stability up when the held tail would not fit', () => {
      // A backstop against a run dying on context overflow does not get to
      // spend budget on a cache hit. With a tiny budget the tight cut wins, and
      // the pre-existing count is unchanged.
      const msgs: AgentMessageLike[] = [user('task')]
      for (let i = 0; i < 5; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(2_000))) }
      const out = compactAgentMessages(msgs, { maxChars: 500, keepRecent: 4 })
      expect(String((out[1] as AgentMessageLike).content)).toContain('6 earlier message')
    })
  })

  it('treats keepRecent < 1 as 1 (still keeps at least the most recent message)', () => {
    const msgs: AgentMessageLike[] = [user('task')]
    for (let i = 0; i < 4; i++) { msgs.push(asst(`t${i}`)); msgs.push(toolRes(`t${i}`, big(3_000))) }
    const out = compactAgentMessages(msgs, { maxChars: 100, keepRecent: 0 })
    // Tail of 1 lands on the last tool result → pulled back to its assistant.
    expect(out).not.toBe(msgs)
    expect((out[out.length - 1] as AgentMessageLike).role).toBe('tool')
    expect((out[out.length - 2] as AgentMessageLike).role).toBe('assistant')
  })
})
