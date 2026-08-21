// apps/desktop/test/unit/pairToolEvents.test.ts
//
// The transcript's event→block transform (src/pages/agent/pairToolEvents.ts).
// It used to live inside AgentPage.tsx where it could only be verified by
// clicking; it is now a pure module, so the contracts that actually matter are
// pinned here:
//
//   · tool-call / tool-done pairing (by name, then name-agnostic fallback)
//   · abort marking when a session terminates with tools still open
//   · ≥3 consecutive tool blocks collapse into a group
//   · CODEX PROGRESS ROUTING — `[codex] …` text lands INSIDE the owning card
//     instead of rendering as stray prose under it (batch31)
import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@tachi/core'
import { pairToolEvents, GROUP_THRESHOLD, type Block, type ToolBlock } from '../../src/pages/agent/pairToolEvents'

let seq = 0
const msg = (event: AgentEvent, timestamp?: number) => ({ id: String(++seq), event, timestamp })

const call = (name: string, input = '{}') => msg({ type: 'tool-call', name, input })
const done = (name: string, output = 'ok') => msg({ type: 'tool-done', name, output })
const text = (t: string) => msg({ type: 'text', text: t })

const tools = (blocks: Block[]) => blocks.filter((b): b is ToolBlock => b.kind === 'tool')
const events = (blocks: Block[]) => blocks.filter(b => b.kind === 'event')

const CODEX_ARGS = JSON.stringify({ task: 'audit the auth flow' })
const REVIEW_ARGS = JSON.stringify({ summary: 'I fixed the retry loop' })

describe('pairToolEvents — pairing', () => {
  it('pairs a call with its done and marks the block finished', () => {
    const blocks = pairToolEvents([call('Read'), done('Read', 'file body')])
    expect(blocks).toHaveLength(1)
    const b = tools(blocks)[0]
    expect(b.output).toBe('file body')
    expect(b.running).toBe(false)
    expect(b.aborted).toBeUndefined()
  })

  it('leaves an unmatched call running while the session is live', () => {
    const b = tools(pairToolEvents([call('Bash')]))[0]
    expect(b.running).toBe(true)
    expect(b.aborted).toBeUndefined()
  })

  it('marks still-open tools aborted when the session terminates', () => {
    const blocks = pairToolEvents([call('Bash'), msg({ type: 'done', reason: 'stop' })])
    const b = tools(blocks)[0]
    expect(b.running).toBe(false)
    expect(b.aborted).toBe(true)
  })

  it('groups a run of consecutive tool blocks', () => {
    const src = []
    for (let i = 0; i < GROUP_THRESHOLD; i++) src.push(call('Read'), done('Read'))
    const blocks = pairToolEvents(src)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('group')
  })
})

describe('pairToolEvents — codex progress routing', () => {
  it('routes [codex] lines INTO the open codex_worker block, not the transcript', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ npm test\n[codex] edit src/foo.ts\n'),
    ])
    // One block only — the progress text produced no stray event row.
    expect(blocks).toHaveLength(1)
    expect(events(blocks)).toHaveLength(0)
    expect(tools(blocks)[0].progress).toEqual(['$ npm test', 'edit src/foo.ts'])
  })

  it('does the same for codex_review', () => {
    const blocks = pairToolEvents([
      call('codex_review', REVIEW_ARGS),
      text('[codex] $ git diff\n'),
    ])
    expect(events(blocks)).toHaveLength(0)
    expect(tools(blocks)[0].progress).toEqual(['$ git diff'])
  })

  it('accumulates across several text events and de-dupes a repeated tail', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ a\n'),
      text('[codex] $ a\n[codex] $ b\n'),
    ])
    expect(tools(blocks)[0].progress).toEqual(['$ a', '$ b'])
  })

  it('keeps the prose half of a MIXED text blob as a normal event', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ ls\nHere is what I found.\n'),
    ])
    const evs = events(blocks)
    expect(evs).toHaveLength(1)
    expect((evs[0] as { event: AgentEvent }).event).toEqual({ type: 'text', text: 'Here is what I found.' })
    expect(tools(blocks)[0].progress).toEqual(['$ ls'])
  })

  it('leaves [codex] text alone when no codex tool is open', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      done('codex_worker', 'answer'),
      text('[codex] $ late line\n'),
    ])
    expect(events(blocks)).toHaveLength(1)
    expect(tools(blocks)[0].progress).toBeUndefined()
  })

  it('never routes progress into a NON-codex tool that happens to be open', () => {
    const blocks = pairToolEvents([call('Bash'), text('[codex] $ ls\n')])
    expect(events(blocks)).toHaveLength(1)
    expect(tools(blocks)[0].progress).toBeUndefined()
  })

  it('gives the lines to the innermost open codex call when two overlap', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      call('codex_review', REVIEW_ARGS),
      text('[codex] $ git status\n'),
    ])
    const [worker, review] = tools(blocks)
    expect(worker.progress).toBeUndefined()
    expect(review.progress).toEqual(['$ git status'])
  })

  it('carries the progress through to the terminal state when the result lands', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ npm test\n'),
      done('codex_worker', 'All green.\n\n[codex ran 1 step(s); last: $ npm test]'),
    ])
    const b = tools(blocks)[0]
    expect(b.running).toBe(false)
    expect(b.output).toContain('All green.')
    // The card keeps the buffer (it decides whether to still SHOW it).
    expect(b.progress).toEqual(['$ npm test'])
  })

  it('marks an aborted codex call aborted even though progress arrived', () => {
    const blocks = pairToolEvents([
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ npm test\n'),
      msg({ type: 'error', message: 'stream died' }),
    ])
    const b = tools(blocks)[0]
    expect(b.aborted).toBe(true)
    expect(b.progress).toEqual(['$ npm test'])
  })

  it('does not disturb ordinary assistant prose around a codex call', () => {
    const blocks = pairToolEvents([
      text('Delegating this to Codex.'),
      call('codex_worker', CODEX_ARGS),
      text('[codex] $ npm test\n'),
      done('codex_worker', 'done'),
      text('Codex says it passes.'),
    ])
    const evs = events(blocks)
    expect(evs).toHaveLength(2)
    expect(evs.map(e => (e as { event: { text?: string } }).event.text))
      .toEqual(['Delegating this to Codex.', 'Codex says it passes.'])
  })
})
