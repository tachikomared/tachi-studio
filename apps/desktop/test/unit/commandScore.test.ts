// apps/desktop/test/unit/commandScore.test.ts
import { describe, it, expect } from 'vitest'
import { scoreMatch, scoreMatchMulti, rankItems, SCORE } from '../../src/utils/command-score'

describe('scoreMatch tiers', () => {
  it('scores exact > prefix > word-prefix > substring > subsequence > no-match', () => {
    const exact   = scoreMatch('go', 'go')
    const prefix  = scoreMatch('go', 'go to chat')
    const word    = scoreMatch('chat', 'go to chat')
    const substr  = scoreMatch('ode', 'nodes')
    const subseq  = scoreMatch('gtc', 'go to chat')
    const none    = scoreMatch('xyz', 'go to chat')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(substr)
    expect(substr).toBeGreaterThan(subseq)
    expect(subseq).toBeGreaterThan(none)
    expect(none).toBe(0)
  })

  it('lands each tier in its expected band', () => {
    expect(scoreMatch('go', 'go')).toBe(SCORE.EXACT + 1)
    expect(scoreMatch('go', 'go to chat')).toBeCloseTo(SCORE.PREFIX + 0.2, 5)   // 2/10
    expect(scoreMatch('chat', 'go to chat')).toBeCloseTo(SCORE.WORD_PREFIX + 1 / 3, 5) // word idx 2
    expect(scoreMatch('ode', 'nodes')).toBeCloseTo(SCORE.SUBSTRING + (1 - 1 / 5), 5)    // idx 1
    expect(scoreMatch('gtc', 'go to chat')).toBeCloseTo(SCORE.SUBSEQUENCE + 3 / 10, 5)
  })

  it('returns 0 for empty query or text', () => {
    expect(scoreMatch('', 'abc')).toBe(0)
    expect(scoreMatch('abc', '')).toBe(0)
  })

  it('is case-insensitive and trims', () => {
    expect(scoreMatch('  GO ', 'go')).toBe(SCORE.EXACT + 1)
  })
})

describe('scoreMatchMulti', () => {
  it('returns the best score across fields', () => {
    expect(scoreMatchMulti('chat', ['Go to Nodes', 'chat'])).toBe(SCORE.EXACT + 1)
  })
})

describe('rankItems', () => {
  const items = ['Go to Chat', 'Go to Nodes', 'Settings']

  it('returns the original array (same reference) for a blank query', () => {
    expect(rankItems('  ', items, x => x)).toBe(items)
  })

  it('filters out non-matches', () => {
    expect(rankItems('nod', items, x => x)).toEqual(['Go to Nodes'])
    expect(rankItems('zzz', items, x => x)).toEqual([])
  })

  it('ranks a shorter (higher-coverage) prefix match first', () => {
    // both start with "go"; "Go to Chat" (10 chars) outscores "Go to Nodes" (11)
    expect(rankItems('go', items, x => x)).toEqual(['Go to Chat', 'Go to Nodes'])
  })

  it('supports multi-field extraction', () => {
    const rich = [
      { label: 'Open Settings', hint: 'preferences' },
      { label: 'New Chat', hint: 'start a conversation' },
    ]
    const res = rankItems('pref', rich, it => [it.label, it.hint])
    expect(res).toHaveLength(1)
    expect(res[0].label).toBe('Open Settings')
  })
})
