// apps/desktop/test/unit/chatRecall.test.ts
//
// BATCH33 STAGE 2 — the scored recall surface over the chat FTS5 index.
//
// Two halves, both real:
//  * the RERANK is exercised against a genuinely seeded wasm-SQLite FTS5 index
//    over temp conversation JSON (same trick chatSearch.test.ts uses — the
//    engine is wasm, so vitest and electron main run identical code);
//  * the PRIVACY contract is pinned by acting on the world the way the app does
//    (unlink the conversation JSON, exactly as chat:delete-conversation does)
//    and asserting recall stops returning it.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatIndex } from '../../electron/services/chat-search-service'
import {
  recallFromIndex,
  buildRecallBlock,
  type ChatSearchLike,
  type ChatRecallSnippet,
} from '../../electron/services/chat-recall-service'

const convDir = mkdtempSync(join(tmpdir(), 'tachi-recall-conv-'))
const idxDir = mkdtempSync(join(tmpdir(), 'tachi-recall-idx-'))

function writeConv(id: string, title: string, texts: string[], updatedAt = '2026-07-27T00:00:00Z') {
  writeFileSync(join(convDir, `${id}.json`), JSON.stringify({
    id, title, updatedAt,
    messages: texts.map((t, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: t })),
  }))
}

const index = createChatIndex({ conversationsDir: convDir, indexDir: idxDir })

