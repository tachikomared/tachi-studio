// apps/desktop/test/unit/reflexion.test.ts
//
// Reflexion — structured failure memory recalled on similar tasks
// (STEAL: all-agentic-architectures/architectures/reflexion.py). After a
// failed/partial run we store a (rootCause, correction, lesson) reflection
// keyed to the task; on a future SIMILAR task we recall the top-k by LEXICAL
// overlap (@tachi/core recall — TachiDesk has no embedder) and prepend them as
// a prior. These tests exercise the electron-free injected-path API the same
// way costLedger.test.ts / mcpAuditLog.test.ts do (real temp dir, no electron).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReflectionStore,
  buildReflexionContext,
  type Reflection,
} from '../../electron/services/session-memory-service'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reflexion-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

function makeStore(nowMs = { t: 1_718_200_000_000 }): ReflectionStore {
  return new ReflectionStore(join(dir, 'reflections.jsonl'), () => nowMs.t)
}

describe('ReflectionStore.addReflection', () => {
  it('persists one parseable JSONL line per reflection (injected path)', () => {
    const file = join(dir, 'reflections.jsonl')
    const store = makeStore()
    store.addReflection({
      task: 'Fix the failing vitest suite for the wallet risk breaker',
      rootCause: 'The mock signer returned undefined so the breaker never tripped',
      correction: 'Stub the signer to return a populated balance before asserting',
      lesson: 'When testing the wallet breaker, populate the signer mock first',
    })
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Reflection
    expect(parsed).toMatchObject({
      task: 'Fix the failing vitest suite for the wallet risk breaker',
      rootCause: 'The mock signer returned undefined so the breaker never tripped',
      correction: 'Stub the signer to return a populated balance before asserting',
      lesson: 'When testing the wallet breaker, populate the signer mock first',
    })
    expect(typeof parsed.ts).toBe('number')
  })

  it('stamps ts from the clock when the caller omits it', () => {
    const now = { t: 42 }
    const store = makeStore(now)
    const r = store.addReflection({ task: 't', rootCause: 'rc', correction: 'c', lesson: 'l' })
    expect(r.ts).toBe(42)
  })

  it('honours a caller-supplied ts', () => {
    const store = makeStore()
    const r = store.addReflection({ task: 't', rootCause: 'rc', correction: 'c', lesson: 'l', ts: 7 })
    expect(r.ts).toBe(7)
  })
})

describe('ReflectionStore.recallReflections', () => {
  function seed(store: ReflectionStore) {
    store.addReflection({
      task: 'Fix the failing wallet risk breaker test',
      rootCause: 'signer mock returned undefined balance',
      correction: 'populate the signer mock balance first',
      lesson: 'wallet breaker tests need a populated signer balance mock',
    })
    store.addReflection({
      task: 'Add a sparkline to the observability pulse dashboard',
      rootCause: 'forgot to downsample so the svg path blew up',
      correction: 'run LTTB downsampling before building the path',
      lesson: 'sparkline rendering must LTTB downsample dense series first',
    })
    store.addReflection({
      task: 'Migrate the catalog i18n strings to JSON namespaces',
      rootCause: 'left a stray ru key that broke the en-default lookup',
      correction: 'strip stashed locale keys before shipping',
      lesson: 'catalog i18n migration must keep only the active locale keys',
    })
  }

  it('ranks the most lexically relevant reflection first', () => {
    const store = makeStore()
    seed(store)
    const out = store.recallReflections('the wallet risk breaker test is failing again')
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]!.lesson).toContain('wallet breaker')
  })

  it('respects k (caps the number returned)', () => {
    const store = makeStore()
    seed(store)
    // A query that overlaps every stored task/lesson term broadly.
    const out = store.recallReflections('failing test dashboard migration breaker sparkline catalog', 2)
    expect(out.length).toBeLessThanOrEqual(2)
  })

  it('dedups near-identical lessons so distinct lessons fill the slots', () => {
    const store = makeStore()
    // The same wallet-breaker lesson re-logged across 3 failed runs (exact +
    // case/punctuation variant), plus one genuinely distinct lesson.
    store.addReflection({ task: 'wallet risk breaker test failing', rootCause: 'rc', correction: 'c', lesson: 'wallet breaker tests need a populated signer balance mock' })
    store.addReflection({ task: 'wallet risk breaker test failing again', rootCause: 'rc', correction: 'c', lesson: 'wallet breaker tests need a populated signer balance mock' })
    store.addReflection({ task: 'wallet risk breaker keeps failing', rootCause: 'rc', correction: 'c', lesson: 'Wallet breaker tests need a populated signer balance mock.' })
    store.addReflection({ task: 'wallet breaker mock setup order', rootCause: 'rc', correction: 'c', lesson: 'set the wallet mock before constructing the breaker instance' })

    const out = store.recallReflections('wallet breaker test failing mock', 3)
    const dupCount = out.filter(r => r.lesson.toLowerCase().includes('populated signer balance mock')).length
    expect(dupCount).toBe(1) // the 3 near-identical lessons collapse to one slot
  })

  it('returns nothing when no stored reflection overlaps the query', () => {
    const store = makeStore()
    seed(store)
    const out = store.recallReflections('zzzqqq nonexistent unrelated gibberish token')
    expect(out).toEqual([])
  })

  it('returns nothing when the store is empty', () => {
    const store = makeStore()
    expect(store.recallReflections('anything at all')).toEqual([])
  })
})

