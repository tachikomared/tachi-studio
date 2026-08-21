// apps/desktop/test/unit/memoryFacts.test.ts
//
// Structured persistent-memory facts (USER-PAINS T16). Covers the three risky,
// hard-to-click-verify seams:
//   1. Migration blob -> facts, and the STORE's once-only idempotency.
//   2. Budget join (enabled-only, ordered) + over-budget accounting.
//   3. Auto-capture heuristic precision — with negative cases so it does not spam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  splitBlobToFactTexts,
  migrateBlobToFacts,
  joinEnabledFacts,
  factsBudget,
  FACT_BUDGET_CHARS,
  detectCaptureCandidate,
  type MemoryFact,
} from '@tachi/core'
// The PURE store module — memory-facts-service.ts is the electron-coupled
// singleton (static imports of electron/settings-store) and is deliberately not
// importable from vitest.
import { MemoryFactsStore, safeInjection } from '../../electron/services/memory-facts-store'

// ── deterministic generators ──────────────────────────────────────────────────
function seqIdGen() {
  let n = 0
  return () => `id-${++n}`
}
const FIXED_NOW = () => '2026-07-24T00:00:00.000Z'

function fact(text: string, enabled = true, source: 'user' | 'auto' = 'user'): MemoryFact {
  return { id: text, text, source, createdAt: FIXED_NOW(), enabled }
}

// ── 1. Migration (pure) ───────────────────────────────────────────────────────

describe('splitBlobToFactTexts', () => {
  it('splits non-empty lines, strips list markers, trims', () => {
    const blob = '- always use tabs\n1. prefer pnpm\n  • call me D  \nplain line'
    expect(splitBlobToFactTexts(blob)).toEqual([
      'always use tabs', 'prefer pnpm', 'call me D', 'plain line',
    ])
  })

  it('drops blank lines and de-duplicates case-insensitively (first wins)', () => {
    const blob = 'Use metric units\n\n\nuse metric units\nUse Metric Units\nSomething else'
    expect(splitBlobToFactTexts(blob)).toEqual(['Use metric units', 'Something else'])
  })

  it('returns [] for empty / whitespace blobs', () => {
    expect(splitBlobToFactTexts('')).toEqual([])
    expect(splitBlobToFactTexts('   \n\n  ')).toEqual([])
  })
})

describe('migrateBlobToFacts', () => {
  it('maps each line to an enabled user fact with injected id/clock', () => {
    const facts = migrateBlobToFacts('line one\nline two', { now: FIXED_NOW, idGen: seqIdGen() })
    expect(facts).toEqual([
      { id: 'id-1', text: 'line one', source: 'user', createdAt: FIXED_NOW(), enabled: true },
      { id: 'id-2', text: 'line two', source: 'user', createdAt: FIXED_NOW(), enabled: true },
    ])
  })
})

// ── 2. Budget join (pure) ─────────────────────────────────────────────────────

describe('joinEnabledFacts / factsBudget', () => {
  it('joins only ENABLED facts, in order, dropping disabled + blank', () => {
    const facts = [
      fact('a'), fact('b', false), fact('c'), { ...fact('  '), enabled: true },
    ]
    expect(joinEnabledFacts(facts)).toBe('a\nc')
  })

  it('reports over-budget only past the limit', () => {
    const under = [fact('x'.repeat(FACT_BUDGET_CHARS))]
    expect(factsBudget(under)).toEqual({ chars: FACT_BUDGET_CHARS, limit: FACT_BUDGET_CHARS, overBudget: false })

    const over = [fact('x'.repeat(FACT_BUDGET_CHARS)), fact('y')]
    const b = factsBudget(over)
    expect(b.overBudget).toBe(true)
    expect(b.chars).toBe(FACT_BUDGET_CHARS + 2) // + '\n' + 'y'
  })
})

// ── 3. Store persistence + migration idempotency ──────────────────────────────