afterAll(() => {
  index.close()
  rmSync(convDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(idxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ── The seeded corpus ────────────────────────────────────────────────────────
// c-deploy is the RIGHT answer for a "deploy the installer with NSIS" query:
// it covers every content word. c-noise mentions "installer" once inside an
// otherwise unrelated turn — the kind of hit bm25 happily floats.
writeConv('c-deploy', 'Release engineering', [
  'how do I deploy the packaged installer with NSIS?',
  'Run the NSIS installer build, then deploy the packaged artifact to the release folder.',
])
writeConv('c-noise', 'Random chatter', [
  'the installer took ages, anyway what is for lunch',
  'no idea, maybe pasta',
])
writeConv('c-doomed', 'To be deleted', [
  'remember the secret pineapple codeword for the NSIS deploy',
  'noted, pineapple it is',
])

describe('recallFromIndex — FTS5 candidates, lexical rerank', () => {
  it('returns scored snippets carrying conversation + turn provenance', () => {
    const out = recallFromIndex(index, 'deploy the packaged NSIS installer')
    expect(out.length).toBeGreaterThan(0)
    const top = out[0]
    expect(top.conversationId).toBe('c-deploy')
    expect(typeof top.turnIndex).toBe('number')
    expect(top.title).toBe('Release engineering')
    expect(['user', 'assistant']).toContain(top.role)
    expect(top.score).toBeGreaterThan(0)
    expect(top.updatedAt).toBe('2026-07-27T00:00:00Z')
  })

  it('ranks the turn that covers the whole query above an incidental keyword hit', () => {
    const out = recallFromIndex(index, 'deploy the packaged NSIS installer', { topK: 10 })
    const deploy = out.findIndex(s => s.conversationId === 'c-deploy')
    const noise = out.findIndex(s => s.conversationId === 'c-noise')
    expect(deploy).toBeGreaterThanOrEqual(0)
    // Either the noise turn is reranked below the real answer, or it fails the
    // score floor and never surfaces at all — both are the correct outcome.
    if (noise >= 0) expect(deploy).toBeLessThan(noise)
    expect(out.map(s => s.score)).toEqual([...out.map(s => s.score)].sort((a, b) => b - a))
  })

  it('strips the FTS5 highlight markers so the model reads plain prose', () => {
    const out = recallFromIndex(index, 'NSIS installer')
    expect(out.length).toBeGreaterThan(0)
    for (const s of out) {
      expect(s.text).not.toContain('«')
      expect(s.text).not.toContain('»')
    }
  })

  it('honours topK and returns nothing for a blank query', () => {
    expect(recallFromIndex(index, 'NSIS deploy installer packaged', { topK: 1 })).toHaveLength(1)
    expect(recallFromIndex(index, '   ')).toEqual([])
  })

  it('drops candidates that share no content word with the query (score floor)', () => {
    // The engine can match on a stopword-only overlap; the rerank must not.
    const out = recallFromIndex(index, 'zzzqqq nonexistent term')
    expect(out).toEqual([])
  })

  it('dedupes the same (conversation, turn) reached twice', () => {
    const twice: ChatSearchLike = {
      search: () => ({
        mode: 'fts',
        hits: [
          { convId: 'a', title: 'A', turnIndex: 0, role: 'user', snippet: 'nsis deploy', updatedAt: '' },
          { convId: 'a', title: 'A', turnIndex: 0, role: 'user', snippet: 'nsis deploy', updatedAt: '' },
        ],
      }),
    }
    expect(recallFromIndex(twice, 'nsis deploy')).toHaveLength(1)
  })
})

describe('privacy: recall inherits chat-search gating exactly', () => {
  it('a DELETED conversation stops being recallable on the next call', () => {
    // Present before deletion…
    const before = recallFromIndex(index, 'pineapple codeword NSIS deploy', { topK: 10 })
    expect(before.some(s => s.conversationId === 'c-doomed')).toBe(true)

    // …the app deletes a chat by unlinking its JSON (chat.ipc.ts
    // 'chat:delete-conversation'); search() re-syncs on every call, which drops
    // the vanished conversation's rows from BOTH tables.
    unlinkSync(join(convDir, 'c-doomed.json'))

    const after = recallFromIndex(index, 'pineapple codeword NSIS deploy', { topK: 10 })
    expect(after.some(s => s.conversationId === 'c-doomed')).toBe(false)
    // The deleted TEXT is gone too, not just the id.
    expect(after.map(s => s.text).join(' ')).not.toContain('pineapple')
    // …and the rest of the corpus is unaffected.
    expect(recallFromIndex(index, 'deploy the packaged NSIS installer').length).toBeGreaterThan(0)
  })

  it('has no private-mode branch of its own — parity with the conversation_search tool', () => {
    // Pinned deliberately: chat-search is local, read-only and offline, and
    // loop.ts exposes conversation_search unconditionally for that reason. If
    // someone ever adds a privateMode gate to chat-search, this assertion is
    // the reminder that recall must gain the same one.
    const src = readSource('electron/services/chat-search-service.ts')
    expect(src).not.toContain('privateMode')
    const recallSrc = readSource('electron/services/chat-recall-service.ts')
    expect(recallSrc).not.toContain('opts.privateMode')
    // Recall reaches the index through search(), the one path that re-syncs.
    expect(recallSrc).toContain('index.search(q, candidateLimit)')
  })

  it('never reaches the conversation JSON directly — only through the index', () => {
    const recallSrc = readSource('electron/services/chat-recall-service.ts')
    expect(recallSrc).not.toContain('readFileSync')
    expect(recallSrc).not.toContain('readdirSync')
  })
})

describe('buildRecallBlock — budgeted, sandbox-wrapped', () => {
  const snips = (n: number): ChatRecallSnippet[] =>
    Array.from({ length: n }, (_, i) => ({
      text: `snippet ${i} `.repeat(40),
      conversationId: `c${i}`,
      title: `T${i}`,
      turnIndex: i,
      role: 'user',
      score: 1 - i * 0.1,
      updatedAt: '',
    }))

  it('returns null when there is nothing to inject', () => {
    expect(buildRecallBlock([], { maxChars: 800, wrap: s => s })).toBeNull()
  })

  it('respects the char budget and keeps provenance in each line', () => {
    const block = buildRecallBlock(snips(6), { maxChars: 600, wrap: s => s })
    expect(block).not.toBeNull()
    const body = block!.split('\n').filter(l => l.startsWith('- ')).join('\n')
    // packContext's budget is over the item texts; the '- ' bullets are ours.
    expect(body.length - 2 * body.split('\n').length).toBeLessThanOrEqual(600)
    expect(body).toContain('id=c0')
    expect(body).toContain('turn 0')
  })

  it('routes the body through the untrusted wrapper (prompt-injection seam)', () => {
    let wrappedWith = ''
    const block = buildRecallBlock(snips(2), {
      maxChars: 900,
      wrap: (content, source) => { wrappedWith = source; return `[WRAPPED]${content}[/WRAPPED]` },
    })
    expect(wrappedWith).toBe('chat_recall')
    expect(block).toContain('[WRAPPED]')
    expect(block).toContain('<recalled-conversations>')
    expect(block!.trimEnd().endsWith('</recalled-conversations>')).toBe(true)
  })
})

// Source-reading helper for the two wiring assertions above.
function readSource(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  return fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
}
