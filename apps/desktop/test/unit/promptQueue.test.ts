// apps/desktop/test/unit/promptQueue.test.ts
//
// FOLLOW-UP PROMPT QUEUE — the pure half (plan A1a).
//
// Before this existed, `sendTask` hard-returned while a run was in flight, so
// typing during a run was a silent no-op: the operator had to wait, remember
// their next instruction, and retype it. What is pinned here is everything that
// can be decided without React: FIFO order, the refuse-don't-drop cap, and the
// PAUSE POLICY — which is the part that is easy to get wrong, because a queue
// that auto-fires after the user pressed STOP does the opposite of what STOP
// means.

import { describe, it, expect } from 'vitest'
import {
  PROMPT_QUEUE_CAP,
  promptSurfaceKey,
  normalizePromptText,
  promptQueueFull,
  enqueuePrompt,
  dequeuePrompt,
  removePrompt,
  shouldDrainPrompt,
  type QueuedPrompt,
  type PromptDrainInput,
} from '../../src/pages/agent/promptQueue'

let n = 0
const p = (text: string): QueuedPrompt => ({ id: `q${++n}`, text, at: 1000 + n })

describe('promptSurfaceKey', () => {
  it('maps the session tag to a queue key (null = the Code tab)', () => {
    expect(promptSurfaceKey(null)).toBe('code')
    expect(promptSurfaceKey(undefined)).toBe('code')
    expect(promptSurfaceKey('tachiapp')).toBe('tachiapp')
  })
})

describe('normalizePromptText', () => {
  it('trims, and treats whitespace-only / non-strings as empty', () => {
    expect(normalizePromptText('  fix the test  ')).toBe('fix the test')
    expect(normalizePromptText('   ')).toBe('')
    expect(normalizePromptText('')).toBe('')
    expect(normalizePromptText(null)).toBe('')
    expect(normalizePromptText(undefined)).toBe('')
  })
})

describe('enqueuePrompt', () => {
  it('appends in arrival order and stores the trimmed text', () => {
    const q1 = enqueuePrompt([], p('  one  '))
    const q2 = enqueuePrompt(q1, p('two'))
    expect(q2.map(q => q.text)).toEqual(['one', 'two'])
  })

  it('REFUSES at the cap — returning the SAME array so the caller can tell', () => {
    let q: QueuedPrompt[] = []
    for (let i = 0; i < PROMPT_QUEUE_CAP; i++) q = enqueuePrompt(q, p(`m${i}`))
    expect(q).toHaveLength(PROMPT_QUEUE_CAP)
    const after = enqueuePrompt(q, p('one too many'))
    // Identity, not just equality: the composer reads the rejection off this.
    expect(after).toBe(q)
    // And the OLDEST entry survives — dropping it would lose an instruction the
    // operator watched go in, which is worse than saying no.
    expect(after[0].text).toBe('m0')
  })

  it('refuses empty text and a duplicate id (same array back both times)', () => {
    const q = enqueuePrompt([], p('real'))
    expect(enqueuePrompt(q, { id: 'x', text: '   ', at: 1 })).toBe(q)
    expect(enqueuePrompt(q, { id: '', text: 'no id', at: 1 })).toBe(q)
    expect(enqueuePrompt(q, { id: q[0].id, text: 'dup id', at: 2 })).toBe(q)
  })

  it('honours a caller-supplied cap', () => {
    const q = enqueuePrompt(enqueuePrompt([], p('a'), 2), p('b'), 2)
    expect(promptQueueFull(q, 2)).toBe(true)
    expect(enqueuePrompt(q, p('c'), 2)).toBe(q)
  })
})

describe('dequeuePrompt', () => {
  it('is FIFO — the operator typed them in the order they want them run', () => {
    const q = [p('first'), p('second'), p('third')]
    const one = dequeuePrompt(q)
    expect(one.next?.text).toBe('first')
    expect(one.rest.map(r => r.text)).toEqual(['second', 'third'])
    const two = dequeuePrompt(one.rest)
    expect(two.next?.text).toBe('second')
  })

  it('an empty queue yields null and the same array instance', () => {
    const q: QueuedPrompt[] = []
    const r = dequeuePrompt(q)
    expect(r.next).toBeNull()
    expect(r.rest).toBe(q)
  })
})

describe('removePrompt', () => {
  it('drops one entry and leaves the rest in order', () => {
    const q = [p('a'), p('b'), p('c')]
    const after = removePrompt(q, q[1].id)
    expect(after.map(x => x.text)).toEqual(['a', 'c'])
  })

  it('an unknown id is a no-op (same array — no re-render)', () => {
    const q = [p('a')]
    expect(removePrompt(q, 'nope')).toBe(q)
  })
})

// ── The pause policy ─────────────────────────────────────────────────────────

const base: PromptDrainInput = {
  status:         'done',
  queueLength:    1,
  paused:         false,
  viewingArchive: false,
  surfaceBlocked: false,
  workflowMode:   false,
  draining:       false,
  canSend:        true,
}

describe('shouldDrainPrompt', () => {
  it('drains on a terminal done', () => {
    expect(shouldDrainPrompt(base)).toBe(true)
  })

  it('does NOT drain mid-run — v1 queues, it never steers a live round', () => {
    expect(shouldDrainPrompt({ ...base, status: 'running' })).toBe(false)
    expect(shouldDrainPrompt({ ...base, status: 'starting' })).toBe(false)
  })

  it('does NOT drain on idle — STOP lands there, and stop means "let me in"', () => {
    expect(shouldDrainPrompt({ ...base, status: 'idle' })).toBe(false)
  })

  it('does NOT drain on error — a dead session would eat every queued prompt', () => {
    expect(shouldDrainPrompt({ ...base, status: 'error' })).toBe(false)
  })

  it('respects the explicit pause latch even on a clean done', () => {
    expect(shouldDrainPrompt({ ...base, paused: true })).toBe(false)
  })

  it('never drains with nothing queued, while re-entrant, or when a send is impossible', () => {
    expect(shouldDrainPrompt({ ...base, queueLength: 0 })).toBe(false)
    expect(shouldDrainPrompt({ ...base, draining: true })).toBe(false)
    expect(shouldDrainPrompt({ ...base, canSend: false })).toBe(false)
  })

  it('never drains into a read-only archive, a foreign-owned slot, or a workflow', () => {
    expect(shouldDrainPrompt({ ...base, viewingArchive: true })).toBe(false)
    expect(shouldDrainPrompt({ ...base, surfaceBlocked: true })).toBe(false)
    expect(shouldDrainPrompt({ ...base, workflowMode: true })).toBe(false)
  })

  it('an ENDED-INCOMPLETE run still drains — the status is `done` either way', () => {
    // The give-up verdict rides ALONGSIDE status ('done'); losing the operator's
    // next instruction because the model gave up is the opposite of helpful.
    expect(shouldDrainPrompt({ ...base, status: 'done' })).toBe(true)
  })
})
