import { describe, it, expect } from 'vitest'
import { parseDarksolEvent } from './darksol-events'
import type { AgentEvent } from './types'

describe('parseDarksolEvent', () => {
  it('returns [] for malformed JSON', () => {
    expect(parseDarksolEvent('not json')).toEqual([])
    expect(parseDarksolEvent('')).toEqual([])
    expect(parseDarksolEvent('null')).toEqual([])
  })

  it('run-start emits nothing (lifecycle marker, not renderable)', () => {
    expect(parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'run-start', sessionId: 's' }))).toEqual([])
  })

  it('progress → text (flat `text` field)', () => {
    const out = parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'progress', text: 'thinking…' }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'text', text: 'thinking…' }])
  })

  it('progress → text (nested `event` payload)', () => {
    // harness.js wraps progress as { type:'progress', event: {...} } — tolerate both shapes.
    const out = parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'progress', event: { message: 'step 2/5' } }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'text', text: 'step 2/5' }])
  })

  it('progress with no extractable text → []', () => {
    expect(parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'progress', event: {} }))).toEqual([])
  })

  it('tool invocation → tool-call (name + JSON-stringified input)', () => {
    const out = parseDarksolEvent(JSON.stringify({
      timestamp: 't', type: 'tool',
      event: { phase: 'start', name: 'swap', input: { from: 'ETH', to: 'USDC', amount: '0.1' } },
    }))
    expect(out).toEqual<AgentEvent[]>([
      { type: 'tool-call', name: 'swap', input: JSON.stringify({ from: 'ETH', to: 'USDC', amount: '0.1' }) },
    ])
  })

  it('tool result → tool-done (name + stringified output)', () => {
    const out = parseDarksolEvent(JSON.stringify({
      timestamp: 't', type: 'tool',
      event: { phase: 'result', name: 'price', output: { symbol: 'ETH', usd: 3210.5 } },
    }))
    expect(out).toEqual<AgentEvent[]>([
      { type: 'tool-done', name: 'price', output: JSON.stringify({ symbol: 'ETH', usd: 3210.5 }) },
    ])
  })

  it('tool result tolerates `status`/`result` field-name variants', () => {
    const out = parseDarksolEvent(JSON.stringify({
      timestamp: 't', type: 'tool',
      event: { status: 'done', tool: 'portfolio', result: 'ok' },
    }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'tool-done', name: 'portfolio', output: '"ok"' }])
  })

  it('run-final success → done with stopReason', () => {
    const out = parseDarksolEvent(JSON.stringify({
      timestamp: 't', type: 'run-final', status: 'success', stopReason: 'completed', final: 'all set',
    }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'done', reason: 'completed' }])
  })

  it('run-final failure → error', () => {
    const out = parseDarksolEvent(JSON.stringify({
      timestamp: 't', type: 'run-final', status: 'failed', stopReason: 'tool-error', final: 'swap reverted',
    }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'error', message: 'swap reverted' }])
  })

  it('run-final failure with no message falls back to stopReason', () => {
    const out = parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'run-final', status: 'failed', stopReason: 'aborted' }))
    expect(out).toEqual<AgentEvent[]>([{ type: 'error', message: 'aborted' }])
  })

  it('unknown type → []', () => {
    expect(parseDarksolEvent(JSON.stringify({ timestamp: 't', type: 'heartbeat' }))).toEqual([])
  })
})
