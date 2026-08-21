// apps/desktop/test/unit/chatCompact.test.ts
//
// CHAT COMPACT — unit coverage for buildChatContext, the PURE builder for the
// chat page's outgoing request context. Contract:
//   outgoing = [ summary note, ...messages.slice(compactedUpTo) ]  (flattened)
// compactedUpTo 0/undefined = passthrough; the input array is never mutated.

import { describe, it, expect } from 'vitest'
import { buildChatContext, planChatContext, COMPACT_NOTE_HEADER, type OutgoingMessage } from '../../src/pages/chat/chat-context'
import type { ChatMessage, ContentPart } from '../../src/store/chat.store'

// Minimal ChatMessage factory (buildChatContext reads role/content/streaming/error).
const msg = (
  role: 'user' | 'assistant',
  content: string | ContentPart[],
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id: Math.random().toString(36).slice(2), role, content, ...extra })

const convo = (): ChatMessage[] => [
  msg('user', 'one'),
  msg('assistant', 'two'),
  msg('user', 'three'),
  msg('assistant', 'four'),
  msg('user', 'five'),
]

describe('buildChatContext — passthrough (no compaction)', () => {
  it('returns all flattened turns when compactedUpTo is undefined', () => {
    const out = buildChatContext(convo(), undefined, undefined)
    expect(out).toEqual<OutgoingMessage[]>([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
    ])
  })

  it('returns all flattened turns when compactedUpTo is 0', () => {
    const out = buildChatContext(convo(), 0, 'IGNORED SUMMARY')
    expect(out.map(m => m.content)).toEqual(['one', 'two', 'three', 'four', 'five'])
    // No summary note is injected at index 0.
    expect(out[0].content).not.toContain(COMPACT_NOTE_HEADER)
  })

  it('does not inject a note when compactedUpTo is 0 even if a summary is given', () => {
    const out = buildChatContext(convo(), 0, 'S')
    expect(out).toHaveLength(5)
  })
})

describe('buildChatContext — slice + injection', () => {
  it('drops the head and injects the summary as a leading user note', () => {
    const out = buildChatContext(convo(), 3, 'DENSE SUMMARY')
    expect(out).toHaveLength(3) // 1 note + messages.slice(3) = [four, five]
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain(COMPACT_NOTE_HEADER)
    expect(out[0].content).toContain('DENSE SUMMARY')
    expect(out.slice(1)).toEqual<OutgoingMessage[]>([
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
    ])
  })

  it('slices at exactly compactedUpTo', () => {
    const out = buildChatContext(convo(), 1, 'S')
    // note + slice(1) = two,three,four,five
    expect(out.slice(1).map(m => m.content)).toEqual(['two', 'three', 'four', 'five'])
  })

  it('emits only the note when the whole conversation is compacted', () => {
    const src = convo()
    const out = buildChatContext(src, src.length, 'ALL GONE')
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('ALL GONE')
  })

  it('does not inject when compacted but the summary is blank/whitespace', () => {
    const out = buildChatContext(convo(), 3, '   ')
    expect(out).toEqual<OutgoingMessage[]>([
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
    ])
  })
})

describe('buildChatContext — clamping', () => {
  it('clamps compactedUpTo above length (never throws, tail empty)', () => {
    const out = buildChatContext(convo(), 999, 'S')
    expect(out).toHaveLength(1) // just the note
    expect(out[0].content).toContain('S')
  })

  it('treats a negative compactedUpTo as passthrough', () => {
    const out = buildChatContext(convo(), -5, 'S')
    expect(out).toHaveLength(5)
    expect(out[0].content).toBe('one')
  })
})

