// apps/desktop/test/unit/tachiDedup.test.ts
//
// Unit test for the TACHI read-only tool-call dedup (dedup.ts). Ported from the
// agentic-rag retrieval_keys set: a per-run set of fingerprints for read-only
// retrievals so an EXACT repeat of a read/grep/glob within the run does not
// re-burn its full output into context. The win is context tokens, not compute.
//
// Invalidation rule (conservative, sound): any successful mutator (write/edit/
// bash) clears ALL recorded read fingerprints, because a mutation may have
// changed what a re-read would return.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { DedupSet, dedupFingerprint } from '../../electron/services/tachi/dedup'
import { fingerprint } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

describe('dedupFingerprint', () => {
  it('matches the @tachi/core fingerprint (shared identity, key-order independent)', () => {
    expect(dedupFingerprint('read', { path: '/a', limit: 10 })).toBe(fingerprint('read', { path: '/a', limit: 10 }))
    expect(dedupFingerprint('read', { limit: 10, path: '/a' })).toBe(dedupFingerprint('read', { path: '/a', limit: 10 }))
  })

  it('differs for different tools / args', () => {
    expect(dedupFingerprint('read', { path: '/a' })).not.toBe(dedupFingerprint('grep', { path: '/a' }))
    expect(dedupFingerprint('read', { path: '/a' })).not.toBe(dedupFingerprint('read', { path: '/b' }))
  })
})

describe('DedupSet — read-only short-circuit', () => {
  it('first read-only call is not a duplicate; identical repeat is', () => {
    const d = new DedupSet()
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
    d.record('read', { path: '/a' })
    expect(d.seenBefore('read', { path: '/a' })).toBe(true)
  })

  it('repeat is detected regardless of arg key order', () => {
    const d = new DedupSet()
    d.record('read', { path: '/a', limit: 5 })
    expect(d.seenBefore('read', { limit: 5, path: '/a' })).toBe(true)
  })

  it('different read args are not deduped', () => {
    const d = new DedupSet()
    d.record('read', { path: '/a' })
    expect(d.seenBefore('read', { path: '/b' })).toBe(false)
    expect(d.seenBefore('grep', { pattern: 'x' })).toBe(false)
  })

  it('grep and glob are also deduped (read-only set)', () => {
    const d = new DedupSet()
    d.record('grep', { pattern: 'TODO' })
    d.record('glob', { pattern: '**/*.ts' })
    expect(d.seenBefore('grep', { pattern: 'TODO' })).toBe(true)
    expect(d.seenBefore('glob', { pattern: '**/*.ts' })).toBe(true)
  })
})

describe('DedupSet — non-read tools are never deduped', () => {
  it('write/edit/bash never report seenBefore and recording them is a no-op for dedup', () => {
    const d = new DedupSet()
    expect(d.seenBefore('write', { path: '/a', content: 'x' })).toBe(false)
    d.record('write', { path: '/a', content: 'x' })
    // even after "recording", a mutator is never considered a prior read result
    expect(d.seenBefore('write', { path: '/a', content: 'x' })).toBe(false)
    expect(d.seenBefore('edit', { path: '/a', oldString: 'x', newString: 'y' })).toBe(false)
    expect(d.seenBefore('bash', { command: 'ls' })).toBe(false)
  })

  it('unknown tool names are never deduped', () => {
    const d = new DedupSet()
    expect(d.seenBefore('frobnicate', {})).toBe(false)
    d.record('frobnicate', {})
    expect(d.seenBefore('frobnicate', {})).toBe(false)
  })

  it('isReadOnly identifies exactly read/grep/glob', () => {
    expect(DedupSet.isReadOnly('read')).toBe(true)
    expect(DedupSet.isReadOnly('grep')).toBe(true)
    expect(DedupSet.isReadOnly('glob')).toBe(true)
    expect(DedupSet.isReadOnly('write')).toBe(false)
    expect(DedupSet.isReadOnly('edit')).toBe(false)
    expect(DedupSet.isReadOnly('bash')).toBe(false)
    expect(DedupSet.isReadOnly('frobnicate')).toBe(false)
  })
})