describe('MemoryFactsStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-facts-'))
    file = path.join(dir, 'memory-facts.json')
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('migrates the legacy blob into facts on first access', () => {
    const store = new MemoryFactsStore(file, () => 'always concise\ncall me D', FIXED_NOW, seqIdGen())
    const list = store.list()
    expect(list.map(f => f.text)).toEqual(['always concise', 'call me D'])
    expect(list.every(f => f.source === 'user' && f.enabled)).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('migrates exactly ONCE — re-reads do not duplicate, deletes are not resurrected', () => {
    const store = new MemoryFactsStore(file, () => 'a\nb\nc', FIXED_NOW, seqIdGen())
    expect(store.list()).toHaveLength(3)
    expect(store.list()).toHaveLength(3) // second read: no re-migration

    const id = store.list()[0]!.id
    expect(store.delete(id)).toBe(true)
    expect(store.list()).toHaveLength(2)

    // A fresh store over the SAME file (blob still present) must not re-migrate.
    const store2 = new MemoryFactsStore(file, () => 'a\nb\nc', FIXED_NOW, seqIdGen())
    expect(store2.list()).toHaveLength(2)
  })

  it('an empty blob still marks migration done (no re-migrate when the blob later fills)', () => {
    let blob = ''
    const store = new MemoryFactsStore(file, () => blob, FIXED_NOW, seqIdGen())
    expect(store.list()).toHaveLength(0)
    blob = 'now I have memory' // would-be new blob content
    expect(store.list()).toHaveLength(0) // file exists -> no re-migration
  })

  it('add rejects blank text, appends enabled facts, and edit/toggle work', () => {
    const store = new MemoryFactsStore(file, () => '', FIXED_NOW, seqIdGen())
    expect(store.add('   ')).toBeNull()

    const f = store.add('prefer TypeScript', 'user')!
    expect(f.text).toBe('prefer TypeScript')
    expect(store.list()).toHaveLength(1)

    expect(store.edit(f.id, 'prefer Rust')!.text).toBe('prefer Rust')
    expect(store.edit('nope', 'x')).toBeNull()
    expect(store.edit(f.id, '   ')).toBeNull()

    expect(store.toggle(f.id, false)!.enabled).toBe(false)
    expect(store.injection()).toBe('') // disabled -> not injected
    store.toggle(f.id, true)
    expect(store.injection()).toBe('prefer Rust')
  })

  it('injection joins enabled facts (auto-capture source included)', () => {
    const store = new MemoryFactsStore(file, () => '', FIXED_NOW, seqIdGen())
    store.add('one', 'user')
    const two = store.add('two', 'auto')!
    store.add('three', 'user')
    store.toggle(two.id, false)
    expect(store.injection()).toBe('one\nthree')
  })

  it('tolerates a corrupt facts file (returns [])', () => {
    fs.writeFileSync(file, '{ not json', 'utf8')
    const store = new MemoryFactsStore(file, () => 'ignored', FIXED_NOW, seqIdGen())
    expect(store.list()).toEqual([])
  })
})

// ── 3b. Fail-soft injection seam (P0 2026-07-25) ──────────────────────────────
//
// chat-service calls this before EVERY provider branch. When it threw, the whole
// send died with zero chunks emitted — chat was silently dead in every packaged
// build. These tests pin the "enhancement, never a precondition" contract.

describe('safeInjection', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-facts-safe-'))
    file = path.join(dir, 'memory-facts.json')
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('returns the trimmed injection when the store is healthy', () => {
    const store = new MemoryFactsStore(file, () => '', FIXED_NOW, seqIdGen())
    store.add('call me D', 'user')
    store.add('always use metric', 'user')
    expect(safeInjection(() => store)).toBe('call me D\nalways use metric')
  })

  it('degrades to "" (never throws) when the STORE ACCESSOR throws', () => {
    // The real regression: getMemoryFactsStore() threw
    // "Cannot find module ./settings-store" inside the packaged bundle.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = () => { throw new Error("Cannot find module './settings-store'") }
    expect(safeInjection(boom)).toBe('')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('degrades to "" when injection() itself throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(safeInjection(() => ({ injection: () => { throw new Error('disk gone') } }))).toBe('')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('a first-access store on a fresh userData initialises and injects the migrated blob', () => {
    // Store init is the path that ran on every packaged send — cover it end to
    // end (file created, blob migrated, injection non-empty).
    expect(fs.existsSync(file)).toBe(false)
    const store = new MemoryFactsStore(file, () => 'prefer pnpm\ncall me D', FIXED_NOW, seqIdGen())
    expect(safeInjection(() => store)).toBe('prefer pnpm\ncall me D')
    expect(fs.existsSync(file)).toBe(true)
  })
})

// ── 4. Auto-capture heuristic precision ───────────────────────────────────────

describe('detectCaptureCandidate — positives (durable preferences / identity)', () => {
  const positives: Array<[string, string]> = [
    ['always use 2-space indentation', 'always use 2-space indentation'],
    ['Never force-push to main', 'Never force-push to main'],
    ['My name is Alex', 'My name is Alex'],
    ['call me Sam please', 'call me Sam please'],
    ['I prefer TypeScript over JavaScript', 'I prefer TypeScript over JavaScript'],
    ['I always want metric units', 'I always want metric units'],
    ['please always respond concisely', 'please always respond concisely'],
    ['remember that I use pnpm', 'remember that I use pnpm'],
    ['я предпочитаю метрическую систему', 'я предпочитаю метрическую систему'],
    ['меня зовут Алекс', 'меня зовут Алекс'],
    ['зови меня Саша', 'зови меня Саша'],
  ]
  for (const [msg, expected] of positives) {
    it(`captures: ${msg}`, () => {
      expect(detectCaptureCandidate(msg)).toBe(expected)
    })
  }

  it('reduces a multi-sentence message to the first sentence', () => {
    expect(detectCaptureCandidate('I prefer dark mode. Ignore the rest.'))
      .toBe('I prefer dark mode.')
  })
})

describe('detectCaptureCandidate — negatives (must NOT spam)', () => {
  const negatives = [
    '',                                   // empty
    '   ',                                // whitespace
    'hello',                              // too short + no cue
    'What is the weather today?',         // question
    'Can you always run the tests?',      // question even with "always"
    'do you prefer tabs or spaces?',      // question with "prefer"
    'The function always returns null',   // "always" mid-sentence, narrative
    'Never mind, forget it',              // stop-phrase
    '/deploy the app to prod',            // slash command
    '```\nconst x = 1\n```',              // code block
    'Please summarize this article for me', // request, no durable-preference cue
    'x'.repeat(300),                      // too long
  ]
  for (const msg of negatives) {
    it(`ignores: ${JSON.stringify(msg.slice(0, 40))}`, () => {
      expect(detectCaptureCandidate(msg)).toBeNull()
    })
  }
})