describe('buildChatContext — filtering', () => {
  it('drops streaming, errored, and empty messages', () => {
    const src: ChatMessage[] = [
      msg('user', 'keep-1'),
      msg('assistant', 'streaming-drop', { streaming: true }),
      msg('assistant', 'error-drop', { error: 'boom' }),
      msg('user', '   '), // whitespace-only → dropped
      msg('assistant', 'keep-2'),
    ]
    const out = buildChatContext(src, 0, undefined)
    expect(out).toEqual<OutgoingMessage[]>([
      { role: 'user', content: 'keep-1' },
      { role: 'assistant', content: 'keep-2' },
    ])
  })

  it('flattens structured content parts to their text', () => {
    const parts: ContentPart[] = [
      { type: 'image', data: 'data:...', mimeType: 'image/png' },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    const out = buildChatContext([msg('user', parts)], 0, undefined)
    expect(out).toEqual<OutgoingMessage[]>([{ role: 'user', content: 'hello world' }])
  })
})

describe('buildChatContext — cap', () => {
  it('keeps only the last N flattened turns (summary note excluded from the cap)', () => {
    const out = buildChatContext(convo(), 0, undefined, { cap: 2 })
    expect(out.map(m => m.content)).toEqual(['four', 'five'])
  })

  it('applies the cap to the tail, then prepends the note', () => {
    const out = buildChatContext(convo(), 1, 'S', { cap: 2 })
    // slice(1) = two,three,four,five → cap 2 → four,five → + note
    expect(out).toHaveLength(3)
    expect(out[0].content).toContain('S')
    expect(out.slice(1).map(m => m.content)).toEqual(['four', 'five'])
  })
})

describe('buildChatContext — purity', () => {
  it('never mutates the input array or its elements', () => {
    const src = convo()
    const snapshot = JSON.parse(JSON.stringify(src))
    buildChatContext(src, 2, 'SUMMARY', { cap: 1 })
    expect(src).toEqual(snapshot)
    expect(src).toHaveLength(5)
  })

  it('returns a fresh array (not the input reference) on passthrough', () => {
    const src = convo()
    const out = buildChatContext(src, 0, undefined)
    expect(out).not.toBe(src as unknown as OutgoingMessage[])
  })
})

// ── THE CUT POINT MUST HOLD STILL ────────────────────────────────────────────
//
// `{ cap: 20 }` is a SLIDING window: past turn 20 it drops the oldest turn
// every time it adds a new one, so the request's LEADING BYTES differ on every
// send. llama-server reuses the longest common cached prefix per slot, and
// Anthropic/OpenAI/DeepSeek all price a prefix hit at a fraction of a fresh
// token — every one of them keys on those leading bytes. The window converted a
// free re-read into a full re-processing, every turn, to hold the count at
// exactly 20.
//
// The tests below are about ONE property: what leaves the planner is byte-for-
// byte the same prefix until the tail genuinely outgrows the cap.

/** `n` alternating user/assistant turns, numbered so a prefix is identifiable. */
const longConvo = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`))

describe('planChatContext — the cut holds still', () => {
  it('does not move the cut while the tail fits, however many turns arrive', () => {
    // Sixteen turns, cap 20: nothing to cut, and the first message must be the
    // same one every time — that IS the cache key.
    let pinned: number | undefined
    const firsts: string[] = []
    for (let n = 4; n <= 16; n += 2) {
      const plan = planChatContext(longConvo(n), undefined, undefined, { cap: 20, pinnedFrom: pinned })
      pinned = plan.from
      firsts.push(plan.messages[0].content)
      expect(plan.recut).toBe(false)
    }
    expect(new Set(firsts).size, 'the prefix moved while it still fit').toBe(1)
    expect(firsts[0]).toBe('turn-0')
  })

  it('THE PIN: past the cap, the same prefix is sent turn after turn', () => {
    // Grow 20 → 30 turns: one send that still fits, then the overflow, then
    // nine more. The old window slid on every one of the last ten; the planner
    // may cut ONCE and must then hold.
    let pinned: number | undefined
    const firsts: string[] = []
    let recuts = 0
    for (let n = 20; n <= 30; n++) {
      const plan = planChatContext(longConvo(n), undefined, undefined, { cap: 20, pinnedFrom: pinned })
      pinned = plan.from
      firsts.push(plan.messages[0].content)
      if (plan.recut) recuts++
    }
    // Eleven sends, ONE invalidation — and it happens on the turn that
    // overflows, not on the ten that follow it. The sliding window's number
    // here was ten.
    expect(recuts).toBe(1)
    expect(new Set(firsts).size).toBe(2)
    expect(firsts[0]).toBe('turn-0')
    // The nine sends after the cut all opened on the same message.
    expect(new Set(firsts.slice(2)).size).toBe(1)

    // …and without the pin (the old behaviour, and what happens if a caller
    // forgets to persist `from`) every single send starts somewhere new.
    const unpinned = new Set(
      Array.from({ length: 10 }, (_, i) =>
        planChatContext(longConvo(21 + i), undefined, undefined, { cap: 20 }).messages[0].content),
    )
    expect(unpinned.size).toBeGreaterThan(2)
  })

  it('re-cuts to about HALF the cap, so the next one is cap/2 turns away', () => {
    const plan = planChatContext(longConvo(21), undefined, undefined, { cap: 20 })
    expect(plan.recut).toBe(true)
    // Halving is what makes it amortised: cutting to exactly the cap would put
    // the next invalidation one turn later, which is the sliding window again
    // wearing a pin.
    expect(plan.messages.length).toBeLessThanOrEqual(11)
    expect(plan.messages.length).toBeGreaterThanOrEqual(9)
  })

  it('opens on a USER turn — some providers reject a request that does not', () => {
    for (const n of [21, 22, 23, 24]) {
      const plan = planChatContext(longConvo(n), undefined, undefined, { cap: 20 })
      // turn-N with N even is a user turn in this fixture.
      expect(Number(plan.messages[0].content.split('-')[1]) % 2, plan.messages[0].content).toBe(0)
    }
  })

  it('never carries more than the cap', () => {
    let pinned: number | undefined
    for (let n = 2; n <= 60; n++) {
      const plan = planChatContext(longConvo(n), undefined, undefined, { cap: 20, pinnedFrom: pinned })
      pinned = plan.from
      expect(plan.messages.length, `n=${n}`).toBeLessThanOrEqual(20)
    }
  })
})

describe('planChatContext — the pin can be wrong, and must not cost the conversation', () => {
  it('drops a pin left past the end by edit-and-rewind', () => {
    // A pin stored when the transcript was 40 long, against one now 6 long:
    // honouring it would send the model NOTHING while the screen still shows a
    // conversation.
    const plan = planChatContext(convo(), undefined, undefined, { cap: 20, pinnedFrom: 40 })
    expect(plan.messages.map(m => m.content)).toEqual(['one', 'two', 'three', 'four', 'five'])
    expect(plan.from).toBe(0)
    // It MOVED (backwards), and the caller must be told so it stores the truth.
    expect(plan.recut).toBe(true)
  })

  it('keeps a pin that still has turns after it', () => {
    const plan = planChatContext(convo(), undefined, undefined, { cap: 20, pinnedFrom: 3 })
    expect(plan.messages.map(m => m.content)).toEqual(['four', 'five'])
    expect(plan.recut).toBe(false)
  })

  it('a compaction landing after the pin wins, and its note is still injected', () => {
    // Sending turns the summary already stands in for is the one outcome
    // neither mechanism is for.
    const plan = planChatContext(convo(), 3, 'DENSE SUMMARY', { cap: 20, pinnedFrom: 1 })
    expect(plan.from).toBe(3)
    expect(plan.messages[0].content).toContain(COMPACT_NOTE_HEADER)
    expect(plan.messages.slice(1).map(m => m.content)).toEqual(['four', 'five'])
  })

  it('is pure — the transcript it plans over is never touched', () => {
    const src = longConvo(30)
    const snapshot = JSON.parse(JSON.stringify(src))
    planChatContext(src, 2, 'S', { cap: 20, pinnedFrom: 4 })
    expect(src).toEqual(snapshot)
  })
})

// ── THE ALIGNMENT USED A WEAKER TEST THAN THE CUT (adversarial review, 2026-08-03)
//
// `cutForTail` picks the boundary with `isEligible` (non-streaming, non-error,
// non-empty flattened text) and then walks FORWARD onto a user turn — but that
// walk tested `role === 'user'` only. An ATTACHMENT-ONLY user turn (an image
// pasted with no caption: `content = [{type:'image',…}]`, so flattened text is
// '') satisfies the walk and fails the cut's own test, so the walk could land on
// a message `buildChatContext` then filters out — leaving the request opening on
// the ASSISTANT turn after it. Exactly what the alignment exists to prevent.
//
// And it persists: `from` is stored as `contextFrom`, so the broken opening is
// rebuilt on every send until the next cap-driven recut.
describe('planChatContext — an attachment-only turn cannot become the opening', () => {
  /** An image with no caption: role user, zero flattened text. */
  const imageOnly = (): ChatMessage => msg('user', [{ type: 'image', mediaType: 'image/png', data: 'x' } as ContentPart])

  /** 22 turns, alternating, with index 12 an attachment-only user turn. */
  const withImageAt12 = (): ChatMessage[] => {
    const out: ChatMessage[] = []
    for (let i = 0; i < 22; i++) {
      if (i === 12) { out.push(imageOnly()); continue }
      out.push(msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`))
    }
    return out
  }

  it('opens on a USER turn that survives the content filter', () => {
    const src = withImageAt12()
    const plan = planChatContext(src, undefined, undefined, { cap: 20 })
    expect(plan.recut).toBe(true)
    // THE PIN: this was 'assistant'. The walk stopped on index 12 (user, but
    // empty), buildChatContext dropped it, and index 13 became the head.
    expect(plan.messages[0].role).toBe('user')
    expect(plan.messages[0].content.trim().length).toBeGreaterThan(0)
  })

  it('the persisted cut reproduces a valid opening on the NEXT send too', () => {
    // The defect was not one bad request: `from` is stored and replayed.
    const src = withImageAt12()
    const first = planChatContext(src, undefined, undefined, { cap: 20 })
    const second = planChatContext(src, undefined, undefined, { cap: 20, pinnedFrom: first.from })
    expect(second.messages[0].role).toBe('user')
    expect(second.recut).toBe(false)
  })

  it('an ineligible turn is never the cut point, whatever its role', () => {
    // Generalised: a streaming or errored user turn is just as unusable as an
    // empty one, and the walk must skip all three.
    for (const bad of [
      msg('user', 'half a th', { streaming: true }),
      msg('user', 'boom', { error: 'failed' }),
      msg('user', '   '),
    ]) {
      const src: ChatMessage[] = []
      for (let i = 0; i < 22; i++) src.push(i === 12 ? bad : msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`))
      const plan = planChatContext(src, undefined, undefined, { cap: 20 })
      expect(plan.messages[0].role, JSON.stringify(bad.content)).toBe('user')
      expect(plan.messages[0].content.trim().length).toBeGreaterThan(0)
    }
  })
})
