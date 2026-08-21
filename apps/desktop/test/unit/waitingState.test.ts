// apps/desktop/test/unit/waitingState.test.ts
//
// LANE E — the pure "is the model making us wait?" derivation behind the
// animated tail indicator on both transcripts. `src/components/waitingState.ts`
// is deliberately framework-free, so every rule that decides whether the dots
// appear can be asserted without mounting a transcript.
//
// The rules that MATTER (and that a naive `isRunning` check gets wrong):
//   - streaming prose is its own progress indicator → no dots
//   - a running tool card already shows its own state → no dots
//   - a tool that just FINISHED is the classic dead gap → dots
//   - a permission card means the run waits on the OPERATOR → no dots

import { describe, it, expect } from 'vitest'
import {
  transcriptTail,
  isTranscriptWaiting,
  isChatWaiting,
  type TranscriptTail,
} from '../../src/components/waitingState'

describe('transcriptTail', () => {
  it('classifies an empty transcript', () => {
    expect(transcriptTail(null)).toBe('empty')
    expect(transcriptTail(undefined)).toBe('empty')
  })

  it('classifies the four transcript-shaping event types', () => {
    expect(transcriptTail({ type: 'user-text', text: 'hi' })).toBe('user-text')
    expect(transcriptTail({ type: 'text', text: 'Plan:' })).toBe('text')
    expect(transcriptTail({ type: 'tool-call' })).toBe('tool-call')
    expect(transcriptTail({ type: 'tool-done' })).toBe('tool-done')
  })

  it('treats a text event with no characters yet as text-empty, not text', () => {
    // The agent store coalesces text chunks into one growing event; a block
    // that exists but is still empty is a wait, not visible progress.
    expect(transcriptTail({ type: 'text', text: '' })).toBe('text-empty')
    expect(transcriptTail({ type: 'text' })).toBe('text-empty')
  })

  it('buckets everything else as other', () => {
    expect(transcriptTail({ type: 'fusion-panel' })).toBe('other')
    expect(transcriptTail({ type: 'done' })).toBe('other')
    expect(transcriptTail({ type: 'error' })).toBe('other')
  })
})

describe('isTranscriptWaiting', () => {
  const at = (over: Partial<Parameters<typeof isTranscriptWaiting>[0]> = {}) =>
    isTranscriptWaiting({ status: 'running', tail: 'user-text', ...over })

  it('is false when no run is in flight', () => {
    for (const status of ['idle', 'done', 'error', '']) {
      expect(at({ status })).toBe(false)
    }
  })

  it('is true for every in-flight status with an empty transcript', () => {
    expect(at({ status: 'starting', tail: 'empty' })).toBe(true)
    expect(at({ status: 'running', tail: 'empty' })).toBe(true)
  })

  it('is true between send and the first token', () => {
    expect(at({ tail: 'user-text' })).toBe(true)
  })

  it('is true between a tool result and the next model text', () => {
    expect(at({ tail: 'tool-done' })).toBe(true)
  })

  it('is false while prose tokens are landing', () => {
    expect(at({ tail: 'text' })).toBe(false)
  })

  it('is true when a text block exists but has produced nothing yet', () => {
    expect(at({ tail: 'text-empty' })).toBe(true)
  })

  it('is false while a tool is running — the tool card owns that state', () => {
    expect(at({ tail: 'tool-call' })).toBe(false)
  })

  it('is false on a blocked (borrowed / archived) surface', () => {
    expect(at({ tail: 'tool-done', blocked: true })).toBe(false)
    expect(at({ tail: 'empty', blocked: true })).toBe(false)
  })

  it('is false while a permission card waits on the operator', () => {
    // The run is parked on a human decision — animating "the model is thinking"
    // there would be a lie, and it competes with the card for attention.
    expect(at({ tail: 'tool-done', awaitingPermission: true })).toBe(false)
  })

  it('never fires for a tail bucket while the run is over', () => {
    const tails: TranscriptTail[] = ['empty', 'user-text', 'text', 'text-empty', 'tool-call', 'tool-done', 'other']
    for (const tail of tails) {
      expect(isTranscriptWaiting({ status: 'done', tail })).toBe(false)
    }
  })
})

describe('isChatWaiting', () => {
  const ac = (over: Partial<Parameters<typeof isChatWaiting>[0]> = {}) =>
    isChatWaiting({ streaming: true, lastRole: 'user', ...over })

  it('is false when this conversation is not the streaming one', () => {
    expect(ac({ streaming: false })).toBe(false)
  })

  it('is false for an empty conversation', () => {
    expect(ac({ lastRole: null })).toBe(false)
    expect(ac({ lastRole: undefined })).toBe(false)
  })

  it('is true right after send — the assistant bubble does not exist yet', () => {
    // chat.store only appends the assistant message on the provider's `start`
    // chunk, so the user's own message is the tail during the whole first wait.
    expect(ac({ lastRole: 'user' })).toBe(true)
  })

  it('is true for an assistant bubble that has streamed nothing yet', () => {
    expect(ac({ lastRole: 'assistant', lastAssistantText: '' })).toBe(true)
  })

  it('is false once the first characters land', () => {
    expect(ac({ lastRole: 'assistant', lastAssistantText: 'S' })).toBe(false)
  })

  it('is false when the bubble already carries a non-text part', () => {
    // An image/audio reply has visible content even with empty text.
    expect(ac({ lastRole: 'assistant', lastAssistantText: '', lastAssistantHasParts: true })).toBe(false)
  })

  it('is false when the stream failed — the bubble shows the error', () => {
    expect(ac({ lastRole: 'assistant', lastAssistantText: '', lastAssistantErrored: true })).toBe(false)
  })
})