describe('ReflectionStore persistence (round-trip)', () => {
  it('a fresh instance over the same file recalls prior reflections', () => {
    const now = { t: 100 }
    makeStore(now).addReflection({
      task: 'Fix the failing wallet risk breaker test',
      rootCause: 'signer mock returned undefined balance',
      correction: 'populate the signer mock balance first',
      lesson: 'wallet breaker tests need a populated signer balance mock',
    })
    const reloaded = makeStore(now)
    const out = reloaded.recallReflections('wallet breaker test failing')
    expect(out.length).toBe(1)
    expect(out[0]!.lesson).toContain('wallet breaker')
  })

  it('tolerates a malformed/corrupt line without throwing', () => {
    const file = join(dir, 'reflections.jsonl')
    const store = makeStore()
    store.addReflection({ task: 'wallet breaker test', rootCause: 'rc', correction: 'c', lesson: 'wallet breaker lesson' })
    // Append junk directly.
    require('node:fs').appendFileSync(file, 'not-json\n', 'utf8')
    const reloaded = makeStore()
    expect(() => reloaded.recallReflections('wallet breaker')).not.toThrow()
    expect(reloaded.recallReflections('wallet breaker')[0]!.lesson).toContain('wallet breaker lesson')
  })
})

describe('buildReflexionContext', () => {
  it('is empty when the store has no data', () => {
    const store = makeStore()
    expect(store.buildReflexionContext('any task')).toBe('')
  })

  it('is empty when nothing overlaps the task', () => {
    const store = makeStore()
    store.addReflection({ task: 'sparkline downsampling', rootCause: 'rc', correction: 'c', lesson: 'LTTB the series' })
    expect(store.buildReflexionContext('totally unrelated zzzqqq topic')).toBe('')
  })

  it('contains the lesson text (and correction) for a relevant past attempt', () => {
    const store = makeStore()
    store.addReflection({
      task: 'Fix the failing wallet risk breaker test',
      rootCause: 'signer mock returned undefined balance',
      correction: 'populate the signer mock balance first',
      lesson: 'wallet breaker tests need a populated signer balance mock',
    })
    const ctx = store.buildReflexionContext('the wallet risk breaker test keeps failing')
    expect(ctx).toContain('Lessons from similar past attempts')
    expect(ctx).toContain('wallet breaker tests need a populated signer balance mock')
    expect(ctx).toContain('populate the signer mock balance first')
  })
})

// The module-level convenience used by the prompt builder (NO-TOUCH consumer
// wires this). It delegates to the electron-singleton store; here we only
// assert the standalone helper degrades to empty for a null store so callers
// can safely string-concat its output.
describe('buildReflexionContext (standalone helper)', () => {
  it('returns empty string for an empty reflection list', () => {
    expect(buildReflexionContext([], 'task')).toBe('')
  })

  it('renders a compact block from a recalled list', () => {
    const recalled: Reflection[] = [{
      task: 'Fix the failing wallet risk breaker test',
      rootCause: 'signer mock returned undefined balance',
      correction: 'populate the signer mock balance first',
      lesson: 'wallet breaker tests need a populated signer balance mock',
      ts: 1,
    }]
    const block = buildReflexionContext(recalled, 'wallet breaker test failing')
    expect(block).toContain('Lessons from similar past attempts')
    expect(block).toContain('wallet breaker tests need a populated signer balance mock')
  })
})