describe('DedupSet — mutator invalidation', () => {
  it('a successful mutator clears ALL recorded read fingerprints', () => {
    const d = new DedupSet()
    d.record('read', { path: '/a' })
    d.record('grep', { pattern: 'x' })
    expect(d.seenBefore('read', { path: '/a' })).toBe(true)

    d.invalidateAfterMutation()

    // After a mutation a re-read must run again (output may have changed).
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
    expect(d.seenBefore('grep', { pattern: 'x' })).toBe(false)
  })

  it('a re-read after invalidation can be recorded and deduped afresh', () => {
    const d = new DedupSet()
    d.record('read', { path: '/a' })
    d.invalidateAfterMutation()
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
    d.record('read', { path: '/a' })
    expect(d.seenBefore('read', { path: '/a' })).toBe(true)
  })

  it('afterExecute records a successful read so its repeat short-circuits', () => {
    const d = new DedupSet()
    d.afterExecute('read', { path: '/a' }, true)
    expect(d.seenBefore('read', { path: '/a' })).toBe(true)
  })

  it('afterExecute does NOT record a failed read', () => {
    const d = new DedupSet()
    d.afterExecute('read', { path: '/a' }, false)
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
  })

  it('afterExecute invalidates recorded reads after a SUCCESSFUL mutator', () => {
    const d = new DedupSet()
    d.afterExecute('read', { path: '/a' }, true)
    d.afterExecute('write', { path: '/a', content: 'z' }, true)
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
  })

  it('afterExecute invalidates recorded reads after a FAILED mutator (regression)', () => {
    // A bash/write that exits non-zero may have mutated the workspace first
    // (script writes a file then exits 1). The stale read MUST be invalidated.
    const d = new DedupSet()
    d.afterExecute('read', { path: '/a' }, true)
    d.afterExecute('bash', { command: 'sh ./write-then-fail.sh' }, false)
    expect(d.seenBefore('read', { path: '/a' })).toBe(false)
  })
})

describe('DedupSet — per-run isolation', () => {
  it('two independent sets do not share fingerprints', () => {
    const a = new DedupSet()
    const b = new DedupSet()
    a.record('read', { path: '/shared' })
    expect(a.seenBefore('read', { path: '/shared' })).toBe(true)
    expect(b.seenBefore('read', { path: '/shared' })).toBe(false)
  })
})

// ─── Loop wiring: dedup short-circuits a repeat read through the real loop ─────
// Drives runTachiLoop with a mock model (no network, no electron) against a real
// temp workspace, proving the dedup is actually wired into the tool-execution
// path: a non-consecutive repeat read returns the short pointer, and a mutator
// between two identical reads forces the second read to re-execute.
const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

/** Mock model that emits a scripted sequence of tool calls then a final text. */
function scriptedModel(steps: Array<{ name: string; input: unknown }>): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[call]
      call++
      if (step) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: `t${call}`, toolName: step.name, input: JSON.stringify(step.input) },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'done' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

async function runLoop(model: MockLanguageModelV3, ws: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6',
    workspaceRoot: ws,
    task: 'inspect the file',
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate: async () => true,
  })
  return events
}

describe('dedup wired into runTachiLoop (mock model, real workspace)', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-dedup-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('a non-consecutive repeat read short-circuits to the reuse pointer', async () => {
    writeFileSync(join(ws, 'doc.txt'), 'alpha\nbeta\ngamma\n')
    // read doc.txt, read other.txt, read doc.txt again (non-consecutive repeat).
    writeFileSync(join(ws, 'other.txt'), 'zzz')
    const model = scriptedModel([
      { name: 'read', input: { path: 'doc.txt' } },
      { name: 'read', input: { path: 'other.txt' } },
      { name: 'read', input: { path: 'doc.txt' } },
    ])
    const events = await runLoop(model, ws)
    const dones = events.filter(e => e.type === 'tool-done') as Array<Extract<AgentEvent, { type: 'tool-done' }>>
    expect(dones.length).toBe(3)
    // first doc read: real content; second other read: real content; third: pointer.
    expect(dones[0].output).toContain('alpha')
    expect(dones[2].output).toContain('reuse that earlier result')
    expect(dones[2].output).not.toContain('alpha') // full output NOT re-emitted
    expect(events[events.length - 1].type).toBe('done')
  })

  it('a mutator between two identical reads forces the second read to re-run', async () => {
    writeFileSync(join(ws, 'doc.txt'), 'before-edit\n')
    const model = scriptedModel([
      { name: 'read', input: { path: 'doc.txt' } },
      { name: 'write', input: { path: 'doc.txt', content: 'after-edit\n' } },
      { name: 'read', input: { path: 'doc.txt' } },
    ])
    const events = await runLoop(model, ws)
    const dones = events.filter(e => e.type === 'tool-done') as Array<Extract<AgentEvent, { type: 'tool-done' }>>
    expect(dones.length).toBe(3)
    expect(dones[0].output).toContain('before-edit')
    // The write invalidated the read cache, so the re-read returns the NEW content,
    // not the reuse pointer.
    expect(dones[2].output).not.toContain('reuse that earlier result')
    expect(dones[2].output).toContain('after-edit')
  })
})
