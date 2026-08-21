// apps/desktop/test/unit/backup.test.ts — pure backup/export helpers.
import { describe, it, expect } from 'vitest'
import { buildBackup, parseBackup, mergeById, safeFileName, conversationToMarkdown } from '../../src/lib/backup'

describe('buildBackup / parseBackup', () => {
  it('round-trips a v1 document and stamps app identity', () => {
    const doc = buildBackup({ chats: [{ id: 'c1' }], prompts: [{ id: 'p1' }] })
    const back = parseBackup(JSON.stringify(doc))
    expect(back?.v).toBe(1)
    expect(back?.app).toBe('tachi-studio')
    expect(back?.chats).toHaveLength(1)
    expect(back?.design).toBeUndefined() // omitted sections stay absent
  })
  it('rejects foreign or broken json', () => {
    expect(parseBackup('{"v":1,"app":"other"}')).toBeNull()
    expect(parseBackup('not json')).toBeNull()
  })
})

describe('mergeById', () => {
  it('appends only unseen ids — existing (newer local) wins', () => {
    const existing = [{ id: 'a', x: 1 }, { id: 'b', x: 2 }]
    const incoming = [{ id: 'b', x: 99 }, { id: 'c', x: 3 }]
    const { merged, added } = mergeById(existing, incoming)
    expect(added).toBe(1)
    expect(merged.map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(merged.find(m => m.id === 'b')?.x).toBe(2) // not clobbered
  })
})

describe('safeFileName', () => {
  it('strips path-hostile characters and caps length', () => {
    expect(safeFileName('what: is <RAG>? / a\\b | "quote"')).toBe('what is RAG a b quote')
    expect(safeFileName('')).toBe('untitled')
    expect(safeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('conversationToMarkdown', () => {
  it('renders headers per turn and skips empty content', () => {
    const md = conversationToMarkdown(
      {
        title: 'Trip plan', createdAt: '2026-07-06', providerId: 'freellmapi', model: 'auto',
        messages: [
          { role: 'user', content: 'where to go?' },
          { role: 'assistant', content: '' },
          { role: 'assistant', content: 'Kyoto in autumn.' },
        ],
      },
      c => String(c),
    )
    expect(md).toContain('# Trip plan')
    expect(md).toContain('provider: freellmapi · auto')
    expect(md).toContain('## You')
    expect(md.match(/## Assistant/g)).toHaveLength(1) // empty turn skipped
    expect(md).toContain('Kyoto in autumn.')
  })
})
