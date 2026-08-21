// apps/desktop/test/unit/markdownToBlocks.test.ts
//
// curator-service imports keychain (electron/native) at module load; mock it so
// only the pure markdownToBlocks parser is exercised.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => null }))

import { markdownToBlocks, fallbackPlaybook } from '../../electron/services/curator-service'

const jsonl = (turns: Array<Record<string, unknown>>) => turns.map(t => JSON.stringify(t)).join('\n')

describe('fallbackPlaybook (no-LLM trace summary)', () => {
  it('returns "" for an empty / unparseable trace', () => {
    expect(fallbackPlaybook('')).toBe('')
    expect(fallbackPlaybook('not json\n{bad')).toBe('')
  })

  it('extracts the goal from the first user turn', () => {
    const out = fallbackPlaybook(jsonl([
      { role: 'user', content: 'Fix the login bug' },
      { role: 'assistant', content: 'looking into it' },
    ]))
    expect(out).toContain('## Goal')
    expect(out).toContain('Fix the login bug')
  })

  it('counts tools used and lists decisions', () => {
    const out = fallbackPlaybook(jsonl([
      { role: 'user', content: 'Refactor auth' },
      { role: 'tool-call', name: 'fs_read' },
      { role: 'tool-call', name: 'fs_write' },
      { role: 'tool-call', name: 'fs_write' },
      { role: 'assistant', content: 'I decided to use bcrypt for hashing' },
    ]))
    expect(out).toContain('## Tools used')
    expect(out).toContain('fs_write (x2)')
    expect(out).toContain('fs_read')
    expect(out).toContain('## Notes')
    expect(out).toContain('bcrypt')
  })

  it('returns "" when there is no goal and no tool activity (decisions alone are too weak)', () => {
    expect(fallbackPlaybook(jsonl([{ role: 'assistant', content: 'I chose X' }]))).toBe('')
  })
})

describe('markdownToBlocks', () => {
  it('parses level-1 and level-2 headings', () => {
    expect(markdownToBlocks('# Title')).toEqual([{ type: 'heading', level: 1, text: 'Title' }])
    expect(markdownToBlocks('## Goal')).toEqual([{ type: 'heading', level: 2, text: 'Goal' }])
  })

  it('parses - and * bullets', () => {
    expect(markdownToBlocks('- one\n* two')).toEqual([
      { type: 'bullet', text: 'one' },
      { type: 'bullet', text: 'two' },
    ])
  })

  it('parses a fenced code block with a language tag', () => {
    expect(markdownToBlocks('```ts\nconst x = 1\nconst y = 2\n```')).toEqual([
      { type: 'code', lang: 'ts', text: 'const x = 1\nconst y = 2' },
    ])
  })

  it('skips blank lines and keeps plain text', () => {
    expect(markdownToBlocks('## Approach\n\nWe did the thing.')).toEqual([
      { type: 'heading', level: 2, text: 'Approach' },
      { type: 'text', text: 'We did the thing.' },
    ])
  })

  it('flushes an unclosed code fence as a code block', () => {
    expect(markdownToBlocks('```\nno close')).toEqual([{ type: 'code', lang: undefined, text: 'no close' }])
  })

  it('falls back to a single text block for plain input', () => {
    expect(markdownToBlocks('just a sentence')).toEqual([{ type: 'text', text: 'just a sentence' }])
  })
})
