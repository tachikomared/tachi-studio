// packages/core/src/tachi/__tests__/task-classify.test.ts
import { describe, it, expect } from 'vitest'
import { classifyTask } from '../task-classify.js'

describe('classifyTask', () => {
  it('classifies obvious categories', () => {
    expect(classifyTask('fix the crash on startup')).toBe('debugging')
    expect(classifyTask('add a dark mode toggle')).toBe('feature')
    expect(classifyTask('refactor the auth module')).toBe('refactor')
    expect(classifyTask('write vitest tests for the parser')).toBe('testing')
    expect(classifyTask('commit and push my changes')).toBe('git')
    expect(classifyTask('deploy to production')).toBe('build')
    expect(classifyTask('research the best charting library')).toBe('research')
    expect(classifyTask('brainstorm names for the product')).toBe('brainstorm')
  })

  it('first-match-wins fixes "add error handling" → feature, not debugging', () => {
    // "add" (feature) appears before "error" (debugging) → feature must win.
    expect(classifyTask('add error handling to the fetch call')).toBe('feature')
  })

  it('debugging wins when the error word comes first', () => {
    expect(classifyTask('error: cannot add the new column')).toBe('debugging')
  })

  it('falls back to other for keyword-less / empty text', () => {
    expect(classifyTask('the quick brown fox')).toBe('other')
    expect(classifyTask('')).toBe('other')
    expect(classifyTask('   ')).toBe('other')
    expect(classifyTask(undefined as unknown as string)).toBe('other')
  })

  it('only scans the first chunk (a huge pasted log does not dominate)', () => {
    const noise = 'x'.repeat(5000)
    expect(classifyTask('add a feature\n' + noise + '\nfix bug')).toBe('feature')
  })
})
